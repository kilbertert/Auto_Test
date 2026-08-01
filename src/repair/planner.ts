import type { AssertionIR, StepIR, TestCaseIR, TestSuiteIR } from '../core/types.js'
import type { LocatorCandidateReport } from '../exploration/types.js'
import type { ValidationTargetType } from '../validation/locator-validator.js'
import type {
  FailureClassificationReport,
  RepairChange,
} from './types.js'

type RepairTarget = StepIR | AssertionIR

function targetInCase(
  testCase: TestCaseIR,
  targetId: string,
  targetType: ValidationTargetType,
): RepairTarget | undefined {
  if (targetType === 'step') return testCase.steps.find((item) => item.id === targetId)
  if (targetType === 'cleanup') return testCase.cleanupSteps?.find((item) => item.id === targetId)
  return testCase.assertions.find((item) => item.id === targetId)
}

function targetInSuite(
  suite: TestSuiteIR,
  caseId: string,
  targetId: string,
  targetType: ValidationTargetType,
): RepairTarget {
  const testCase = suite.cases.find((item) => item.id === caseId)
  if (!testCase) throw new Error(`Repair case does not exist: ${caseId}`)
  const target = targetInCase(testCase, targetId, targetType)
  if (!target) throw new Error(`Repair target does not exist: ${targetType}:${targetId}`)
  return target
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function protectedProjection(input: TestSuiteIR): string {
  const suite = structuredClone(input)
  for (const testCase of suite.cases) {
    for (const step of [...testCase.steps, ...(testCase.cleanupSteps ?? [])]) {
      delete step.locator
      if (step.waitFor) delete step.waitFor.timeoutMs
    }
    for (const assertion of testCase.assertions) delete assertion.locator
  }
  return JSON.stringify(suite)
}

export function assertOnlyRepairableFieldsChanged(before: TestSuiteIR, after: TestSuiteIR): void {
  if (protectedProjection(before) !== protectedProjection(after)) {
    throw new Error('Repair attempted to modify protected IR fields')
  }
}

export function planRepairs(
  suite: TestSuiteIR,
  classification: FailureClassificationReport,
  candidates: LocatorCandidateReport[],
): RepairChange[] {
  const changes: RepairChange[] = []
  const plannedTargets = new Set<string>()
  for (const failure of classification.failures) {
    if (!failure.repair.eligible || !failure.targetId || failure.phase === 'setup') continue
    const targetType = failure.phase
    const key = `${failure.caseId}:${targetType}:${failure.targetId}`
    if (plannedTargets.has(key)) continue
    const target = targetInSuite(suite, failure.caseId, failure.targetId, targetType)

    if (failure.repair.allowedChanges.includes('locator')) {
      const candidate = candidates
        .filter((item) =>
          item.suiteId === suite.suiteId &&
          item.caseId === failure.caseId &&
          item.targetId === failure.targetId &&
          item.targetType === targetType &&
          item.stableAfterReload &&
          !item.diagnostics.some((diagnostic) => diagnostic.severity === 'error') &&
          item.sourceText === target.sourceText,
        )
        .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))[0]
      if (candidate && target.locator && !sameJson(target.locator, candidate.locator)) {
        changes.push({
          kind: 'locator',
          caseId: failure.caseId,
          targetId: failure.targetId,
          targetType,
          reason: failure.repair.reason,
          before: structuredClone(target.locator),
          after: structuredClone(candidate.locator),
          candidateGeneratedAt: candidate.generatedAt,
        })
        plannedTargets.add(key)
      }
      continue
    }

    if (failure.repair.allowedChanges.includes('waitCondition') && targetType !== 'assertion') {
      const step = target as StepIR
      if (!step.waitFor) continue
      const currentTimeout = step.waitFor.timeoutMs ?? 10_000
      const maximum = Math.min(suite.policy.caseTimeoutMs, 120_000)
      const nextTimeout = Math.min(maximum, Math.max(currentTimeout + 1_000, Math.ceil(currentTimeout * 1.5)))
      if (nextTimeout <= currentTimeout) continue
      changes.push({
        kind: 'waitCondition',
        caseId: failure.caseId,
        targetId: failure.targetId,
        targetType,
        reason: failure.repair.reason,
        before: structuredClone(step.waitFor),
        after: { ...structuredClone(step.waitFor), timeoutMs: nextTimeout },
      })
      plannedTargets.add(key)
    }
  }
  return changes
}

export function applyRepairChanges(input: TestSuiteIR, changes: RepairChange[]): TestSuiteIR {
  const suite = structuredClone(input)
  for (const change of changes) {
    if (!suite.policy.repair.allowedChanges.includes(change.kind)) {
      throw new Error(`Suite policy does not allow ${change.kind} repair`)
    }
    const target = targetInSuite(suite, change.caseId, change.targetId, change.targetType)
    if (change.kind === 'locator') {
      if (!target.locator || !sameJson(target.locator, change.before)) throw new Error(`Stale locator repair target: ${change.targetId}`)
      target.locator = structuredClone(change.after)
    } else {
      const step = target as StepIR
      if (!step.waitFor || !sameJson(step.waitFor, change.before)) throw new Error(`Stale wait repair target: ${change.targetId}`)
      step.waitFor = structuredClone(change.after)
    }
  }
  assertOnlyRepairableFieldsChanged(input, suite)
  return suite
}
