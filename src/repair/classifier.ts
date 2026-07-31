import type { TestCaseIR, TestSuiteIR } from '../core/types.js'
import type {
  CaseLocatorValidationResult,
  LocatorValidationReport,
  RuntimeFailureEvidence,
  RuntimeFailureKind,
} from '../validation/locator-validator.js'
import type {
  ClassifiedFailure,
  FailureCategory,
  FailureClassificationReport,
  RepairEligibility,
} from './types.js'

function inferLegacyFailure(message: string): RuntimeFailureEvidence {
  if (/missing required secret environment variable/i.test(message)) return { kind: 'missing_data', phase: 'setup', message }
  if (/matched 0 elements|locator matched 0/i.test(message)) return { kind: 'locator_not_found', phase: 'step', message }
  if (/matched [2-9]\d* elements|strict mode violation/i.test(message)) return { kind: 'locator_ambiguous', phase: 'step', message }
  if (/toHaveURL|toHaveText|toContainText|toBeVisible|expect\(/i.test(message)) return { kind: 'assertion_mismatch', phase: 'assertion', message }
  if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ECONNREFUSED|browser.*closed/i.test(message)) return { kind: 'environment_error', phase: 'setup', message }
  if (/timeout|timed out/i.test(message)) return { kind: 'action_timeout', phase: 'step', message }
  return { kind: 'unknown', phase: 'setup', message }
}

function targetStep(testCase: TestCaseIR, targetId: string | undefined) {
  if (!targetId) return undefined
  return testCase.steps.find((item) => item.id === targetId) ?? testCase.cleanupSteps?.find((item) => item.id === targetId)
}

function sameTargetFailures(caseResult: CaseLocatorValidationResult, failure: RuntimeFailureEvidence): number {
  return caseResult.replays.filter((replay) => {
    const current = replay.failure ?? (replay.error ? inferLegacyFailure(replay.error) : undefined)
    return current?.kind === failure.kind && current.targetId === failure.targetId
  }).length
}

function repairEligibility(
  suite: TestSuiteIR,
  testCase: TestCaseIR,
  caseResult: CaseLocatorValidationResult,
  failure: RuntimeFailureEvidence,
): RepairEligibility {
  const allowed = suite.policy.repair.allowedChanges
  if (failure.kind.startsWith('locator_')) {
    return allowed.includes('locator')
      ? { eligible: true, allowedChanges: ['locator'], reason: 'A stable equivalent locator candidate may replace the failing locator.' }
      : { eligible: false, allowedChanges: [], reason: 'Suite policy does not allow locator repair.' }
  }
  if (failure.kind === 'wait_timeout') {
    const step = targetStep(testCase, failure.targetId)
    const intermittent = sameTargetFailures(caseResult, failure) < caseResult.replays.length
    if (!step?.waitFor) return { eligible: false, allowedChanges: [], reason: 'The failing target has no explicit waitCondition.' }
    if (!intermittent) return { eligible: false, allowedChanges: [], reason: 'The wait failed in every replay; increasing timeout would mask a deterministic failure.' }
    return allowed.includes('waitCondition')
      ? { eligible: true, allowedChanges: ['waitCondition'], reason: 'The explicit waitCondition failed intermittently and may receive a bounded timeout increase.' }
      : { eligible: false, allowedChanges: [], reason: 'Suite policy does not allow waitCondition repair.' }
  }
  return { eligible: false, allowedChanges: [], reason: 'This failure category is outside the automatic repair boundary.' }
}

function classificationFor(kind: RuntimeFailureKind): { category: FailureCategory; confidence: 'high' | 'medium' | 'low' } {
  if (kind.startsWith('locator_')) return { category: 'test_code', confidence: 'high' }
  if (kind === 'wait_timeout' || kind === 'action_timeout' || kind === 'action_error') return { category: 'test_code', confidence: 'medium' }
  if (kind === 'assertion_mismatch') return { category: 'product_defect', confidence: 'high' }
  if (kind === 'navigation_error' || kind === 'environment_error') return { category: 'environment', confidence: 'high' }
  if (kind === 'missing_data') return { category: 'data', confidence: 'high' }
  if (kind === 'origin_violation') return { category: 'policy', confidence: 'high' }
  return { category: 'unknown', confidence: 'low' }
}

function evidenceFor(
  caseResult: CaseLocatorValidationResult,
  replayNumber: number,
  failure: RuntimeFailureEvidence,
): string[] {
  const replay = caseResult.replays.find((item) => item.replay === replayNumber)
  const targetChecks = replay?.checks.filter((check) => !failure.targetId || check.targetId === failure.targetId) ?? []
  return [
    failure.message,
    ...targetChecks.map((check) =>
      `${check.expression}: count=${check.count}, visible=${String(check.visible)}, enabled=${String(check.enabled)}, editable=${String(check.editable)}`,
    ),
  ]
}

export function classifyFailures(
  suite: TestSuiteIR,
  validation: LocatorValidationReport,
): FailureClassificationReport {
  if (suite.suiteId !== validation.suiteId) throw new Error('Validation report suiteId does not match the IR')
  const failures: ClassifiedFailure[] = []
  for (const caseResult of validation.cases) {
    const testCase = suite.cases.find((item) => item.id === caseResult.caseId)
    if (!testCase) throw new Error(`Validation report contains unknown case: ${caseResult.caseId}`)
    if (caseResult.status === 'blocked') {
      failures.push({
        caseId: testCase.id,
        title: testCase.title,
        replay: null,
        category: 'policy',
        confidence: 'high',
        failureKind: 'policy_blocked',
        phase: 'setup',
        evidence: [caseResult.blockedReason ?? 'Case execution was blocked by policy.'],
        repair: { eligible: false, allowedChanges: [], reason: 'Policy decisions cannot be auto-repaired.' },
      })
      continue
    }
    for (const replay of caseResult.replays) {
      if (replay.status !== 'failed') continue
      const failure = replay.failure ?? inferLegacyFailure(replay.error ?? 'Unknown replay failure')
      const classification = classificationFor(failure.kind)
      const repair = repairEligibility(suite, testCase, caseResult, failure)
      if (failure.kind === 'wait_timeout' && !repair.eligible && repair.reason.includes('every replay')) {
        classification.category = 'product_defect'
        classification.confidence = 'medium'
      }
      failures.push({
        caseId: testCase.id,
        title: testCase.title,
        replay: replay.replay,
        category: classification.category,
        confidence: classification.confidence,
        failureKind: failure.kind,
        phase: failure.phase,
        ...(failure.targetId ? { targetId: failure.targetId } : {}),
        ...(failure.sourceText ? { sourceText: failure.sourceText } : {}),
        evidence: evidenceFor(caseResult, replay.replay, failure),
        repair,
      })
    }
  }
  const categories: FailureCategory[] = ['product_defect', 'test_code', 'environment', 'data', 'policy', 'unknown']
  const summary = Object.fromEntries(categories.map((category) => [category, failures.filter((item) => item.category === category).length])) as Record<FailureCategory, number>
  return {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    suiteId: suite.suiteId,
    failures,
    summary: {
      ...summary,
      total: failures.length,
      repairEligible: failures.filter((item) => item.repair.eligible).length,
    },
  }
}
