import { describe, expect, it } from 'vitest'
import type { TestSuiteIR } from '../src/core/types.js'
import type { LocatorCandidateReport } from '../src/exploration/types.js'
import { classifyFailures } from '../src/repair/classifier.js'
import {
  applyRepairChanges,
  assertOnlyRepairableFieldsChanged,
  planRepairs,
} from '../src/repair/planner.js'
import type { LocatorValidationReport, RuntimeFailureEvidence } from '../src/validation/locator-validator.js'

function suite(): TestSuiteIR {
  return {
    version: '1.0',
    suiteId: 'repair-suite',
    source: { format: 'xlsx', fileName: 'cases.xlsx', sha256: '0'.repeat(64) },
    target: { baseUrl: 'https://example.test/', allowedOrigins: ['https://example.test/'] },
    policy: {
      caseTimeoutMs: 60_000,
      retries: 0,
      repair: { maxAttempts: 2, allowedChanges: ['locator', 'waitCondition'], assertionMutation: 'forbidden' },
      destructiveActions: 'blocked',
    },
    cases: [{
      id: 'case-1',
      title: '登录',
      priority: 'P0',
      risk: 'read',
      steps: [{
        id: 'step-1',
        action: 'click',
        targetDescription: '登录按钮',
        locator: { strategy: 'text', value: '旧登录', source: 'manual' },
        waitFor: { kind: 'url', expected: '/dashboard', timeoutMs: 1_000 },
        sourceText: '点击登录按钮',
        confidence: 1,
      }],
      assertions: [{
        id: 'assert-1',
        kind: 'url',
        operator: 'contains',
        expected: '/dashboard',
        sourceText: '进入首页',
        oracleSource: 'tester',
        immutable: true,
        confidence: 1,
      }],
      review: { status: 'approved', ambiguities: [], confidence: 1 },
    }],
  }
}

function report(failures: Array<RuntimeFailureEvidence | null>): LocatorValidationReport {
  return {
    version: '1.0',
    generatedAt: new Date(0).toISOString(),
    suiteId: 'repair-suite',
    requestedReplays: failures.length,
    cases: [{
      caseId: 'case-1',
      title: '登录',
      status: failures.some(Boolean) ? 'failed' : 'passed',
      stableAcrossReplays: !failures.some(Boolean),
      replays: failures.map((failure, index) => ({
        replay: index + 1,
        status: failure ? 'failed' : 'passed',
        durationMs: 1,
        checks: failure?.targetId ? [{
          replay: index + 1,
          targetId: failure.targetId,
          targetType: failure.phase === 'assertion' ? 'assertion' : 'step',
          sourceText: failure.sourceText ?? '',
          expression: 'page.getByText("旧登录")',
          url: 'https://example.test/',
          count: failure.kind === 'locator_not_found' ? 0 : 1,
          visible: failure.kind === 'locator_not_found' ? null : true,
          enabled: failure.kind === 'locator_not_found' ? null : true,
          editable: null,
          passed: false,
        }] : [],
        ...(failure ? { error: failure.message, failure } : {}),
      })),
    }],
    summary: {
      total: 1,
      passed: failures.some(Boolean) ? 0 : 1,
      failed: failures.some(Boolean) ? 1 : 0,
      blocked: 0,
      locatorChecks: failures.filter((failure) => failure?.targetId).length,
    },
  }
}

function candidate(): LocatorCandidateReport {
  return {
    version: '1.0',
    generatedAt: '2026-07-28T00:00:00.000Z',
    suiteId: 'repair-suite',
    caseId: 'case-1',
    targetId: 'step-1',
    targetType: 'step',
    sourceText: '点击登录按钮',
    snapshotRef: 'e9',
    generatedExpression: "getByRole('button', { name: '登录' })",
    locator: { strategy: 'role', value: 'button', name: '登录', source: 'playwrightCli' },
    current: { count: 1, visible: true, enabled: true, editable: false, url: 'https://example.test/' },
    afterReload: { count: 1, visible: true, enabled: true, editable: false, url: 'https://example.test/' },
    stableAfterReload: true,
    diagnostics: [],
  }
}

describe('failure classification', () => {
  it('classifies assertion mismatches as product defects without repair', () => {
    const failure: RuntimeFailureEvidence = {
      kind: 'assertion_mismatch',
      phase: 'assertion',
      targetId: 'assert-1',
      sourceText: '进入首页',
      message: 'URL did not contain /dashboard',
    }

    const classification = classifyFailures(suite(), report([failure, failure]))

    expect(classification.failures[0]).toMatchObject({
      category: 'product_defect',
      confidence: 'high',
      repair: { eligible: false },
    })
  })

  it('classifies missing secrets as data failures', () => {
    const failure: RuntimeFailureEvidence = {
      kind: 'missing_data',
      phase: 'setup',
      message: 'Missing required secret environment variable',
    }

    expect(classifyFailures(suite(), report([failure])).failures[0]).toMatchObject({
      category: 'data',
      repair: { eligible: false },
    })
  })

  it('allows intermittent explicit waits but refuses deterministic wait timeouts', () => {
    const failure: RuntimeFailureEvidence = {
      kind: 'wait_timeout',
      phase: 'step',
      targetId: 'step-1',
      sourceText: '点击登录按钮',
      message: 'Timed out waiting for URL',
    }

    expect(classifyFailures(suite(), report([failure, null])).failures[0]!.repair.eligible).toBe(true)
    expect(classifyFailures(suite(), report([failure, failure])).failures[0]).toMatchObject({
      category: 'product_defect',
      confidence: 'medium',
      repair: {
        eligible: false,
        reason: expect.stringContaining('every replay'),
      },
    })
  })

  it('classifies browser and context failures as environment issues', () => {
    const failure: RuntimeFailureEvidence = {
      kind: 'environment_error',
      phase: 'setup',
      message: 'browser executable is missing',
    }

    expect(classifyFailures(suite(), report([failure])).failures[0]).toMatchObject({
      category: 'environment',
      confidence: 'high',
      repair: { eligible: false },
    })
  })
})

describe('bounded repair planning', () => {
  it('replaces only a failed locator using a stable candidate', () => {
    const input = suite()
    const failure: RuntimeFailureEvidence = {
      kind: 'locator_not_found',
      phase: 'step',
      targetId: 'step-1',
      sourceText: '点击登录按钮',
      message: 'locator matched 0 elements',
    }
    const classification = classifyFailures(input, report([failure, failure]))
    const changes = planRepairs(input, classification, [candidate()])
    const repaired = applyRepairChanges(input, changes)

    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ kind: 'locator', targetId: 'step-1' })
    expect(repaired.cases[0]!.steps[0]!.locator).toEqual(candidate().locator)
    expect(repaired.cases[0]!.assertions[0]!.expected).toBe('/dashboard')
    expect(repaired.cases[0]!.steps[0]!.waitFor?.expected).toBe('/dashboard')
  })

  it('increases only timeoutMs for an intermittent explicit wait', () => {
    const input = suite()
    const failure: RuntimeFailureEvidence = {
      kind: 'wait_timeout',
      phase: 'step',
      targetId: 'step-1',
      sourceText: '点击登录按钮',
      message: 'Timed out waiting for URL',
    }
    const classification = classifyFailures(input, report([failure, null]))
    const changes = planRepairs(input, classification, [])
    const repaired = applyRepairChanges(input, changes)

    expect(changes[0]).toMatchObject({
      kind: 'waitCondition',
      before: { timeoutMs: 1_000 },
      after: { timeoutMs: 2_000 },
    })
    expect(repaired.cases[0]!.steps[0]!.waitFor).toEqual({ kind: 'url', expected: '/dashboard', timeoutMs: 2_000 })
  })

  it('detects mutations to protected assertion fields', () => {
    const before = suite()
    const after = structuredClone(before)
    after.cases[0]!.assertions[0]!.expected = '/anything'

    expect(() => assertOnlyRepairableFieldsChanged(before, after)).toThrow(/protected/i)
  })
})
