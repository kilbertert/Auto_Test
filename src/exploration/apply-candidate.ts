import type { AssertionIR, StepIR, TestSuiteIR } from '../core/types.js'
import type { LocatorCandidateReport } from './types.js'

function targetInSuite(
  suite: TestSuiteIR,
  report: LocatorCandidateReport,
): StepIR | AssertionIR {
  const testCase = suite.cases.find((item) => item.id === report.caseId)
  if (!testCase) throw new Error(`Candidate case does not exist: ${report.caseId}`)
  if (report.targetType === 'step') {
    const step = testCase.steps.find((item) => item.id === report.targetId)
    if (!step) throw new Error(`Candidate step does not exist: ${report.targetId}`)
    return step
  }
  if (report.targetType === 'cleanup') {
    const step = testCase.cleanupSteps?.find((item) => item.id === report.targetId)
    if (!step) throw new Error(`Candidate cleanup step does not exist: ${report.targetId}`)
    return step
  }
  const assertion = testCase.assertions.find((item) => item.id === report.targetId)
  if (!assertion) throw new Error(`Candidate assertion does not exist: ${report.targetId}`)
  return assertion
}

export function applyLocatorCandidate(
  input: TestSuiteIR,
  report: LocatorCandidateReport,
): TestSuiteIR {
  if (input.suiteId !== report.suiteId) throw new Error('Candidate suiteId does not match the IR')
  if (!report.stableAfterReload || report.diagnostics.some((item) => item.severity === 'error')) {
    throw new Error('Unstable locator candidate cannot be applied')
  }
  const suite = structuredClone(input)
  const target = targetInSuite(suite, report)
  if (target.sourceText !== report.sourceText) throw new Error('Candidate source text does not match the IR target')
  target.locator = structuredClone(report.locator)
  return suite
}
