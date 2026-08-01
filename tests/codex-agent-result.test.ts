import { describe, expect, it } from 'vitest'
import { enforceMutationLedger, parseCodexTestResult } from '../src/agent/result.js'
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
    blockers: [],
    productDefects: [],
    nextActions: [],
  }
}

describe('Codex test result contract', () => {
  it('deeply validates nested cases and evidence', () => {
    const invalid = result() as unknown as Record<string, unknown>
    invalid.cases = [{ caseId: 'filter-catalog', title: 'Filter', outcome: 'passed', summary: 'ok' }]

    expect(() => parseCodexTestResult(JSON.stringify(invalid))).toThrow(/schema validation.*evidence/i)
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
    expect(enforced.cases[0]?.evidence.some((item) => item.kind === 'mutation')).toBe(true)
  })
})
