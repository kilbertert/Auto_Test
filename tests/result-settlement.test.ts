import { describe, expect, it } from 'vitest'
import {
  settlementClaimsFromDelivery,
  settlementClaimsFromResult,
  settlementProblems,
  settleResult,
  type ResultSettlementInput,
  type SettlementCaseClaim,
} from '../src/agent/result-settlement.js'
import type {
  CodexTestAgentResult,
  CodexTestEnvironmentRequirement,
  CodexTestExecutionReceipt,
  CodexTestMutationLedgerEntry,
} from '../src/agent/types.js'
import type { WorkflowFailureMode, WorkflowIntakeManifest, WorkflowPhaseDraft, WorkflowOutcomeContract } from '../src/workflow/types.js'

const SOURCE_SHA256 = 'a'.repeat(64)

const ALL_FAILURE_MODES: WorkflowFailureMode[] = [
  'input', 'authentication', 'environment', 'locator_navigation', 'business_assertion', 'mutation_cleanup', 'agent_execution', 'infrastructure',
]

function phase(id: string, outcome?: WorkflowOutcomeContract): WorkflowPhaseDraft {
  return {
    id, title: `Title ${id}`, sourceRow: 2, risk: 'write',
    ...(outcome ? { outcome } : {}),
    steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] },
  }
}

/** The default contract only requires observation evidence, so receipts stay opt-in per test. */
function outcomeContract(evidence: WorkflowOutcomeContract['evidence'], failureModes?: WorkflowFailureMode[]): WorkflowOutcomeContract {
  return {
    observable: ['Confirmation is visible'],
    evidence,
    cleanup: ['Remove created row'],
    ...(failureModes ? { failureModes } : {}),
  }
}

function manifest(phases: WorkflowPhaseDraft[] = [phase('case-one', outcomeContract(['observation'], ALL_FAILURE_MODES))]): WorkflowIntakeManifest {
  return {
    version: '1.0', kind: 'workflow-intake', workflowId: 'settlement-fixture',
    source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: SOURCE_SHA256 },
    targetUrls: ['https://example.test/'], requiredCapabilities: [], phases,
    embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
  }
}

function claim(overrides: Partial<SettlementCaseClaim> = {}): SettlementCaseClaim {
  return {
    caseId: 'case-one',
    title: 'Title case-one',
    outcome: 'passed',
    summary: 'verified',
    evidence: [{ kind: 'observation', description: 'Confirmation is visible' }],
    ...overrides,
  }
}

function input(overrides: Partial<ResultSettlementInput> = {}): ResultSettlementInput {
  return {
    manifest: manifest(),
    claims: [claim()],
    workflowId: 'settlement-fixture',
    sourceSha256: SOURCE_SHA256,
    startedAt: '2026-08-13T00:00:00.000Z',
    finishedAt: '2026-08-13T00:00:01.000Z',
    outcome: 'passed',
    summary: 'settled',
    blockers: [],
    productDefects: [],
    nextActions: [],
    ...overrides,
  }
}

type ResultCase = CodexTestAgentResult['cases'][number]

function resultCase(overrides: Partial<ResultCase> = {}): ResultCase {
  return { caseId: 'case-one', title: 'Title case-one', outcome: 'passed', summary: 'verified', evidence: [{ kind: 'observation', description: 'Confirmation is visible' }], ...overrides }
}

function receipt(overrides: Partial<CodexTestExecutionReceipt> = {}): CodexTestExecutionReceipt {
  return { id: 'interaction-one', caseId: 'case-one', tool: 'browser_click', kind: 'interaction', status: 'completed', recordedAt: '2026-08-13T00:00:00.500Z', ...overrides }
}

function requirement(overrides: Partial<CodexTestEnvironmentRequirement> = {}): CodexTestEnvironmentRequirement {
  return {
    id: 'env-1', caseIds: ['case-one'], kind: 'permission', origin: 'https://example.test/', condition: 'Target write permission',
    evidence: ['evidence/env-1.md'], status: 'pending', requestedAt: '2026-08-13T00:00:00.000Z', ...overrides,
  }
}

function ledgerEntry(overrides: Partial<CodexTestMutationLedgerEntry> = {}): CodexTestMutationLedgerEntry {
  return {
    id: 'mutation-1', caseId: 'case-one', description: 'Created a row', risk: 'write', status: 'accepted',
    createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.500Z', evidence: ['evidence/mutation-1.png'],
    ...overrides,
  }
}

describe('ResultSettlement seam', () => {
  it('settles a complete claim set into a canonical result with no problems', () => {
    const settlement = settleResult(input({
      claims: [claim({ executionReceiptIds: ['interaction-one'] })],
      executionReceipts: [receipt()],
    }))

    expect(settlement.problems).toEqual([])
    expect(settlement.result).toEqual({
      version: '1.0',
      workflowId: 'settlement-fixture',
      sourceSha256: SOURCE_SHA256,
      outcome: 'passed',
      summary: 'settled',
      startedAt: '2026-08-13T00:00:00.000Z',
      finishedAt: '2026-08-13T00:00:01.000Z',
      cases: [resultCase({ executionReceiptIds: ['interaction-one'] })],
      mutations: [],
      environmentRequirements: [],
      blockers: [],
      productDefects: [],
      nextActions: [],
    })
  })

  it('fails closed and never returns a result beside a non-empty problem list', () => {
    const settlement = settleResult(input({ outcome: 'blocked', claims: [claim()] }))

    expect(settlement.result).toBeUndefined()
    expect(settlement.problems).toEqual([
      'top-level outcome must be passed',
      'blocked result has no blocker',
    ])
  })

  it('rejects identity drift from the immutable test contract', () => {
    expect(settlementProblems(input({ workflowId: 'other-workflow', sourceSha256: 'b'.repeat(64) }))).toEqual([
      'workflowId does not match the immutable test contract',
      'sourceSha256 does not match the original test material',
    ])
  })

  it('rejects duplicate, missing, and unexpected case claims', () => {
    const phases = [phase('case-one'), phase('case-two')]
    expect(settlementProblems(input({
      manifest: manifest(phases),
      claims: [claim(), claim(), { ...claim(), caseId: 'case-three' }],
    }))).toEqual([
      'duplicate case results are not allowed',
      'missing final case result for case-two',
      'unexpected case result for case-three',
    ])
  })
})

describe('failure classification decision table', () => {
  it('rejects a passed claim that carries a failure classification', () => {
    expect(settlementProblems(input({
      claims: [claim({ failureSource: 'product', failureKind: 'assertion' })],
    }))).toContain('passed case case-one contains a failure classification')
  })

  it('rejects a non-passed claim without an explicit failure classification', () => {
    expect(settlementProblems(input({
      outcome: 'blocked', blockers: ['Source expected result is incomplete'],
      claims: [claim({ outcome: 'blocked' })],
    }))).toContain('non-passed case case-one has no failure classification')
  })

  it('rejects a product-failed claim that is not product-sourced and a blocked claim that is', () => {
    expect(settlementProblems(input({
      outcome: 'product_failed', productDefects: ['Confirmation is missing'],
      claims: [claim({ outcome: 'product_failed', failureSource: 'agent_execution', failureKind: 'assertion' })],
    }))).toContain('product-failed case case-one is not classified as product-sourced')

    expect(settlementProblems(input({
      outcome: 'blocked', blockers: ['Confirmation is missing'],
      claims: [claim({ outcome: 'blocked', failureSource: 'product', failureKind: 'assertion' })],
    }))).toContain('blocked case case-one is incorrectly classified as product-sourced')
  })

  it('accepts a product-failed and a blocked claim that the contract allows', () => {
    expect(settlementProblems(input({
      outcome: 'product_failed', productDefects: ['Confirmation is missing'],
      claims: [claim({ outcome: 'product_failed', failureSource: 'product', failureKind: 'assertion' })],
    }))).toEqual([])

    expect(settlementProblems(input({
      outcome: 'blocked', blockers: ['Target write permission is missing'],
      claims: [claim({ outcome: 'blocked', failureSource: 'input', failureKind: 'validation' })],
    }))).toEqual([])
  })
})

describe('evidence and execution receipt contracts', () => {
  it('rejects a claim with no evidence', () => {
    expect(settlementProblems(input({ claims: [claim({ evidence: [] })] }))).toContain('case case-one has no execution evidence')
  })

  it('rejects unknown and cross-case execution receipt references', () => {
    expect(settlementProblems(input({
      claims: [claim({ executionReceiptIds: ['missing-one'] })],
      executionReceipts: [receipt()],
    }))).toContain('case case-one references unknown execution receipts')

    expect(settlementProblems(input({
      claims: [claim({ executionReceiptIds: ['interaction-one'] })],
      executionReceipts: [receipt({ caseId: 'case-other' })],
    }))).toContain('case case-one references an execution receipt belonging to another case')
  })

  it('requires an observation-kind evidence entry and an interaction receipt from the outcome contract', () => {
    expect(settlementProblems(input({
      claims: [claim({ evidence: [{ kind: 'screenshot', description: 'a screenshot is not a postcondition observation' }] })],
    }))).toContain('case case-one does not satisfy its outcome observation evidence requirement')

    const interactionContract = manifest([phase('case-one', outcomeContract(['interaction', 'observation'], ALL_FAILURE_MODES))])
    expect(settlementProblems(input({
      manifest: interactionContract,
      claims: [claim({ executionReceiptIds: ['observation-one'] })],
      executionReceipts: [receipt({ id: 'observation-one', kind: 'observation' })],
    }))).toContain('case case-one does not satisfy its outcome interaction receipt requirement')

    expect(settlementProblems(input({
      manifest: interactionContract,
      claims: [claim({ executionReceiptIds: ['interaction-one'] })],
      executionReceipts: [receipt()],
    }))).toEqual([])
  })

  it('does not check evidence paths on the filesystem: that stays in the adapter', () => {
    const settlement = settleResult(input({
      claims: [claim({ evidence: [{ kind: 'observation', path: 'evidence/never-written.md', description: 'observation' }] })],
    }))

    expect(settlement.problems).toEqual([])
    expect(settlement.result?.cases[0]?.evidence[0]?.path).toBe('evidence/never-written.md')
  })

  it('rejects a failure mode the outcome contract does not allow and accepts an allowed one', () => {
    const failing = claim({ outcome: 'blocked', failureSource: 'agent_execution', failureKind: 'mutation' })
    const blocked = { outcome: 'blocked' as const, blockers: ['Cleanup could not be verified'] }
    expect(settlementProblems(input({
      manifest: manifest([phase('case-one', outcomeContract(['observation'], ['business_assertion']))]),
      ...blocked, claims: [failing],
    }))).toContain('case case-one failure mode mutation_cleanup is not allowed by its outcome contract')

    expect(settlementProblems(input({
      manifest: manifest([phase('case-one', outcomeContract(['observation'], ['mutation_cleanup']))]),
      ...blocked, claims: [failing],
    }))).toEqual([])
  })
})

describe('environment requirement reconciliation', () => {
  it('rejects an environment-blocked claim without a recorded requirement reference', () => {
    expect(settlementProblems(input({
      outcome: 'blocked', blockers: ['Target write permission is missing'],
      claims: [claim({ outcome: 'blocked', failureSource: 'environment', failureKind: 'environment' })],
    }))).toContain('environment-blocked case case-one has no recorded environment requirement reference')
  })

  it('rejects unknown, unlinked, non-pending, and evidence-less requirement references', () => {
    expect(settlementProblems(input({
      outcome: 'blocked', blockers: ['missing'], claims: [claim({
        outcome: 'blocked', failureSource: 'environment', failureKind: 'environment', environmentRequirementIds: ['unknown-1'],
      })],
    }))).toContain('environment-blocked case case-one references unknown environment requirement unknown-1')

    expect(settlementProblems(input({
      outcome: 'blocked', blockers: ['unlinked'], environmentRequirements: [requirement({ caseIds: ['case-other'] })],
      claims: [claim({ outcome: 'blocked', failureSource: 'environment', failureKind: 'environment', environmentRequirementIds: ['env-1'] })],
    }))).toContain('environment-blocked case case-one is not linked to environment requirement env-1')

    expect(settlementProblems(input({
      outcome: 'blocked', blockers: ['satisfied'], environmentRequirements: [requirement({ status: 'satisfied' })],
      claims: [claim({ outcome: 'blocked', failureSource: 'environment', failureKind: 'environment', environmentRequirementIds: ['env-1'] })],
    }))).toContain('environment-blocked case case-one references non-pending environment requirement env-1')

    expect(settlementProblems(input({
      outcome: 'blocked', blockers: ['unevidenced'], environmentRequirements: [requirement({ evidence: [] })],
      claims: [claim({ outcome: 'blocked', failureSource: 'environment', failureKind: 'environment', environmentRequirementIds: ['env-1'] })],
    }))).toContain('environment requirement env-1 has no saved evidence')
  })

  it('accepts a pending requirement that the environment-blocked claim links to', () => {
    expect(settlementProblems(input({
      outcome: 'blocked', blockers: ['Target write permission'], environmentRequirements: [requirement()],
      claims: [claim({ outcome: 'blocked', failureSource: 'environment', failureKind: 'environment', environmentRequirementIds: ['env-1'] })],
    }))).toEqual([])
  })

  it('rejects requirement references on a non-environment claim', () => {
    expect(settlementProblems(input({
      environmentRequirements: [requirement({ status: 'satisfied' })],
      claims: [claim({ environmentRequirementIds: ['env-1'] })],
    }))).toContain('non-environment case case-one contains environment requirement references')
  })

  it('rejects a pending requirement that no environment-blocked claim represents', () => {
    expect(settlementProblems(input({ environmentRequirements: [requirement()] })))
      .toContain('pending environment requirement env-1 is not represented by environment-blocked case case-one')
  })

  it('reconciles a reported requirement projection against the recorded requirements', () => {
    const blockedByEnvironment = {
      outcome: 'blocked' as const,
      blockers: ['Target write permission'],
      claims: [claim({ outcome: 'blocked', failureSource: 'environment', failureKind: 'environment', environmentRequirementIds: ['env-1'] })],
    }
    expect(settlementProblems(input({
      ...blockedByEnvironment, reportedEnvironmentRequirements: [requirement({ id: 'ghost-1' })], environmentRequirements: [requirement()],
    }))).toContain('final result includes unrecorded environment requirement ghost-1')

    expect(settlementProblems(input({
      ...blockedByEnvironment, reportedEnvironmentRequirements: [requirement({ condition: 'A different condition' })], environmentRequirements: [requirement()],
    }))).toContain('final result environment requirement env-1 does not match the recorded requirement')

    expect(settlementProblems(input({
      ...blockedByEnvironment, reportedEnvironmentRequirements: [requirement()], environmentRequirements: [requirement()],
    }))).toEqual([])
  })
})

describe('mutation ledger enforcement', () => {
  it('forces a pending mutation into a blocked case with mutation evidence', () => {
    const settlement = settleResult(input({
      claims: [claim()],
      mutationLedger: [ledgerEntry({ status: 'pending' })],
    }))

    expect(settlement.problems).toEqual([])
    expect(settlement.result?.outcome).toBe('blocked')
    expect(settlement.result?.mutations).toEqual([{
      id: 'mutation-1', caseId: 'case-one', description: 'Created a row', risk: 'write', status: 'pending', evidence: ['evidence/mutation-1.png'],
    }])
    expect(settlement.result?.cases[0]).toMatchObject({
      outcome: 'blocked',
      failureSource: 'agent_execution',
      failureKind: 'execution',
      summary: 'verified Unrecovered business mutations remain for this case.',
    })
    expect(settlement.result?.cases[0]?.evidence[1]).toEqual({ kind: 'mutation', description: 'Pending mutation mutation-1: Created a row' })
    expect(settlement.result?.summary).toBe('settled Unrecovered business mutations remain.')
    expect(settlement.result?.blockers).toEqual(['Unrecovered mutations: mutation-1'])
  })

  it('keeps an already-blocked classification and reconciles pending requirements first', () => {
    const settlement = settleResult(input({
      outcome: 'blocked', blockers: ['Target write permission'], environmentRequirements: [requirement()],
      claims: [claim({ outcome: 'blocked', failureSource: 'environment', failureKind: 'environment', environmentRequirementIds: ['env-1'] })],
      mutationLedger: [ledgerEntry({ status: 'pending' })],
    }))

    expect(settlement.problems).toEqual([])
    expect(settlement.result?.cases[0]).toMatchObject({ failureSource: 'environment', failureKind: 'environment' })
    expect(settlement.result?.summary).toBe('settled Required environment prerequisites remain unavailable. Unrecovered business mutations remain.')
    expect(settlement.result?.blockers).toEqual(['Target write permission', 'Unrecovered mutations: mutation-1'])
    expect(settlement.result?.nextActions).toEqual(['Provide the required permission prerequisite: Target write permission, then resume the same run.'])
  })

  it('projects a fully recovered ledger without changing the submitted outcome', () => {
    const settlement = settleResult(input({
      claims: [claim()],
      mutationLedger: [ledgerEntry(), ledgerEntry({ id: 'mutation-2', status: 'compensated' })],
    }))

    expect(settlement.problems).toEqual([])
    expect(settlement.result?.outcome).toBe('passed')
    expect(settlement.result?.summary).toBe('settled')
    expect(settlement.result?.cases[0]).toEqual(resultCase())
    expect(settlement.result?.mutations.map((item) => item.status)).toEqual(['accepted', 'compensated'])
  })
})

describe('top-level outcome derivation and narrative', () => {
  it('derives blocked over product_failed over passed from the claims', () => {
    const phases = [phase('case-one'), phase('case-two'), phase('case-three')]
    const base = {
      outcome: 'passed' as const,
      summary: 'verified',
      evidence: [{ kind: 'observation' as const, description: 'observed' }],
    }
    expect(settlementProblems(input({
      manifest: manifest(phases), claims: [claim(), { ...base, caseId: 'case-two' }, { ...base, caseId: 'case-three' }], outcome: 'passed',
    }))).toEqual([])

    expect(settlementProblems(input({
      manifest: manifest(phases), outcome: 'passed', productDefects: ['defect'],
      claims: [claim(), { ...base, caseId: 'case-two', outcome: 'product_failed', failureSource: 'product', failureKind: 'assertion' }, { ...base, caseId: 'case-three' }],
    }))).toContain('top-level outcome must be product_failed')

    expect(settlementProblems(input({
      manifest: manifest(phases), outcome: 'blocked', blockers: ['blocked'], productDefects: ['defect'],
      claims: [
        claim(),
        { ...base, caseId: 'case-two', outcome: 'blocked', failureSource: 'input', failureKind: 'validation' },
        { ...base, caseId: 'case-three', outcome: 'product_failed', failureSource: 'product', failureKind: 'assertion' },
      ],
    }))).toEqual([])
  })

  it('rejects a passed result that still reports blockers or defects', () => {
    expect(settlementProblems(input({ blockers: ['stale blocker'] }))).toContain('passed result contains blockers or product defects')
    expect(settlementProblems(input({ productDefects: ['stale defect'] }))).toContain('passed result contains blockers or product defects')
  })

  it('rejects a product-failed result without a defect and a blocked result without a blocker', () => {
    expect(settlementProblems(input({
      outcome: 'product_failed', claims: [claim({ outcome: 'product_failed', failureSource: 'product', failureKind: 'assertion' })],
    }))).toContain('product-failed result has no product defect')

    expect(settlementProblems(input({
      outcome: 'blocked', claims: [claim({ outcome: 'blocked', failureSource: 'input', failureKind: 'validation' })],
    }))).toContain('blocked result has no blocker')
  })

  it('appends the replay problems of the run projection last', () => {
    expect(settlementProblems(input({ replayProblems: ['case case-one replay contract replayable_attempt_missing: no assertion'] })))
      .toEqual(['case case-one replay contract replayable_attempt_missing: no assertion'])
  })
})

function claimFacts(result?: CodexTestAgentResult): unknown {
  if (!result) return result
  return {
    ...result,
    cases: result.cases.map((item) => ({
      ...item,
      evidence: item.evidence.map(({ description: _description, ...rest }) => rest),
    })),
  }
}

describe('case claim normalization parity', () => {
  const deliveryRow = {
    caseId: 'case-one',
    outcome: 'blocked' as const,
    summary: 'Target write permission is missing',
    failureSource: 'environment' as const,
    failureKind: 'environment' as const,
    environmentRequirementIds: ['env-1'],
    evidencePaths: ['evidence/case-1.md'],
  }

  const settledClaim: ResultCase = {
    caseId: 'case-one', title: 'Title case-one', outcome: 'blocked', summary: 'Target write permission is missing',
    failureSource: 'environment', failureKind: 'environment', environmentRequirementIds: ['env-1'],
    evidence: [{ kind: 'observation', path: 'evidence/case-1.md', description: 'observed' }],
  }

  function parityInput(claims: SettlementCaseClaim[]): ResultSettlementInput {
    return input({
      outcome: 'blocked', blockers: ['Target write permission is missing'], environmentRequirements: [requirement()], claims,
    })
  }

  it('settles the same logical claim from a delivery artifact row and from a canonical result case', () => {
    const fromDelivery = settleResult(parityInput(settlementClaimsFromDelivery([deliveryRow], 'case-results.json')))
    const fromResult = settleResult(parityInput(settlementClaimsFromResult([settledClaim])))

    expect(fromDelivery.problems).toEqual(fromResult.problems)
    // Only the synthesized evidence description differs: one path writes what
    // the artifact asserted, the other what the AgentHost delivery contained.
    expect(claimFacts(fromDelivery.result)).toEqual(claimFacts(fromResult.result))
  })

  it('produces the same problem set for a rejected claim from either path', () => {
    const rejected = input({ outcome: 'blocked', blockers: ['Target write permission is missing'] })
    const expected = ['environment-blocked case case-one references unknown environment requirement env-1']
    expect(settlementProblems({ ...rejected, claims: settlementClaimsFromDelivery([deliveryRow], 'case-results.json') })).toEqual(expected)
    expect(settlementProblems({ ...rejected, claims: settlementClaimsFromResult([settledClaim]) })).toEqual(expected)
  })

  it('normalizes empty delivery evidence paths into a single observation of the artifact itself', () => {
    expect(settlementClaimsFromDelivery([{ ...deliveryRow, evidencePaths: [] }], 'case-results.json')).toEqual([{
      caseId: 'case-one',
      outcome: 'blocked',
      summary: 'Target write permission is missing',
      failureSource: 'environment',
      failureKind: 'environment',
      environmentRequirementIds: ['env-1'],
      evidence: [{ kind: 'observation', path: 'case-results.json', description: 'AgentHost recorded case-one as blocked in case-results.json.' }],
    }])
  })

  it('keeps the case fields of both paths lossless through settlement', () => {
    expect(settlementClaimsFromDelivery([{ ...deliveryRow, evidencePaths: ['evidence/case-1.md'] }], 'case-results.json')[0]).toEqual({
      caseId: 'case-one',
      outcome: 'blocked',
      summary: 'Target write permission is missing',
      failureSource: 'environment',
      failureKind: 'environment',
      environmentRequirementIds: ['env-1'],
      evidence: [{ kind: 'observation', path: 'evidence/case-1.md', description: 'AgentHost recorded evidence for case-one: evidence/case-1.md' }],
    })
    expect(settlementClaimsFromResult([resultCase({ fieldGateIds: ['gate-1'] })])[0]).toMatchObject({ fieldGateIds: ['gate-1'] })
  })
})
