import { createHash } from 'node:crypto'
import type { CompiledSourceMap, CompiledTargetSourceMap } from '../compiler/playwright.js'
import type { DataBindingIR, TestCaseIR, TestSuiteIR } from '../core/types.js'
import { locatorExpression } from '../runtime/locator.js'
import type { BoundedRepairReport, ClassifiedFailure, FailureCategory, FailureClassificationReport, RepairChange } from '../repair/types.js'
import type { LocatorValidationReport } from '../validation/locator-validator.js'
import type {
  IntegratedCaseReport,
  IntegratedRunReport,
  ParsedPlaywrightCase,
  PlaywrightExecutionEvidence,
  ReportCaseStatus,
  ReportTargetTrace,
} from './types.js'

export interface BuildIntegratedReportInput {
  suite: TestSuiteIR
  sourceMap: CompiledSourceMap
  executions?: ParsedPlaywrightCase[]
  validation?: LocatorValidationReport
  classification?: FailureClassificationReport
  repair?: BoundedRepairReport
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function effectiveValidation(input: BuildIntegratedReportInput): LocatorValidationReport | undefined {
  const lastAttempt = input.repair?.attempts.at(-1)
  return lastAttempt?.validation ?? input.repair?.baseline.validation ?? input.validation
}

function allClassifications(input: BuildIntegratedReportInput): ClassifiedFailure[] {
  return [
    ...(input.classification?.failures ?? []),
    ...(input.repair?.baseline.classification.failures ?? []),
    ...(input.repair?.attempts.flatMap((attempt) => attempt.classification.failures) ?? []),
  ]
}

function allRepairs(input: BuildIntegratedReportInput): RepairChange[] {
  return input.repair?.attempts.flatMap((attempt) => attempt.changes) ?? []
}

function safeBinding(binding: DataBindingIR): IntegratedCaseReport['dataBindings'][number] {
  if (binding.source === 'secret') return { name: binding.name, source: binding.source, ...(binding.secretRef ? { secretRef: binding.secretRef } : {}) }
  if (binding.source === 'generated') return { name: binding.name, source: binding.source, ...(binding.generator ? { generator: binding.generator } : {}) }
  return { name: binding.name, source: binding.source, ...(binding.value !== undefined ? { value: binding.value } : {}) }
}

function aggregateStatus(executions: PlaywrightExecutionEvidence[]): ReportCaseStatus | undefined {
  if (!executions.length) return undefined
  if (executions.some((item) => item.status === 'failed')) return 'failed'
  if (executions.some((item) => item.status === 'flaky')) return 'flaky'
  if (executions.every((item) => item.status === 'skipped')) return 'skipped'
  return 'passed'
}

function reportStatus(
  executions: PlaywrightExecutionEvidence[],
  validationStatus: string | undefined,
): ReportCaseStatus {
  const execution = aggregateStatus(executions)
  if (execution) return execution
  if (validationStatus === 'passed') return 'passed'
  if (validationStatus === 'failed') return 'failed'
  if (validationStatus === 'blocked') return 'blocked'
  return 'not_run'
}

function targetMap(items: CompiledTargetSourceMap[]): Map<string, CompiledTargetSourceMap> {
  return new Map(items.map((item) => [item.id, item]))
}

function executionSteps(executions: PlaywrightExecutionEvidence[], sourceText: string) {
  return executions.flatMap((execution) => execution.steps.filter((step) => step.title === sourceText))
}

function tracesForCase(
  testCase: TestCaseIR,
  caseMap: CompiledSourceMap['cases'][number] | undefined,
  executions: PlaywrightExecutionEvidence[],
  validation: LocatorValidationReport | undefined,
): Pick<IntegratedCaseReport, 'steps' | 'assertions' | 'cleanupSteps'> {
  const validationChecks = validation?.cases
    .find((item) => item.caseId === testCase.id)
    ?.replays.flatMap((replay) => replay.checks) ?? []
  const createTrace = (
    target: TestCaseIR['steps'][number] | TestCaseIR['assertions'][number],
    targetType: ReportTargetTrace['targetType'],
    codeMap: Map<string, CompiledTargetSourceMap>,
  ): ReportTargetTrace => {
    const isAssertion = targetType === 'assertion'
    const assertion = isAssertion ? target as TestCaseIR['assertions'][number] : undefined
    const step = !isAssertion ? target as TestCaseIR['steps'][number] : undefined
    return {
      id: target.id,
      targetType,
      sourceText: target.sourceText,
      codeLine: codeMap.get(target.id)?.line ?? null,
      ...(target.locator ? { expression: locatorExpression(target.locator) } : {}),
      ...(step ? { action: step.action } : {}),
      ...(assertion ? {
        assertion: {
          kind: assertion.kind,
          operator: assertion.operator,
          expected: assertion.expected,
          oracleSource: assertion.oracleSource,
          immutable: assertion.immutable,
        },
      } : {}),
      ...(step?.waitFor ? { waitFor: structuredClone(step.waitFor) } : {}),
      ...(step?.valueRef ? { valueRef: step.valueRef } : {}),
      validations: validationChecks.filter((check) => check.targetId === target.id && check.targetType === targetType),
      executionSteps: executionSteps(executions, target.sourceText),
    }
  }
  const stepMap = targetMap(caseMap?.steps ?? [])
  const assertionMap = targetMap(caseMap?.assertions ?? [])
  const cleanupMap = targetMap(caseMap?.cleanupSteps ?? [])
  return {
    steps: testCase.steps.map((step) => createTrace(step, 'step', stepMap)),
    assertions: testCase.assertions.map((assertion) => createTrace(assertion, 'assertion', assertionMap)),
    cleanupSteps: (testCase.cleanupSteps ?? []).map((step) => createTrace(step, 'cleanup', cleanupMap)),
  }
}

function classificationSummary(failures: ClassifiedFailure[]): Record<FailureCategory, number> {
  const categories: FailureCategory[] = ['product_defect', 'test_code', 'environment', 'data', 'policy', 'unknown']
  return Object.fromEntries(categories.map((category) => [category, failures.filter((item) => item.category === category).length])) as Record<FailureCategory, number>
}

function repairBoundaryIntact(repair: BoundedRepairReport | undefined): boolean {
  return repair?.attempts.every((attempt) => attempt.changes.every((change) => change.kind === 'locator' || change.kind === 'waitCondition')) ?? true
}

export function buildIntegratedRunReport(input: BuildIntegratedReportInput): IntegratedRunReport {
  const { suite, sourceMap } = input
  const irSha256 = sha256(JSON.stringify(suite))
  if (sourceMap.suiteId !== suite.suiteId || sourceMap.irSha256 !== irSha256) {
    throw new Error('Source map does not match the supplied IR')
  }
  if (input.repair?.finalStatus === 'repaired' && input.repair.finalIrSha256 !== irSha256) {
    throw new Error('Repair report final IR hash does not match the supplied IR')
  }
  const validation = effectiveValidation(input)
  const classifications = allClassifications(input)
  const repairs = allRepairs(input)
  const executionsByCase = new Map((input.executions ?? []).map((item) => [item.caseId, item]))
  const cases = suite.cases.map((testCase): IntegratedCaseReport => {
    const caseMap = sourceMap.cases.find((item) => item.caseId === testCase.id)
    const execution = executionsByCase.get(testCase.id)
    const executions = execution?.executions ?? []
    const validationCase = validation?.cases.find((item) => item.caseId === testCase.id)
    const caseRepairs = repairs.filter((change) => change.caseId === testCase.id)
    return {
      caseId: testCase.id,
      title: testCase.title,
      modulePath: testCase.modulePath ?? [],
      priority: testCase.priority,
      risk: testCase.risk,
      tags: testCase.tags ?? [],
      sourceRow: testCase.sourceRow ?? null,
      status: reportStatus(executions, validationCase?.status),
      repaired: caseRepairs.length > 0,
      reviewStatus: testCase.review.status,
      dataBindings: (testCase.dataBindings ?? []).map(safeBinding),
      code: { generatedFile: sourceMap.generatedFile, testLine: caseMap?.testLine ?? null },
      ...tracesForCase(testCase, caseMap, executions, validation),
      executions,
      classifications: classifications.filter((item) => item.caseId === testCase.id),
      repairs: caseRepairs,
    }
  })
  return {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    suiteId: suite.suiteId,
    target: structuredClone(suite.target),
    source: structuredClone(suite.source),
    generatedSpec: { file: sourceMap.generatedFile, sha256: sourceMap.generatedSha256 },
    integrity: {
      irSha256,
      sourceMapMatchesIr: true,
      assertionsImmutable: suite.cases.every((testCase) => testCase.assertions.every((assertion) => assertion.immutable === true)),
      repairBoundaryIntact: repairBoundaryIntact(input.repair),
    },
    summary: {
      total: cases.length,
      passed: cases.filter((item) => item.status === 'passed').length,
      failed: cases.filter((item) => item.status === 'failed').length,
      flaky: cases.filter((item) => item.status === 'flaky').length,
      skipped: cases.filter((item) => item.status === 'skipped').length,
      blocked: cases.filter((item) => item.status === 'blocked').length,
      notRun: cases.filter((item) => item.status === 'not_run').length,
      repaired: cases.filter((item) => item.repaired).length,
      classifications: classificationSummary(classifications),
    },
    cases,
  }
}
