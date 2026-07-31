import type { WorkflowPlanExplorationReport } from './plan-exploration.js'
import type { WorkflowExecutionResult } from './runtime-types.js'
import type { MutationRecoveryAssessment, WorkflowFailureDiagnosis } from './autonomy-types.js'
import { isExternalModelServiceError } from './structured-model-cli.js'

export function isPreActionFailureMessage(message: string | undefined): boolean {
  return Boolean(message && /Locator resolver found no valid live element|AI locator .* remained invalid|No live table candidate found|Multiple live table candidates remain ambiguous|Unknown draft (?:locator|table) target/i.test(message))
}

function compensationFailedBeforeAction(result: WorkflowExecutionResult, mutationId: string): boolean {
  const mutation = [...result.mutations].reverse().find((event) => event.mutationId === mutationId && event.status === 'compensation_failed')
  if (!mutation || !isPreActionFailureMessage(mutation.error)) return false
  const sourcePhase = [...result.phases].reverse().find((event) =>
    event.groupId === mutation.groupId &&
    event.phaseId === mutation.phaseId &&
    event.iteration === mutation.iteration &&
    event.status === 'failed',
  )
  const sourceStep = [...result.steps].reverse().find((event) =>
    event.groupId === mutation.groupId &&
    event.phaseId === mutation.phaseId &&
    event.iteration === mutation.iteration &&
    event.status === 'failed',
  )
  const recovery = [...result.recoveries].reverse().find((event) =>
    event.mutationId === mutationId && event.status === 'failed',
  )
  return isPreActionFailureMessage(sourcePhase?.error) &&
    isPreActionFailureMessage(sourceStep?.error) &&
    isPreActionFailureMessage(recovery?.error)
}

export function assessMutationRecovery(result: WorkflowExecutionResult): MutationRecoveryAssessment {
  const latest = new Map<string, WorkflowExecutionResult['mutations'][number]>()
  for (const event of result.mutations) latest.set(`${event.groupId}:${event.iteration ?? 'single'}:${event.phaseId}`, event)
  const values = [...latest.values()]
  const passedPhases = new Set(result.phases.filter((phase) => phase.status === 'passed').map((phase) => (
    `${phase.groupId}:${phase.iteration ?? 'single'}:${phase.phaseId}`
  )))
  const outstanding = values.filter((event) => {
    if (event.status === 'started' && passedPhases.has(`${event.groupId}:${event.iteration ?? 'single'}:${event.phaseId}`)) return false
    return ['started', 'committed', 'failed', 'interrupted', 'compensation_started'].includes(event.status)
  })
  const failed = values.filter((event) => event.status === 'compensation_failed' && !compensationFailedBeforeAction(result, event.mutationId))
  return {
    attempted: result.mutations.some((event) => event.status === 'started'),
    safeToRetry: outstanding.length === 0 && failed.length === 0,
    outstandingMutationIds: outstanding.map((event) => event.mutationId),
    failedMutationIds: failed.map((event) => event.mutationId),
  }
}

function diagnoseMessage(message: string): WorkflowFailureDiagnosis {
  if (isExternalModelServiceError(message)) {
    return { category: 'environment', action: 'retry', confidence: 'high', reason: message }
  }
  if (/login page|login route|登录页|认证.*(?:过期|失效)|session.*expired|unauthenticated/i.test(message)) {
    return { category: 'environment', action: 'retry', confidence: 'high', reason: message }
  }
  if (/explicit approval|blocked by workflow policy|origin violation|allowedOrigins/i.test(message)) {
    return { category: 'policy', action: 'block', confidence: 'high', reason: message }
  }
  if (/missing required secret|unknown binding|not a list|iteration offset|no autonomous recovery contract/i.test(message)) {
    return { category: 'data', action: 'block', confidence: 'high', reason: message }
  }
  if (/required option is unavailable in the current environment|available options/i.test(message)) {
    return { category: 'data', action: 'block', confidence: 'high', reason: message }
  }
  if (/visible application error while expected hidden|tenant.*disabled|租户已禁用|账号.*禁用|联系管理员|permission denied/i.test(message)) {
    return { category: 'policy', action: 'block', confidence: 'high', reason: message }
  }
  if (/ERR_|ECONN|browser.*closed|navigation|timed out after|timeout.*model|session.*expired/i.test(message)) {
    return { category: 'environment', action: 'retry', confidence: 'medium', reason: message }
  }
  if (/application error after step.*(?:验证码错误|captcha.*(?:incorrect|invalid)|invalid captcha)/i.test(message)) {
    return { category: 'environment', action: 'retry', confidence: 'high', reason: message }
  }
  if (/application error after step/i.test(message)) {
    return { category: 'test_code', action: 'refine', confidence: 'high', reason: message }
  }
  if (/invalid workflow (?:execution )?plan|invalid workflow plan draft|references entity before capture/i.test(message)) {
    return { category: 'test_code', action: 'refine', confidence: 'high', reason: message }
  }
  if (/did not|expected|assertion|failedStart|matching table row count|locator count/i.test(message)) {
    return { category: 'product_defect', action: 'refine', confidence: 'medium', reason: message }
  }
  if (/locator|strict mode|click|fill|select|table|element|phase timed out|recovery phase/i.test(message)) {
    return { category: 'test_code', action: 'refine', confidence: 'medium', reason: message }
  }
  return { category: 'unknown', action: 'block', confidence: 'low', reason: message || 'Unknown workflow failure' }
}

export function diagnoseWorkflowResult(result: WorkflowExecutionResult): WorkflowFailureDiagnosis {
  const failedPhase = [...result.phases].reverse().find((phase) => phase.status === 'failed')
  if (
    failedPhase &&
    /(?:^|[^a-z])(?:login|sign[ -]?in|auth(?:entication)?)(?:[^a-z]|$)|登录|认证/i.test(`${failedPhase.phaseId} ${failedPhase.title}`) &&
    /locator is not (?:visible|hidden)|login page|login route|登录页|验证码错误|captcha/i.test(`${failedPhase.error ?? ''} ${result.error ?? ''}`)
  ) {
    return {
      category: 'environment',
      action: 'retry',
      confidence: 'high',
      reason: result.error ?? failedPhase.error ?? 'Authentication phase failed transiently',
    }
  }
  return diagnoseMessage(result.error ?? 'Workflow failed without an error message')
}

export function diagnoseExplorationFailure(report: WorkflowPlanExplorationReport): WorkflowFailureDiagnosis {
  const runtimeDiagnosis = diagnoseWorkflowResult(report.runtimeResult)
  if (runtimeDiagnosis.category === 'environment' || ['policy', 'data'].includes(runtimeDiagnosis.category)) return runtimeDiagnosis
  if (report.unresolvedTargetIds.length > 0 || report.unresolvedTableIds.length > 0) {
    return {
      category: 'test_code',
      action: 'refine',
      confidence: 'high',
      reason: `Exploration has ${report.unresolvedTargetIds.length} unresolved locators and ${report.unresolvedTableIds.length} unresolved tables`,
    }
  }
  if (runtimeDiagnosis.action === 'block') return runtimeDiagnosis
  return runtimeDiagnosis
}

export function diagnoseThrownError(error: unknown): WorkflowFailureDiagnosis {
  return diagnoseMessage(error instanceof Error ? error.message : String(error))
}
