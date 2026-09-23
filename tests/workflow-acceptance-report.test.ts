import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { finalResultProblems } from '../src/agent/runner.js'
import { acceptanceRunContractProblems } from '../src/cli/workflow-acceptance-report.js'
import { redactReportValue } from '../src/workflow/report-redact.js'
import { buildWorkflowAcceptanceReport, renderWorkflowAcceptanceHtml } from '../src/workflow/acceptance-report.js'
import type { CodexTestAgentResult } from '../src/agent/types.js'
import type { WorkflowAcceptanceEvidence, WorkflowIntakeManifest } from '../src/workflow/types.js'

const workflow: WorkflowIntakeManifest = {
  version: '1.0',
  kind: 'workflow-intake',
  workflowId: 'flow-1',
  source: { format: 'xlsx', fileName: 'flow.xlsx', sheetName: 'Flow', sha256: 'a'.repeat(64) },
  targetUrls: ['https://example.test/'],
  requiredCapabilities: ['multiOrigin'],
  phases: [],
  embeddedImages: [],
  supplementalImages: [],
  review: { status: 'draft', reasons: [] },
}

const evidence: WorkflowAcceptanceEvidence = {
  version: '1.0',
  workflowId: 'flow-1',
  sourceSha256: 'a'.repeat(64),
  mode: 'canary',
  startedAt: '2026-07-28T00:00:00.000Z',
  finishedAt: '2026-07-28T00:01:00.000Z',
  accountRef: 'workflow.accounts[0]',
  businessCanaryStatus: 'passed',
  productAcceptanceStatus: 'blocked',
  phases: [{
    phaseId: 'phase-1',
    title: '<script>phase</script>',
    sourceRefs: ['Flow row 2'],
    status: 'passed',
    assertions: [{ description: 'ended', passed: true, evidence: 'status=ended' }],
    observations: [],
  }],
  finalState: {
    activeChargingOrders: 0,
    activeOccupancyOrders: 0,
    freshContextReturnedToLogin: true,
    simulatorConnected: true,
    notes: [],
  },
  productGaps: ['executor missing'],
}

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('workflow acceptance report', () => {
  it('checks intake integrity and summarizes evidence', () => {
    const report = buildWorkflowAcceptanceReport(workflow, evidence)
    expect(report.summary).toMatchObject({ phases: 1, passed: 1, assertions: 1, assertionsPassed: 1 })
    expect(() => buildWorkflowAcceptanceReport(workflow, { ...evidence, sourceSha256: 'b'.repeat(64) })).toThrow(/source hash/i)
  })

  it('escapes evidence in the static HTML report', () => {
    const html = renderWorkflowAcceptanceHtml(buildWorkflowAcceptanceReport(workflow, evidence))
    expect(html).toContain('&lt;script&gt;phase&lt;/script&gt;')
    expect(html).not.toContain('<script>phase</script>')
    expect(html).toContain('产品验收阻断项')
  })

  it('redacts known vault values and sensitive free text before report serialization', () => {
    const report = buildWorkflowAcceptanceReport(workflow, {
      ...evidence,
      accountRef: 'account=private-account',
      phases: [{
        ...evidence.phases[0]!,
        assertions: [{ description: 'ended', passed: true, evidence: 'token: private-token +6590000001' }],
        observations: ['password: private-password'],
      }],
      finalState: { ...evidence.finalState, notes: ['private-token'] },
    })
    const redacted = redactReportValue(report, {
      AUTO_TEST_SECRET_ACCOUNT: 'private-account',
      AUTO_TEST_SECRET_TOKEN: 'private-token',
      AUTO_TEST_SECRET_PASSWORD: 'private-password',
    })
    const serialized = JSON.stringify(redacted)

    expect(serialized).not.toContain('private-account')
    expect(serialized).not.toContain('private-token')
    expect(serialized).not.toContain('private-password')
    expect(serialized).not.toContain('+6590000001')
  })

  it('suppresses credential-shaped values that no vault secret covers', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl'
    const report = buildWorkflowAcceptanceReport(workflow, {
      ...evidence,
      phases: [{
        ...evidence.phases[0]!,
        assertions: [{
          description: 'ended',
          passed: true,
          evidence: `Authorization: Bearer ${jwt} | refresh_token=refresh-value-123 | cookie=session=abc123`,
        }],
      }],
    })
    const serialized = JSON.stringify(redactReportValue(report, {}))

    expect(serialized).not.toContain(jwt)
    expect(serialized).not.toContain('refresh-value-123')
    expect(serialized).not.toContain('abc123')
  })

  it('keeps the non-credential evidence that follows a credential header', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl'
    const report = buildWorkflowAcceptanceReport(workflow, {
      ...evidence,
      phases: [{
        ...evidence.phases[0]!,
        assertions: [{
          description: 'ended',
          passed: true,
          evidence: `Authorization: Bearer ${jwt} | status=200 | assertion=passed`,
        }],
      }],
    })
    const serialized = JSON.stringify(redactReportValue(report, {}))

    expect(serialized).not.toContain(jwt)
    expect(serialized).toContain('status=200')
    expect(serialized).toContain('assertion=passed')
  })

  it('does not truncate a credential value that itself contains a pipe', () => {
    const report = buildWorkflowAcceptanceReport(workflow, {
      ...evidence,
      phases: [{
        ...evidence.phases[0]!,
        assertions: [{ description: 'ended', passed: true, evidence: 'cookie: session=abc|secret-tail-value' }],
      }],
    })
    const serialized = JSON.stringify(redactReportValue(report, {}))

    expect(serialized).not.toContain('secret-tail-value')
  })

  it('accepts over-redacting an unspaced separator rather than truncating a credential', () => {
    // Pins the safe direction of the trade-off documented in redactCredentialValues: an unspaced
    // separator loses the trailing evidence, which is recoverable; the opposite choice would leak.
    const report = buildWorkflowAcceptanceReport(workflow, {
      ...evidence,
      phases: [{
        ...evidence.phases[0]!,
        assertions: [{ description: 'ended', passed: true, evidence: 'Authorization: Basic abc123|status=200' }],
      }],
    })
    const serialized = JSON.stringify(redactReportValue(report, {}))

    expect(serialized).not.toContain('abc123')
    expect(serialized).not.toContain('status=200')
  })
})

const runSha256 = 'c'.repeat(64)

function runManifest(): WorkflowIntakeManifest {
  return {
    version: '1.0',
    kind: 'workflow-intake',
    workflowId: 'flow-1',
    source: { format: 'xlsx', fileName: 'flow.xlsx', sheetName: 'Flow', sha256: runSha256 },
    targetUrls: ['https://example.test/'],
    requiredCapabilities: [],
    phases: [{
      id: 'phase-1', sourceCaseId: 'phase-1', title: 'Charge', sourceRow: 2, risk: 'write',
      steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] },
    }],
    embeddedImages: [],
    supplementalImages: [],
    review: { status: 'draft', reasons: [] },
  }
}

function runResult(outcome: 'passed' | 'product_failed'): CodexTestAgentResult {
  return {
    version: '1.0',
    workflowId: 'flow-1',
    sourceSha256: runSha256,
    outcome,
    summary: 'fixture',
    startedAt: '2026-07-28T00:00:00.000Z',
    finishedAt: '2026-07-28T00:01:00.000Z',
    cases: [{
      caseId: 'phase-1',
      title: 'Charge',
      outcome,
      summary: 'fixture',
      // A product-failed case claiming an environment source is the contract
      // violation the settlement seam is expected to catch, not the report.
      ...(outcome === 'product_failed' ? { failureSource: 'environment' as const, failureKind: 'environment' as const } : {}),
      evidence: [{ kind: 'observation', description: 'fixture evidence', path: 'evidence/fixture.txt' }],
    }],
    mutations: [],
    environmentRequirements: [],
    blockers: [],
    productDefects: outcome === 'product_failed' ? ['fixture defect'] : [],
    nextActions: [],
  }
}

async function makeRun(root: string, result: CodexTestAgentResult): Promise<string> {
  const directory = resolve(root, 'run')
  await mkdir(resolve(directory, '.agent-private'), { recursive: true })
  await mkdir(resolve(directory, 'agent-workspace'), { recursive: true })
  await writeFile(resolve(directory, 'agent-workspace', 'test-manifest.json'), JSON.stringify(runManifest()))
  await writeFile(resolve(directory, 'codex-agent.result.json'), JSON.stringify(result))
  await writeFile(resolve(directory, '.agent-private', 'environment-requirements.json'), '[]')
  await writeFile(resolve(directory, 'agent-workspace', 'execution-receipts.json'), '[]')
  return directory
}

describe('workflow acceptance report result contract', () => {
  it("quotes the Result settlement seam's own problem list for the run the acceptance names", async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'auto-test-acceptance-contract-'))
    directories.push(root)
    const claim = runResult('product_failed')
    const runDirectory = await makeRun(root, claim)

    const problems = await acceptanceRunContractProblems(runDirectory)
    expect(problems).toEqual(finalResultProblems(claim, runManifest()))
    expect(problems).toContain('product-failed case phase-1 is not classified as product-sourced')

    const report = buildWorkflowAcceptanceReport(workflow, { ...evidence, runDirectory }, problems)
    expect(report.contractProblems).toEqual(finalResultProblems(claim, runManifest()))
  })

  it('reports no contract problems for a run that settled clean', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'auto-test-acceptance-clean-'))
    directories.push(root)
    const claim = runResult('passed')
    const runDirectory = await makeRun(root, claim)

    expect(await acceptanceRunContractProblems(runDirectory)).toEqual([])
    const report = buildWorkflowAcceptanceReport(workflow, { ...evidence, runDirectory }, [])
    expect(report.contractProblems).toEqual([])
    expect(renderWorkflowAcceptanceHtml(report)).not.toContain('结果合同问题')
  })

  it('fails fast when the acceptance names a run whose settled artifacts cannot be read', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'auto-test-acceptance-missing-'))
    directories.push(root)
    await expect(acceptanceRunContractProblems(resolve(root, 'absent-run'))).rejects.toThrow(/无法读取/)
  })

  it('escapes settlement problems in the static HTML report', () => {
    const report = buildWorkflowAcceptanceReport(workflow, evidence, ['case <script>phase</script> has no execution evidence'])
    const html = renderWorkflowAcceptanceHtml(report)
    expect(html).toContain('结果合同问题')
    expect(html).toContain('&lt;script&gt;phase&lt;/script&gt;')
    expect(html).not.toContain('<script>phase</script>')
  })

  it('keeps settlement problems under the report redaction policy', () => {
    const report = buildWorkflowAcceptanceReport(workflow, evidence, ['case phase-1 blocked: private-token unavailable'])
    const serialized = JSON.stringify(redactReportValue(report, { AUTO_TEST_SECRET_TOKEN: 'private-token' }))

    expect(serialized).not.toContain('private-token')
    expect(serialized).toContain('<redacted>')
  })
})
