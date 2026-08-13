import { describe, expect, it } from 'vitest'
import { finalResultProblems } from '../src/agent/runner.js'
import type { CodexTestAgentResult, CodexTestExecutionReceipt } from '../src/agent/types.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'

function manifest(): WorkflowIntakeManifest {
  return {
    version: '1.0', kind: 'workflow-intake', workflowId: 'outcome-fixture',
    source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'a'.repeat(64) },
    targetUrls: ['https://example.test/'], requiredCapabilities: [],
    phases: [{
      id: 'case-one', title: 'Submit and verify', sourceRow: 2, risk: 'write',
      outcome: {
        action: ['Submit the form'],
        observable: ['Confirmation is visible'],
        evidence: ['interaction', 'observation'],
        cleanup: ['Remove created row'],
        failureModes: ['input', 'authentication', 'environment', 'locator_navigation', 'business_assertion', 'mutation_cleanup', 'agent_execution', 'infrastructure'],
      },
      steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] },
    }],
    embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
  }
}

function result(): CodexTestAgentResult {
  return {
    version: '1.0', workflowId: 'outcome-fixture', sourceSha256: 'a'.repeat(64), outcome: 'passed',
    summary: 'passed', startedAt: '2026-08-13T00:00:00.000Z', finishedAt: '2026-08-13T00:00:01.000Z',
    cases: [{
      caseId: 'case-one', title: 'Submit and verify', outcome: 'passed', summary: 'verified',
      executionReceiptIds: ['interaction-one'],
      evidence: [{ kind: 'observation', description: 'Confirmation is visible' }],
    }],
    mutations: [], environmentRequirements: [], blockers: [], productDefects: [], nextActions: [],
  }
}

const receipt: CodexTestExecutionReceipt = {
  id: 'interaction-one', caseId: 'case-one', tool: 'browser_click', kind: 'interaction', status: 'completed', recordedAt: '2026-08-13T00:00:00.500Z',
}

describe('Agent outcome contract validation', () => {
  it('accepts matching observation evidence and a same-case interaction receipt', () => {
    expect(finalResultProblems(result(), manifest(), [], [receipt])).toEqual([])
  })

  it('fails a false pass that has observation text but no required interaction receipt', () => {
    const candidate = result()
    candidate.cases[0]!.executionReceiptIds = []
    expect(finalResultProblems(candidate, manifest(), [], [receipt]))
      .toContain('case case-one does not satisfy its outcome interaction receipt requirement')
  })

  it('does not require an interaction when the case is blocked before execution', () => {
    const candidate = result()
    candidate.outcome = 'blocked'
    candidate.cases[0] = {
      ...candidate.cases[0]!, outcome: 'blocked', failureSource: 'input', failureKind: 'validation', executionReceiptIds: [],
    }
    candidate.blockers = ['Source expected result is incomplete']
    expect(finalResultProblems(candidate, manifest(), [], [])).not.toContain(expect.stringContaining('outcome interaction'))
  })

  it('rejects a failure mode that the outcome contract does not allow', () => {
    const constrained = manifest()
    constrained.phases[0]!.outcome = {
      ...constrained.phases[0]!.outcome!,
      failureModes: ['business_assertion'],
    }
    const candidate = result()
    candidate.outcome = 'blocked'
    candidate.blockers = ['Cleanup could not be verified']
    candidate.cases[0] = {
      ...candidate.cases[0]!,
      outcome: 'blocked',
      failureSource: 'agent_execution',
      failureKind: 'mutation',
      executionReceiptIds: ['interaction-one'],
    }
    expect(finalResultProblems(candidate, constrained, [], [receipt]))
      .toContain('case case-one failure mode mutation_cleanup is not allowed by its outcome contract')
  })

  it('accepts an allowed failure mode declared in the outcome contract', () => {
    const candidate = result()
    candidate.outcome = 'blocked'
    candidate.blockers = ['Cleanup could not be verified']
    candidate.cases[0] = {
      ...candidate.cases[0]!,
      outcome: 'blocked',
      failureSource: 'agent_execution',
      failureKind: 'mutation',
      executionReceiptIds: ['interaction-one'],
    }
    expect(finalResultProblems(candidate, manifest(), [], [receipt])).toEqual([])
  })

  it('keeps legacy outcome contracts without action/failureModes readable', () => {
    const legacy = manifest()
    legacy.phases[0]!.outcome = {
      observable: ['Confirmation is visible'],
      evidence: ['interaction', 'observation'],
      cleanup: ['Remove created row'],
    }
    expect(finalResultProblems(result(), legacy, [], [receipt])).toEqual([])
  })

  it('requires an observation-kind evidence, not merely any non-mutation evidence', () => {
    const candidate = result()
    candidate.cases[0]!.evidence = [{ kind: 'screenshot', description: 'a screenshot is not a postcondition observation' }]
    expect(finalResultProblems(candidate, manifest(), [], [receipt]))
      .toContain('case case-one does not satisfy its outcome observation evidence requirement')
  })

  it('does not reject a passed case whose outcome contract lacks action or observable text', () => {
    const sparse = manifest()
    sparse.phases[0]!.outcome = {
      observable: [],
      evidence: ['interaction', 'observation'],
      cleanup: [],
    }
    expect(finalResultProblems(result(), sparse, [], [receipt])).toEqual([])
  })
})
