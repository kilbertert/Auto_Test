import { describe, expect, it } from 'vitest'
import { codexTestResultSchema, enforceMutationLedger, parseAgentTestResult, parseCodexTestResult } from '../src/agent/result.js'
import type { CodexTestAgentResult } from '../src/agent/types.js'

function result(): CodexTestAgentResult {
  return {
    version: '1.0',
    workflowId: 'catalog-check',
    sourceSha256: 'a'.repeat(64),
    outcome: 'passed',
    summary: 'All expected catalog states were observed.',
    startedAt: '2026-08-01T00:00:00.000Z',
    finishedAt: '2026-08-01T00:01:00.000Z',
    cases: [{
      caseId: 'filter-catalog',
      title: 'Filter catalog',
      outcome: 'passed',
      summary: 'The catalog contained only matching entries.',
      evidence: [{ kind: 'observation', description: 'Two matching rows remained.' }],
    }],
    mutations: [],
    environmentRequirements: [],
    blockers: [],
    productDefects: [],
    nextActions: [],
  }
}

describe('Codex test result contract', () => {
  it('uses a strict-provider-compatible schema with every object property required', () => {
    const problems: string[] = []
    const visit = (schema: unknown, path: string): void => {
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return
      const value = schema as Record<string, unknown>
      if (value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)) {
        const properties = Object.keys(value.properties as Record<string, unknown>)
        const required = Array.isArray(value.required) ? value.required : []
        for (const property of properties) if (!required.includes(property)) problems.push(`${path}.${property}`)
        for (const [property, child] of Object.entries(value.properties as Record<string, unknown>)) visit(child, `${path}.${property}`)
      }
      if (value.items) visit(value.items, `${path}[]`)
    }

    visit(codexTestResultSchema, '$')
    expect(problems).toEqual([])
  })

  it('deeply validates nested cases and evidence', () => {
    const invalid = result() as unknown as Record<string, unknown>
    invalid.cases = [{ caseId: 'filter-catalog', title: 'Filter', outcome: 'passed', summary: 'ok' }]

    expect(() => parseCodexTestResult(JSON.stringify(invalid))).toThrow(/schema validation.*evidence/i)
  })

  it('recovers a valid result from a later Markdown fence', () => {
    const value = `Here is a selector example:\n\n\`\`\`json\n{"not":"a test result"}\n\`\`\`\n\nFinal delivery:\n\n\`\`\`json\n${JSON.stringify(result())}\n\`\`\``
    expect(parseAgentTestResult(value)).toMatchObject({ workflowId: 'catalog-check', outcome: 'passed' })
  })

  it('forces a blocked outcome when the authoritative ledger still contains a pending mutation', () => {
    const enforced = enforceMutationLedger(result(), [{
      id: 'archive-row',
      caseId: 'filter-catalog',
      description: 'Archive the row created by this test',
      risk: 'write',
      status: 'pending',
      createdAt: '2026-08-01T00:00:10.000Z',
      updatedAt: '2026-08-01T00:00:10.000Z',
      evidence: [],
    }])

    expect(enforced.outcome).toBe('blocked')
    expect(enforced.blockers.join(' ')).toContain('archive-row')
    expect(enforced.mutations[0]?.status).toBe('pending')
    expect(enforced.cases[0]?.outcome).toBe('blocked')
    expect(enforced.cases[0]).toMatchObject({ failureSource: 'agent_execution', failureKind: 'execution' })
    expect(enforced.cases[0]?.evidence.some((item) => item.kind === 'mutation')).toBe(true)
  })

  it('validates optional failure classification and field gate references', () => {
    const classified = result()
    classified.outcome = 'blocked'
    classified.cases[0] = {
      ...classified.cases[0]!,
      outcome: 'blocked',
      failureSource: 'agent_execution',
      failureKind: 'validation',
      fieldGateIds: ['filter-catalog:query'],
    }
    classified.blockers = ['The field representation gate blocked submission.']

    expect(parseCodexTestResult(JSON.stringify(classified)).cases[0]).toMatchObject({
      failureSource: 'agent_execution', failureKind: 'validation', fieldGateIds: ['filter-catalog:query'],
    })
  })

  it('accepts strict-provider nullable optional fields and normalizes them at the result boundary', () => {
    const strictResult = {
      ...result(),
      cases: [{
        ...result().cases[0],
        failureSource: null,
        failureKind: null,
        environmentRequirementIds: null,
        executionReceiptIds: null,
        fieldGateIds: null,
        evidence: [{ kind: 'observation', path: null, description: 'Observed.' }],
      }],
      environmentRequirements: [{
        id: 'environment-test_data-fixture', caseIds: ['filter-catalog'], kind: 'test_data', origin: null,
        condition: 'Fixture was observed.', evidence: ['evidence/fixture.md'], status: 'satisfied', requestedAt: '2026-08-01T00:00:00.000Z',
      }],
    }

    const parsed = parseCodexTestResult(JSON.stringify(strictResult))
    expect(parsed.cases[0]).not.toHaveProperty('failureSource')
    expect(parsed.cases[0]).not.toHaveProperty('executionReceiptIds')
    expect(parsed.cases[0]?.evidence[0]).not.toHaveProperty('path')
    expect(parsed.environmentRequirements[0]).not.toHaveProperty('origin')
  })

  it('accepts infrastructure as a distinct failure source', () => {
    const classified = result()
    classified.outcome = 'blocked'
    classified.cases[0] = {
      ...classified.cases[0]!,
      outcome: 'blocked',
      summary: 'The model provider is unavailable.',
      failureSource: 'infrastructure',
      failureKind: 'execution',
    }
    classified.blockers = ['The model provider is unavailable.']

    expect(parseCodexTestResult(JSON.stringify(classified)).cases[0]).toMatchObject({
      failureSource: 'infrastructure', failureKind: 'execution',
    })
  })

  it('preserves an existing blocked root cause when pending mutations also require recovery', () => {
    const infrastructureFailure = result()
    infrastructureFailure.outcome = 'blocked'
    infrastructureFailure.cases[0] = {
      ...infrastructureFailure.cases[0]!,
      outcome: 'blocked',
      summary: 'The model provider is unavailable.',
      failureSource: 'infrastructure',
      failureKind: 'execution',
    }
    infrastructureFailure.blockers = ['The model provider is unavailable.']

    const enforced = enforceMutationLedger(infrastructureFailure, [{
      id: 'pending-write', caseId: 'filter-catalog', description: 'Recover the interrupted write', risk: 'write', status: 'pending',
      createdAt: '2026-08-01T00:00:10.000Z', updatedAt: '2026-08-01T00:00:10.000Z', evidence: [],
    }])

    expect(enforced.cases[0]).toMatchObject({
      outcome: 'blocked', failureSource: 'infrastructure', failureKind: 'execution',
    })
    expect(enforced.blockers.join(' ')).toContain('pending-write')
  })
})
