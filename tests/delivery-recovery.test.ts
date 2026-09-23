import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recoverAgentEpochDeliveryResult, recoverCodexDeliveryResult } from '../src/agent/delivery-recovery.js'
import { settlementInputFromResult, settlementProblems } from '../src/agent/result-settlement.js'
import type { CodexTestAgentResult, CodexTestEnvironmentRequirement } from '../src/agent/types.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function manifest(): WorkflowIntakeManifest {
  return {
    version: '1.0',
    kind: 'workflow-intake',
    workflowId: 'fixture-workflow',
    source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'a'.repeat(64) },
    targetUrls: ['https://fixture.example.test/'],
    requiredCapabilities: [],
    phases: [
      { id: 'case-1', sourceCaseId: 'case-1', title: 'Read', sourceRow: 2, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
      { id: 'case-2', sourceCaseId: 'case-2', title: 'Write', sourceRow: 3, risk: 'write', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
    ],
    embeddedImages: [],
    supplementalImages: [],
    review: { status: 'draft', reasons: [] },
  }
}

describe('Codex delivery recovery', () => {
  it('fails closed when an interrupted workspace still contains the initialized result array', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-delivery-initial-array-'))
    directories.push(directory)
    const artifactPath = resolve(directory, 'case-results.json')
    await writeFile(artifactPath, '[]')

    const recovered = await recoverCodexDeliveryResult({
      artifactPath,
      manifest: manifest(),
      startedAt: '2026-08-03T00:00:00.000Z',
    })

    expect(recovered.result).toBeUndefined()
    expect(recovered.problems).toContain('Agent delivery artifact cases must be an array')
  })

  it('fails closed for null artifacts and invalid case entries', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-delivery-invalid-shape-'))
    directories.push(directory)
    const artifactPath = resolve(directory, 'case-results.json')
    await writeFile(artifactPath, 'null')
    await expect(recoverCodexDeliveryResult({
      artifactPath, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z',
    })).resolves.toEqual({ problems: ['Agent delivery artifact must be a JSON object'] })

    await writeFile(artifactPath, JSON.stringify({
      version: '1.0', kind: 'case-results', workflowId: 'fixture-workflow', sourceSha256: 'a'.repeat(64),
      generatedAt: '2026-08-03T00:01:00.000Z', cases: [null], mutationLedger: { state: 'terminal', pendingCount: 0, entries: [] },
    }))
    const invalidCases = await recoverCodexDeliveryResult({
      artifactPath, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z',
    })
    expect(invalidCases.problems).toContain('Agent delivery artifact cases must contain objects')
  })

  it('accepts a complete same-run artifact after structured response transport failure', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-delivery-recovery-'))
    directories.push(directory)
    await mkdir(resolve(directory, 'evidence'))
    await writeFile(resolve(directory, 'evidence', 'case-1.md'), 'observed')
    await writeFile(resolve(directory, 'test-manifest.json'), '{}')
    const artifactPath = resolve(directory, 'case-results.json')
    await writeFile(artifactPath, JSON.stringify({
      version: '1.0',
      kind: 'case-results',
      workflowId: 'fixture-workflow',
      sourceSha256: 'a'.repeat(64),
      generatedAt: '2026-08-03T00:01:00.000Z',
      cases: [
        { caseId: 'case-1', outcome: 'passed', summary: 'Observed', evidencePaths: ['evidence/case-1.md', 'test-manifest.json'] },
        { caseId: 'case-2', outcome: 'blocked', summary: 'Write was not authorized', blockers: ['allowedRisk=read'], failureSource: 'input', failureKind: 'validation', evidencePaths: [] },
      ],
      mutationLedger: { state: 'terminal', pendingCount: 0, entries: [] },
    }))

    const recovered = await recoverCodexDeliveryResult({ artifactPath, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z' })

    expect(recovered.problems).toEqual([])
    expect(recovered.result?.outcome).toBe('blocked')
    expect(recovered.result?.cases).toHaveLength(2)
    expect(recovered.result?.cases[0]).toMatchObject({ caseId: 'case-1', outcome: 'passed' })
    expect(recovered.result?.cases[1]).toMatchObject({ caseId: 'case-2', outcome: 'blocked', failureSource: 'input', failureKind: 'validation' })
    expect(recovered.result?.cases[1]?.evidence).not.toHaveLength(0)
    expect(recovered.result?.cases[0]?.evidence.map((item) => item.path)).toContain('test-manifest.json')
  })

  it('recovers the full suite only when per-epoch artifacts cover every case exactly once', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-epoch-delivery-recovery-'))
    directories.push(directory)
    await mkdir(resolve(directory, 'evidence'))
    await writeFile(resolve(directory, 'evidence', 'case-1.md'), 'one')
    await writeFile(resolve(directory, 'evidence', 'case-2.md'), 'two')
    const common = {
      version: '1.0', kind: 'case-results', workflowId: 'fixture-workflow', sourceSha256: 'a'.repeat(64),
      generatedAt: '2026-08-03T00:01:00.000Z', mutationLedger: { state: 'terminal', pendingCount: 0, entries: [] },
    }
    await writeFile(resolve(directory, 'case-results.epoch-0001.json'), JSON.stringify({
      ...common, cases: [{ caseId: 'case-1', outcome: 'passed', summary: 'Observed one' }],
    }))
    await writeFile(resolve(directory, 'case-results.epoch-0002.json'), JSON.stringify({
      ...common, cases: [{ caseId: 'case-2', outcome: 'passed', summary: 'Observed two', evidencePaths: ['evidence/case-2.md'] }],
    }))

    const recovered = await recoverAgentEpochDeliveryResult({
      workspaceDirectory: directory, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z',
    })

    expect(recovered.problems).toEqual([])
    expect(recovered.result).toMatchObject({ outcome: 'passed' })
    expect(recovered.result?.cases.map((item) => item.caseId)).toEqual(['case-1', 'case-2'])
    expect(recovered.result?.cases[0]?.evidence[0]?.path).toBe('case-results.epoch-0001.json')

    await writeFile(resolve(directory, 'case-results.epoch-0001.json'), JSON.stringify({
      ...common,
      cases: [{
        caseId: 'case-1', outcome: 'product_failed', summary: 'Observed product mismatch',
        failureSource: 'product', failureKind: 'assertion', evidencePaths: ['evidence/case-1.md'],
      }],
    }))
    await writeFile(resolve(directory, 'case-results.epoch-0002.json'), JSON.stringify({
      ...common,
      cases: [{
        caseId: 'case-2', outcome: 'blocked', summary: 'Agent could not complete the action',
        failureSource: 'agent_execution', failureKind: 'execution', evidencePaths: ['evidence/case-2.md'],
      }],
    }))
    const nonPassed = await recoverAgentEpochDeliveryResult({
      workspaceDirectory: directory, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z',
    })
    expect(nonPassed.result).toMatchObject({
      outcome: 'blocked',
      blockers: ['Agent could not complete the action'],
      productDefects: ['Observed product mismatch'],
    })

    await writeFile(resolve(directory, 'case-results.epoch-0002.json'), JSON.stringify({
      ...common, cases: [{ caseId: 'case-1', outcome: 'passed', summary: 'Duplicate', evidencePaths: ['evidence/case-1.md'] }],
    }))
    const duplicate = await recoverAgentEpochDeliveryResult({
      workspaceDirectory: directory, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z',
    })
    expect(duplicate.result).toBeUndefined()
    expect(duplicate.problems.some((problem) => /duplicate/i.test(problem))).toBe(true)
    expect(duplicate.problems.some((problem) => /missing final case result for case-2/i.test(problem))).toBe(true)
  })

  it('scopes recorded requirement rows to the epoch that owns the case', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-epoch-delivery-scoped-requirement-'))
    directories.push(directory)
    const common = {
      version: '1.0', kind: 'case-results', workflowId: 'fixture-workflow', sourceSha256: 'a'.repeat(64),
      generatedAt: '2026-08-03T00:01:00.000Z', mutationLedger: { state: 'terminal', pendingCount: 0, entries: [] },
    }
    const requirement: CodexTestEnvironmentRequirement = {
      id: 'environment-test_data-fixture', caseIds: ['case-2'], kind: 'test_data',
      origin: 'https://fixture.example.test/', condition: 'No writable test data',
      evidence: ['evidence/requirement.md'], status: 'pending', requestedAt: '2026-08-03T00:00:00.000Z',
    }
    await writeFile(resolve(directory, 'case-results.epoch-0001.json'), JSON.stringify({
      ...common, cases: [{ caseId: 'case-1', outcome: 'passed', summary: 'Observed one' }],
    }))
    await writeFile(resolve(directory, 'case-results.epoch-0002.json'), JSON.stringify({
      ...common,
      cases: [{
        caseId: 'case-2', outcome: 'blocked', summary: 'Test data unavailable', failureSource: 'environment',
        failureKind: 'environment', environmentRequirementIds: [requirement.id], evidencePaths: [],
      }],
    }))

    const recovered = await recoverAgentEpochDeliveryResult({
      workspaceDirectory: directory, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z',
      environmentRequirements: [requirement],
    })

    expect(recovered.problems).toEqual([])
    expect(recovered.result?.outcome).toBe('blocked')
    expect(recovered.result?.cases.map((item) => item.caseId)).toEqual(['case-1', 'case-2'])
    expect(recovered.result?.cases[1]).toMatchObject({
      outcome: 'blocked', failureSource: 'environment', environmentRequirementIds: [requirement.id],
    })
    // Settlement names the pending prerequisite alongside the case summary; the
    // Runner's own requirement enrichment produces the same list.
    expect(recovered.result?.blockers).toEqual(['Test data unavailable', 'No writable test data'])
  })

  it('fails closed when an epoch artifact claims a case the manifest does not define', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-epoch-delivery-unexpected-'))
    directories.push(directory)
    const common = {
      version: '1.0', kind: 'case-results', workflowId: 'fixture-workflow', sourceSha256: 'a'.repeat(64),
      generatedAt: '2026-08-03T00:01:00.000Z', mutationLedger: { state: 'terminal', pendingCount: 0, entries: [] },
    }
    await writeFile(resolve(directory, 'case-results.epoch-0001.json'), JSON.stringify({
      ...common, cases: [{ caseId: 'case-1', outcome: 'passed', summary: 'Observed one' }],
    }))
    await writeFile(resolve(directory, 'case-results.epoch-0002.json'), JSON.stringify({
      ...common, cases: [{ caseId: 'case-99', outcome: 'passed', summary: 'Not in the contract' }],
    }))

    const recovered = await recoverAgentEpochDeliveryResult({
      workspaceDirectory: directory, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z',
    })

    expect(recovered.result).toBeUndefined()
    expect(recovered.problems.some((problem) => /case-results\.epoch-0002\.json: unexpected case result for case-99/.test(problem))).toBe(true)
  })

  it('rejects stale or incomplete artifacts instead of guessing a result', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-delivery-recovery-invalid-'))
    directories.push(directory)
    const artifactPath = resolve(directory, 'case-results.json')
    await writeFile(artifactPath, JSON.stringify({
      version: '1.0',
      kind: 'case-results',
      workflowId: 'other-workflow',
      sourceSha256: 'b'.repeat(64),
      generatedAt: '2026-08-03T00:01:00.000Z',
      cases: [],
      mutationLedger: { state: 'terminal', pendingCount: 1, entries: [{}] },
    }))

    const recovered = await recoverCodexDeliveryResult({ artifactPath, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z' })

    expect(recovered.result).toBeUndefined()
    expect(recovered.problems).toEqual(expect.arrayContaining([
      expect.stringContaining('workflowId'),
      expect.stringContaining('sourceSha256'),
      expect.stringContaining('missing final case result for case-1'),
      expect.stringContaining('unresolved mutations'),
    ]))
  })

  it('rejects an unclassified delivery artifact instead of inferring a business failure source', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-delivery-recovery-unclassified-'))
    directories.push(directory)
    const artifactPath = resolve(directory, 'case-results.json')
    await writeFile(artifactPath, JSON.stringify({
      version: '1.0',
      kind: 'case-results',
      workflowId: 'fixture-workflow',
      sourceSha256: 'a'.repeat(64),
      generatedAt: '2026-08-03T00:01:00.000Z',
      cases: [
        { caseId: 'case-1', outcome: 'passed', summary: 'Observed', evidencePaths: [] },
        { caseId: 'case-2', outcome: 'blocked', summary: 'A dependency was unavailable', evidencePaths: [] },
      ],
      mutationLedger: { state: 'terminal', pendingCount: 0, entries: [] },
    }))

    const recovered = await recoverCodexDeliveryResult({ artifactPath, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z' })

    expect(recovered.result).toBeUndefined()
    expect(recovered.problems).toContain('non-passed case case-2 has no failure classification')
  })

  it('preserves an explicit infrastructure classification from the Codex artifact', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-delivery-recovery-infrastructure-'))
    directories.push(directory)
    const artifactPath = resolve(directory, 'case-results.json')
    await writeFile(artifactPath, JSON.stringify({
      version: '1.0',
      kind: 'case-results',
      workflowId: 'fixture-workflow',
      sourceSha256: 'a'.repeat(64),
      generatedAt: '2026-08-03T00:01:00.000Z',
      cases: [
        { caseId: 'case-1', outcome: 'passed', summary: 'Observed', evidencePaths: [] },
        { caseId: 'case-2', outcome: 'blocked', summary: 'Browser transport disconnected', failureSource: 'infrastructure', failureKind: 'execution', evidencePaths: [] },
      ],
      mutationLedger: { state: 'terminal', pendingCount: 0, entries: [] },
    }))

    const recovered = await recoverCodexDeliveryResult({ artifactPath, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z' })

    expect(recovered.problems).toEqual([])
    expect(recovered.result?.cases[1]).toMatchObject({ failureSource: 'infrastructure', failureKind: 'execution' })
  })

  it('rejects an evidence path that escapes the Codex workspace', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-delivery-recovery-escape-'))
    directories.push(directory)
    const artifactPath = resolve(directory, 'case-results.json')
    await writeFile(artifactPath, JSON.stringify({
      version: '1.0', kind: 'case-results', workflowId: 'fixture-workflow', sourceSha256: 'a'.repeat(64), generatedAt: '2026-08-03T00:01:00.000Z',
      cases: [
        { caseId: 'case-1', outcome: 'passed', summary: 'Observed', evidencePaths: ['../outside.md'] },
        { caseId: 'case-2', outcome: 'blocked', summary: 'No target permission', failureSource: 'environment', failureKind: 'environment', blockers: ['permission'], evidencePaths: [] },
      ],
      mutationLedger: { state: 'terminal', pendingCount: 0, entries: [] },
    }))

    const recovered = await recoverCodexDeliveryResult({ artifactPath, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z' })

    expect(recovered.result).toBeUndefined()
    expect(recovered.problems).toContain('Agent delivery artifact case case-1 references missing evidence ../outside.md')
  })
})

describe('delivery recovery on the ResultSettlement seam', () => {
  async function writeArtifact(directory: string, cases: unknown[]): Promise<string> {
    const artifactPath = resolve(directory, 'case-results.json')
    await writeFile(artifactPath, JSON.stringify({
      version: '1.0',
      kind: 'case-results',
      workflowId: 'fixture-workflow',
      sourceSha256: 'a'.repeat(64),
      generatedAt: '2026-08-03T00:01:00.000Z',
      cases,
      mutationLedger: { state: 'terminal', pendingCount: 0, entries: [] },
    }))
    return artifactPath
  }

  function mirroredResult(): CodexTestAgentResult {
    return {
      version: '1.0',
      workflowId: 'fixture-workflow',
      sourceSha256: 'a'.repeat(64),
      outcome: 'blocked',
      summary: 'mirrored claim',
      startedAt: '2026-08-03T00:00:00.000Z',
      finishedAt: '2026-08-03T00:01:00.000Z',
      cases: [
        { caseId: 'case-1', title: 'Read', outcome: 'passed', summary: 'Observed', evidence: [{ kind: 'observation', path: 'case-results.json', description: 'observed' }] },
        { caseId: 'case-2', title: 'Write', outcome: 'blocked', summary: 'Write was not authorized', evidence: [{ kind: 'observation', path: 'case-results.json', description: 'observed' }] },
      ],
      mutations: [],
      environmentRequirements: [],
      blockers: ['Write was not authorized'],
      productDefects: [],
      nextActions: [],
    }
  }

  it('gives the same verdict as the final settlement for a claim the seam rejects', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-delivery-seam-reject-'))
    directories.push(directory)
    const artifactPath = await writeArtifact(directory, [
      { caseId: 'case-1', outcome: 'passed', summary: 'Observed', evidencePaths: [] },
      { caseId: 'case-2', outcome: 'blocked', summary: 'Write was not authorized', evidencePaths: [] },
    ])

    const recovered = await recoverCodexDeliveryResult({ artifactPath, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z' })

    expect(recovered.result).toBeUndefined()
    expect(recovered.problems).toEqual(['non-passed case case-2 has no failure classification'])
    // The same claim read back from a canonical Result is judged by the one
    // settlement seam with the same problem, so neither path accepts what the
    // other blocks.
    expect(settlementProblems(settlementInputFromResult(mirroredResult(), { manifest: manifest() }))).toEqual(recovered.problems)
  })

  it('accepts a delivery the final settlement also accepts, without repeating its checks', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-delivery-seam-accept-'))
    directories.push(directory)
    const artifactPath = await writeArtifact(directory, [
      { caseId: 'case-1', outcome: 'passed', summary: 'Observed', evidencePaths: [] },
      { caseId: 'case-2', outcome: 'blocked', summary: 'Write was not authorized', failureSource: 'input', failureKind: 'validation', evidencePaths: [] },
    ])

    const recovered = await recoverCodexDeliveryResult({ artifactPath, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z' })

    expect(recovered.problems).toEqual([])
    expect(settlementProblems(settlementInputFromResult(recovered.result!, { manifest: manifest() }))).toEqual([])
  })

  it('reconciles an environment-blocked claim against the recorded requirement rows', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-delivery-seam-requirement-'))
    directories.push(directory)
    const artifactPath = await writeArtifact(directory, [
      { caseId: 'case-1', outcome: 'passed', summary: 'Observed', evidencePaths: [] },
      {
        caseId: 'case-2', outcome: 'blocked', summary: 'No target permission', failureSource: 'environment', failureKind: 'environment',
        environmentRequirementIds: ['environment-test_data-fixture'], evidencePaths: [],
      },
    ])
    const requirement: CodexTestEnvironmentRequirement = {
      id: 'environment-test_data-fixture',
      caseIds: ['case-2'],
      kind: 'test_data',
      origin: 'https://fixture.example.test/',
      condition: 'No writable test data',
      evidence: ['evidence/requirement.md'],
      status: 'pending',
      requestedAt: '2026-08-03T00:00:00.000Z',
    }

    const unreconciled = await recoverCodexDeliveryResult({ artifactPath, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z' })
    expect(unreconciled.result).toBeUndefined()
    expect(unreconciled.problems).toEqual(['environment-blocked case case-2 references unknown environment requirement environment-test_data-fixture'])

    const reconciled = await recoverCodexDeliveryResult({
      artifactPath, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z', environmentRequirements: [requirement],
    })
    expect(reconciled.problems).toEqual([])
    expect(reconciled.result?.cases[1]).toMatchObject({
      caseId: 'case-2', outcome: 'blocked', failureSource: 'environment', failureKind: 'environment',
      environmentRequirementIds: ['environment-test_data-fixture'],
    })
  })

  it('blocks the result when a transport problem survives a settled claim set', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-delivery-seam-transport-'))
    directories.push(directory)
    // An outcome value outside the domain is a transport failure the seam cannot
    // judge: the claims still settle, but the artifact must not produce a result.
    const artifactPath = await writeArtifact(directory, [
      { caseId: 'case-1', outcome: 'passed', summary: 'Observed', evidencePaths: [] },
      {
        caseId: 'case-2', outcome: 'retried', summary: 'Retried after a transport failure',
        failureSource: 'agent_execution', failureKind: 'execution', evidencePaths: [],
      },
    ])

    const recovered = await recoverCodexDeliveryResult({ artifactPath, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z' })

    expect(recovered.result).toBeUndefined()
    expect(recovered.problems).toContain('Agent delivery artifact case case-2 has an invalid outcome')
  })
})
