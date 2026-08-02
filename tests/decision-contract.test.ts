import { describe, expect, it } from 'vitest'
import { decisionFieldContractProblem } from '../src/agent/decision-contract.js'
import type { CodexTestCaseDecision, CodexTestFieldCompositionGate } from '../src/agent/types.js'

function decision(overrides: Partial<CodexTestCaseDecision> = {}): CodexTestCaseDecision {
  return {
    caseId: 'submit-form',
    outcome: 'blocked',
    summary: 'The representation gate blocked submission.',
    blockers: ['Composite field representation is invalid.'],
    productDefects: [],
    failureSource: 'agent_execution',
    failureKind: 'validation',
    fieldGateIds: ['submit-form:logical-value'],
    recordedAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  }
}

function gate(status: 'passed' | 'blocked'): CodexTestFieldCompositionGate {
  return {
    id: 'submit-form:logical-value',
    caseId: 'submit-form',
    fieldId: 'logical-value',
    logicalValueRef: 'workflow.logicalValue',
    purpose: 'Represent one logical value across visible controls',
    components: [],
    rendered: [],
    evidence: ['snapshot:form'],
    status,
    reasons: status === 'blocked' ? ['duplicate static component'] : [],
    checkedAt: '2026-08-02T00:00:00.000Z',
  }
}

describe('case decision field representation contract', () => {
  it('accepts an agent-execution block backed by a blocked gate', () => {
    expect(decisionFieldContractProblem(decision(), [gate('blocked')])).toBeUndefined()
  })

  it('rejects a product validation defect backed by a blocked gate', () => {
    const problem = decisionFieldContractProblem(decision({
      outcome: 'product_failed',
      blockers: [],
      productDefects: ['The application rejected the value.'],
      failureSource: 'product',
    }), [gate('blocked')])

    expect(problem).toContain('lacks a passed composite-field gate')
  })

  it('accepts a product validation defect only after a passed gate', () => {
    expect(decisionFieldContractProblem(decision({
      outcome: 'product_failed',
      blockers: [],
      productDefects: ['The application rejected a verified representation.'],
      failureSource: 'product',
    }), [gate('passed')])).toBeUndefined()
  })

  it('accepts a passed case that references its passed composite-field gate', () => {
    const passed = decision({
      outcome: 'passed',
      summary: 'The submitted representation was accepted.',
      blockers: [],
      productDefects: [],
      fieldGateIds: ['submit-form:logical-value'],
    })
    delete passed.failureSource
    delete passed.failureKind
    expect(decisionFieldContractProblem(passed, [gate('passed')])).toBeUndefined()
  })
})
