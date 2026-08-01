import { describe, expect, it } from 'vitest'
import type { TestSuiteIR } from '../src/core/types.js'
import { validateLocators } from '../src/validation/locator-validator.js'

describe('locator validator navigation policy', () => {
  it('blocks a disallowed navigation target before sending the request', async () => {
    const suite: TestSuiteIR = {
      version: '1.0',
      suiteId: 'origin-policy-fixture',
      source: { format: 'xlsx', fileName: 'fixture.xlsx', sha256: 'a'.repeat(64) },
      target: { baseUrl: 'https://example.test/', allowedOrigins: ['https://example.test/'] },
      policy: {
        caseTimeoutMs: 5_000,
        retries: 0,
        repair: { maxAttempts: 0, allowedChanges: ['locator'], assertionMutation: 'forbidden' },
        destructiveActions: 'blocked',
      },
      cases: [{
        id: 'origin-case',
        title: 'origin policy',
        priority: 'P0',
        risk: 'read',
        steps: [{
          id: 'leave-origin',
          action: 'navigate',
          targetDescription: 'outside target',
          literalValue: 'https://outside.invalid/private',
          sourceText: 'navigate outside',
          confidence: 1,
        }],
        assertions: [{
          id: 'never-reached',
          kind: 'url',
          operator: 'contains',
          expected: 'example.test',
          sourceText: 'stay inside',
          oracleSource: 'tester',
          immutable: true,
          confidence: 1,
        }],
        review: { status: 'approved', ambiguities: [], confidence: 1 },
      }],
    }

    const report = await validateLocators(suite, { replays: 1 })

    expect(report.cases[0]?.replays[0]?.failure).toMatchObject({
      kind: 'origin_violation',
      phase: 'step',
      targetId: 'leave-origin',
    })
  })
})
