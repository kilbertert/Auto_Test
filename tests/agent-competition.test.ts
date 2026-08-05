import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { compareAgentRuns } from '../src/agent/competition.js'
import type { CodexTestAgentResult, CodexTestAgentState } from '../src/agent/types.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function result(hostOutcome: 'passed' | 'product_failed' | 'blocked' = 'passed'): CodexTestAgentResult {
  return {
    version: '1.0', workflowId: 'competition-fixture', sourceSha256: 'b'.repeat(64), outcome: hostOutcome,
    summary: 'fixture', startedAt: '2026-08-05T00:00:00.000Z', finishedAt: '2026-08-05T00:00:01.000Z',
    cases: [{ caseId: 'case-one', title: 'fixture', outcome: hostOutcome, summary: hostOutcome, ...(hostOutcome !== 'passed' ? { failureSource: hostOutcome === 'product_failed' ? 'product' as const : 'agent_execution' as const, failureKind: 'execution' as const } : {}), evidence: [{ kind: 'observation', description: 'fixture evidence' }] }],
    mutations: [], environmentRequirements: [], blockers: hostOutcome === 'blocked' ? ['blocked'] : [], productDefects: hostOutcome === 'product_failed' ? ['defect'] : [], nextActions: [],
  }
}

async function makeRun(root: string, hostId: string, runResult: CodexTestAgentResult): Promise<string> {
  const directory = resolve(root, hostId)
  await mkdir(resolve(directory, '.agent-private'), { recursive: true })
  await mkdir(resolve(directory, 'agent-workspace'), { recursive: true })
  const state: CodexTestAgentState = {
    version: '2.0', status: 'completed', stage: 'completed', workflowId: runResult.workflowId, sourceSha256: runResult.sourceSha256,
    agentHost: hostId, startedAt: runResult.startedAt, updatedAt: runResult.finishedAt, finishedAt: runResult.finishedAt,
    threadGeneration: 1, completedCaseIds: ['case-one'], outcome: runResult.outcome,
    resultWorkbookPath: resolve(directory, `${hostId}-result.xlsx`),
  }
  await writeFile(resolve(directory, 'agent-host-selection.json'), JSON.stringify({
    id: hostId, displayName: hostId,
    capabilities: { workspaceIsolation: hostId === 'codex' ? 'enforced' : 'prompt_only' },
    platform: 'fixture', arch: 'fixture', packageVersion: 'fixture', commit: 'fixture',
  }))
  await writeFile(resolve(directory, 'environment-selection.json'), JSON.stringify({
    profileId: 'fixture-profile', origins: ['https://fixture.example.test'],
    policy: { allowWrite: true, allowDestructive: true },
    authenticatedOrigins: ['https://fixture.example.test'], testDataAccess: 'direct',
    testDataSha256: 'd'.repeat(64),
  }))
  await writeFile(resolve(directory, 'agent-workspace', 'test-manifest.json'), JSON.stringify({
    version: '1.0', kind: 'workflow-intake', workflowId: runResult.workflowId,
    source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: runResult.sourceSha256 },
    phases: [{ id: 'case-one', title: 'fixture', sourceRow: 2 }],
  }))
  const briefSha256 = 'a'.repeat(64)
  const imageSha256s: string[] = []
  const bundleSha256 = createHash('sha256')
    .update(JSON.stringify({ briefSha256, imageSha256s }))
    .digest('hex')
  await writeFile(resolve(directory, 'input-bundle.json'), JSON.stringify({ briefSha256, imageSha256s, bundleSha256 }))
  await writeFile(resolve(directory, 'codex-agent.state.json'), JSON.stringify(state))
  await writeFile(resolve(directory, 'codex-agent.result.json'), JSON.stringify(runResult))
  await writeFile(resolve(directory, `${hostId}-result.xlsx`), 'fixture workbook')
  await writeFile(resolve(directory, '.agent-private', 'mutation-ledger.json'), '[]')
  await writeFile(resolve(directory, 'agent-workspace', 'execution-receipts.json'), '[]')
  return directory
}

describe('AgentHost competition contract', () => {
  it('compares equivalent Codex and OMP deliveries without inventing a winner', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'auto-test-competition-'))
    directories.push(root)
    const expected = result()
    const codex = await makeRun(root, 'codex', expected)
    const omp = await makeRun(root, 'omp', expected)
    const report = await compareAgentRuns({ runDirectories: [codex, omp] })
    expect(report.contractStatus).toBe('valid')
    expect(report.verdict).toBe('equivalent')
    expect(report.caseDifferences).toHaveLength(0)
  })

  it('reports per-case disagreement and can score an explicit fixture oracle', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'auto-test-competition-oracle-'))
    directories.push(root)
    const codex = await makeRun(root, 'codex', result('passed'))
    const omp = await makeRun(root, 'omp', result('product_failed'))
    const report = await compareAgentRuns({
      runDirectories: [codex, omp],
      oracle: { version: '1.0', workflowId: 'competition-fixture', sourceSha256: 'b'.repeat(64), cases: [{ caseId: 'case-one', outcome: 'passed' }] },
    })
    expect(report.verdict).toBe('oracle_winner')
    expect(report.winnerHostId).toBe('codex')
    expect(report.caseDifferences).toHaveLength(1)
  })

  it('rejects candidates from different immutable test contracts', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'auto-test-competition-invalid-'))
    directories.push(root)
    const codex = await makeRun(root, 'codex', result())
    const other = result()
    other.sourceSha256 = 'c'.repeat(64)
    const omp = await makeRun(root, 'omp', other)
    const report = await compareAgentRuns({ runDirectories: [codex, omp] })
    expect(report.contractStatus).toBe('invalid')
    expect(report.verdict).toBe('invalid')
    expect(report.contractProblems.some((problem) => problem.includes('sourceSha256'))).toBe(true)
  })

  it('rejects candidates whose frozen manifests differ beyond source identity', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'auto-test-competition-manifest-'))
    directories.push(root)
    const expected = result()
    const codex = await makeRun(root, 'codex', expected)
    const omp = await makeRun(root, 'omp', expected)
    const manifestPath = resolve(omp, 'agent-workspace', 'test-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.targetUrls = ['https://different.example.test/']
    await writeFile(manifestPath, JSON.stringify(manifest))
    const report = await compareAgentRuns({ runDirectories: [codex, omp] })
    expect(report.contractStatus).toBe('invalid')
    expect(report.contractProblems.some((problem) => problem.includes('immutable Manifest'))).toBe(true)
  })

  it('rejects candidates with different environment or risk contracts', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'auto-test-competition-environment-'))
    directories.push(root)
    const expected = result()
    const codex = await makeRun(root, 'codex', expected)
    const omp = await makeRun(root, 'omp', expected)
    const environmentPath = resolve(omp, 'environment-selection.json')
    const environment = JSON.parse(await readFile(environmentPath, 'utf8')) as Record<string, unknown>
    environment.policy = { allowWrite: false, allowDestructive: false }
    await writeFile(environmentPath, JSON.stringify(environment))
    const report = await compareAgentRuns({ runDirectories: [codex, omp] })
    expect(report.contractStatus).toBe('invalid')
    expect(report.contractProblems.some((problem) => problem.includes('environment Profile/权限合同不一致'))).toBe(true)
  })

  it('rejects candidates with different run-scoped test data identities', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'auto-test-competition-test-data-'))
    directories.push(root)
    const expected = result()
    const codex = await makeRun(root, 'codex', expected)
    const omp = await makeRun(root, 'omp', expected)
    const environmentPath = resolve(omp, 'environment-selection.json')
    const environment = JSON.parse(await readFile(environmentPath, 'utf8')) as Record<string, unknown>
    environment.testDataSha256 = 'e'.repeat(64)
    await writeFile(environmentPath, JSON.stringify(environment))
    const report = await compareAgentRuns({ runDirectories: [codex, omp] })
    expect(report.contractStatus).toBe('invalid')
    expect(report.contractProblems.some((problem) => problem.includes('environment Profile/权限合同不一致'))).toBe(true)
  })

  it('rejects duplicate hosts and an oracle that is not bound to the input contract', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'auto-test-competition-identity-'))
    directories.push(root)
    const expected = result()
    const first = await makeRun(root, 'codex', expected)
    const second = await makeRun(root, 'codex', expected)
    const report = await compareAgentRuns({
      runDirectories: [first, second],
      oracle: {
        version: '1.0',
        workflowId: expected.workflowId,
        sourceSha256: 'c'.repeat(64),
        cases: [{ caseId: 'case-one', outcome: 'passed' }],
      },
    })
    expect(report.contractStatus).toBe('invalid')
    expect(report.contractProblems.some((problem) => problem.includes('重复比较同一个 AgentHost'))).toBe(true)
    expect(report.contractProblems.some((problem) => problem.includes('oracle sourceSha256'))).toBe(true)
  })

  it('rejects a case result that cites a receipt which was never recorded', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'auto-test-competition-receipt-'))
    directories.push(root)
    const expected = result()
    const codex = await makeRun(root, 'codex', expected)
    const omp = await makeRun(root, 'omp', expected)
    const ompResultPath = resolve(omp, 'codex-agent.result.json')
    const ompResult = JSON.parse(await readFile(ompResultPath, 'utf8')) as CodexTestAgentResult
    ompResult.cases[0]!.executionReceiptIds = ['missing-receipt']
    await writeFile(ompResultPath, JSON.stringify(ompResult))
    const report = await compareAgentRuns({ runDirectories: [codex, omp] })
    expect(report.contractStatus).toBe('invalid')
    expect(report.contractProblems.some((problem) => problem.includes('未知执行回执'))).toBe(true)
  })

  it('returns an invalid contract instead of crashing on a malformed result artifact', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'auto-test-competition-malformed-'))
    directories.push(root)
    const expected = result()
    const codex = await makeRun(root, 'codex', expected)
    const omp = await makeRun(root, 'omp', expected)
    const ompResultPath = resolve(omp, 'codex-agent.result.json')
    const ompResult = JSON.parse(await readFile(ompResultPath, 'utf8')) as Record<string, unknown>
    delete ompResult.cases
    await writeFile(ompResultPath, JSON.stringify(ompResult))
    const report = await compareAgentRuns({ runDirectories: [codex, omp] })
    expect(report.contractStatus).toBe('invalid')
    expect(report.contractProblems.some((problem) => problem.includes('缺少 cases 数组'))).toBe(true)
  })

  it('rejects a run that does not carry the immutable Excel/sidecar input bundle', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'auto-test-competition-input-bundle-missing-'))
    directories.push(root)
    const expected = result()
    const codex = await makeRun(root, 'codex', expected)
    const omp = await makeRun(root, 'omp', expected)
    await rm(resolve(omp, 'input-bundle.json'))
    const report = await compareAgentRuns({ runDirectories: [codex, omp] })
    expect(report.contractStatus).toBe('invalid')
    expect(report.contractProblems.some((problem) => problem.includes('缺少 immutable input-bundle.json'))).toBe(true)
  })

  it('rejects candidates whose sidecar/image bundle identity differs', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'auto-test-competition-input-bundle-different-'))
    directories.push(root)
    const expected = result()
    const codex = await makeRun(root, 'codex', expected)
    const omp = await makeRun(root, 'omp', expected)
    const bundlePath = resolve(omp, 'input-bundle.json')
    const bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as Record<string, unknown>
    bundle.briefSha256 = 'c'.repeat(64)
    bundle.bundleSha256 = createHash('sha256')
      .update(JSON.stringify({ briefSha256: bundle.briefSha256, imageSha256s: bundle.imageSha256s }))
      .digest('hex')
    await writeFile(bundlePath, JSON.stringify(bundle))
    const report = await compareAgentRuns({ runDirectories: [codex, omp] })
    expect(report.contractStatus).toBe('invalid')
    expect(report.contractProblems.some((problem) => problem.includes('immutable input bundle 不一致'))).toBe(true)
  })

  it('returns an invalid contract instead of throwing when run metadata is missing or corrupt', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'auto-test-competition-metadata-'))
    directories.push(root)
    const expected = result()
    const codex = await makeRun(root, 'codex', expected)
    const omp = await makeRun(root, 'omp', expected)
    await rm(resolve(omp, 'agent-host-selection.json'))
    await writeFile(resolve(omp, 'codex-agent.state.json'), '{broken json')
    await rm(resolve(omp, '.agent-private', 'mutation-ledger.json'))
    await writeFile(resolve(omp, 'agent-workspace', 'test-manifest.json'), JSON.stringify({ phases: 'not-an-array' }))
    const report = await compareAgentRuns({ runDirectories: [codex, omp] })
    expect(report.contractStatus).toBe('invalid')
    expect(report.verdict).toBe('invalid')
    expect(report.contractProblems.some((problem) => problem.includes('缺少 agent-host-selection.json'))).toBe(true)
    expect(report.contractProblems.some((problem) => problem.includes('codex-agent.state.json 无法读取'))).toBe(true)
    expect(report.contractProblems.some((problem) => problem.includes('缺少 .agent-private/mutation-ledger.json'))).toBe(true)
    expect(report.contractProblems.some((problem) => problem.includes('test-manifest.json 结构无效'))).toBe(true)
  })

  it('returns an invalid contract for a missing run directory', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'auto-test-competition-missing-run-'))
    directories.push(root)
    const expected = result()
    const codex = await makeRun(root, 'codex', expected)
    const missing = resolve(root, 'does-not-exist')
    const report = await compareAgentRuns({ runDirectories: [codex, missing] })
    expect(report.contractStatus).toBe('invalid')
    expect(report.verdict).toBe('invalid')
    expect(report.contractProblems.some((problem) => problem.includes('缺少 structured AgentTest result artifact'))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('rejects evidence symlinks that escape the run directory', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'auto-test-competition-evidence-link-'))
    directories.push(root)
    const expected = result()
    const codex = await makeRun(root, 'codex', expected)
    const omp = await makeRun(root, 'omp', expected)
    const outside = resolve(root, 'outside-evidence.txt')
    await writeFile(outside, 'outside')
    await symlink(outside, resolve(omp, 'linked-evidence.txt'))
    const resultPath = resolve(omp, 'codex-agent.result.json')
    const ompResult = JSON.parse(await readFile(resultPath, 'utf8')) as CodexTestAgentResult
    ompResult.cases[0]!.evidence = [{ kind: 'observation', path: 'linked-evidence.txt', description: 'linked evidence' }]
    await writeFile(resultPath, JSON.stringify(ompResult))
    const report = await compareAgentRuns({ runDirectories: [codex, omp] })
    expect(report.contractStatus).toBe('invalid')
    expect(report.contractProblems.some((problem) => problem.includes('不存在或越界证据'))).toBe(true)
  })
})
