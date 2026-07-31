import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { redactSensitiveContent } from '../input/text.js'
import { approveExploredWorkflowPlan, type WorkflowPlanExplorationReport } from './plan-exploration.js'
import type { WorkflowPlanDraft } from './planner-types.js'
import type { WorkflowExecutionPlan, WorkflowExecutionResult } from './runtime-types.js'
import { AutonomousWorkflowJobStore, createAutonomousJobState, transitionAutonomousJob } from './autonomy-state.js'
import {
  assessMutationRecovery,
  diagnoseExplorationFailure,
  diagnoseThrownError,
  diagnoseWorkflowResult,
} from './failure-diagnosis.js'
import { evaluateAutonomousPolicy } from './policy-gate.js'
import type {
  AutonomousWorkflowJobState,
  AutonomousWorkflowOperations,
  AutonomousWorkflowOutcome,
  AutonomousWorkflowPolicy,
  AutonomousWorkflowRunResult,
  WorkflowHumanInputQuestion,
  WorkflowHumanInputRequest,
} from './autonomy-types.js'

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

async function readJson<T>(path: string | undefined, label: string): Promise<T> {
  if (!path) throw new Error(`Autonomous job has no ${label} artifact`)
  return JSON.parse(await readFile(path, 'utf8')) as T
}

function safeMessage(error: unknown): string {
  return redactSensitiveContent(error instanceof Error ? error.message : String(error))
}

function terminalOutcomeFor(category: string): AutonomousWorkflowOutcome {
  return category === 'test_code' || category === 'product_defect' ? 'product_failed' : 'blocked'
}

function humanInputQuestions(
  draft: WorkflowPlanDraft | undefined,
  state: AutonomousWorkflowJobState,
  message: string,
): WorkflowHumanInputQuestion[] {
  const includeDraftAmbiguities = state.diagnosis?.category === 'data' || state.diagnosis?.category === 'policy'
  const reasons = [
    ...(includeDraftAmbiguities ? draft?.review.unresolvedAmbiguities ?? [] : []),
    ...(state.policyDecision?.reasons ?? []),
    ...(state.diagnosis ? [state.diagnosis.reason] : []),
    message,
  ].map((reason) => redactSensitiveContent(reason)).filter(Boolean)
  const sourceRefs = draft?.review.sourceRefs ?? []
  const matching = (pattern: RegExp) => reasons.filter((reason) => pattern.test(reason))
  const questions: WorkflowHumanInputQuestion[] = []
  const authorizationReasons = matching(/recovery|cleanup|rollback|delete|stop|destructive|authori[sz]|permission/i)
  if (authorizationReasons.length > 0) {
    questions.push({
      id: 'authorization.recovery-cleanup',
      kind: 'authorization',
      prompt: 'Specify the permitted recovery actions for entities created by this run, the target systems, and whether stop/delete actions are allowed only for current-run entities.',
      reasons: authorizationReasons,
      sourceRefs,
    })
  }
  const environmentAccessReasons = matching(/tenant.*disabled|租户已禁用|账号.*禁用|联系管理员|permission denied|visible application error while expected hidden/i)
  if (environmentAccessReasons.length > 0) {
    questions.push({
      id: 'authorization.environment-access',
      kind: 'authorization',
      prompt: 'Enable the target test tenant/account or register an approved account with access to this environment before resuming the workflow.',
      reasons: environmentAccessReasons,
      sourceRefs,
    })
  }
  const identifierReasons = matching(/fixed|identifier|already exists|\bexists\b|duplicate|baseline|precondition|conflict/i)
  if (identifierReasons.length > 0) {
    questions.push({
      id: 'business-rule.identifier-conflict',
      kind: 'business_rule',
      prompt: 'Define the required behavior when a fixed identifier already exists: fail, reuse the existing entity, or stop/delete it and recreate it.',
      reasons: identifierReasons,
      sourceRefs,
    })
  }
  const testDataReasons = matching(/missing required secret|unknown binding|verification code|\botp\b|credential|test data/i)
  if (testDataReasons.length > 0) {
    questions.push({
      id: 'test-data.private-input',
      kind: 'test_data',
      prompt: 'Supply the missing test data through the private environment vault or a registered secret reference. Do not include credentials or one-time codes in this request artifact.',
      reasons: testDataReasons,
      sourceRefs,
    })
  }
  const environmentOptionReasons = matching(/required option is unavailable in the current environment|available options/i)
  if (environmentOptionReasons.length > 0) {
    questions.push({
      id: 'test-data.environment-option',
      kind: 'test_data',
      prompt: 'Confirm the intended environment-specific option or provision the missing option, then register that value in the private case or environment context.',
      reasons: environmentOptionReasons,
      sourceRefs,
    })
  }
  return questions
}

async function blockForHumanInput(
  store: AutonomousWorkflowJobStore,
  state: AutonomousWorkflowJobState,
  outputDirectory: string,
  message: string,
): Promise<void> {
  let draft: WorkflowPlanDraft | undefined
  if (state.currentDraftPath) {
    try {
      draft = await readJson<WorkflowPlanDraft>(state.currentDraftPath, 'draft')
    } catch {
      // The blocking reason remains actionable even if an optional draft artifact is unavailable.
    }
  }
  const questions = humanInputQuestions(draft, state, message)
  if (questions.length > 0) {
    const request: WorkflowHumanInputRequest = {
      version: '1.0',
      kind: 'workflow-human-input-request',
      requestId: `${state.jobId}:input-${state.events.length + 1}`,
      jobId: state.jobId,
      ...(state.workflowId ? { workflowId: state.workflowId } : {}),
      ...(state.sourceSha256 ? { sourceSha256: state.sourceSha256 } : {}),
      status: 'pending',
      createdAt: new Date().toISOString(),
      blockedBy: redactSensitiveContent(message),
      questions,
      responseInstructions: [
        'Record approved permissions and business rules in the private environment profile context or registered case-input channel.',
        'After the input revision is registered, start a new autonomous run with the same Excel and target URLs. Do not hand-edit an Execution Plan.',
      ],
    }
    const path = resolve(outputDirectory, 'human-input-request.json')
    await writePrivateJson(path, request)
    state.humanInputRequestPath = path
  } else {
    delete state.humanInputRequestPath
  }
  await finish(store, state, 'blocked', message)
}

async function finish(
  store: AutonomousWorkflowJobStore,
  state: AutonomousWorkflowJobState,
  outcome: AutonomousWorkflowOutcome,
  message: string,
): Promise<void> {
  state.outcome = outcome
  state.status = outcome === 'blocked' ? 'blocked' : 'completed'
  transitionAutonomousJob(state, outcome === 'blocked' ? 'blocked' : 'completed', message)
  await store.save(state)
}

async function resultFromArtifacts(state: AutonomousWorkflowJobState): Promise<AutonomousWorkflowRunResult> {
  return {
    state,
    ...(state.currentDraftPath ? { draft: await readJson<WorkflowPlanDraft>(state.currentDraftPath, 'draft') } : {}),
    ...(state.currentExplorationPath ? { exploration: await readJson<WorkflowPlanExplorationReport>(state.currentExplorationPath, 'exploration') } : {}),
    ...(state.executionPlanPath ? { plan: await readJson<WorkflowExecutionPlan>(state.executionPlanPath, 'execution plan') } : {}),
    ...(state.runtimeResultPath ? { runtime: await readJson<WorkflowExecutionResult>(state.runtimeResultPath, 'runtime result') } : {}),
  }
}

export async function runAutonomousWorkflow(options: {
  outputDirectory: string
  requestSha256: string
  policy: AutonomousWorkflowPolicy
  operations: AutonomousWorkflowOperations
  jobStore?: AutonomousWorkflowJobStore
  resumeBlocked?: boolean
  resumeExhaustedTestCode?: boolean
}): Promise<AutonomousWorkflowRunResult> {
  await mkdir(options.outputDirectory, { recursive: true, mode: 0o750 })
  const store = options.jobStore ?? new AutonomousWorkflowJobStore(resolve(options.outputDirectory, 'autonomous-job.state.json'))
  let state = await store.load() ?? createAutonomousJobState(options.requestSha256)
  if (state.requestSha256 !== options.requestSha256) throw new Error('Autonomous job state belongs to a different workflow request')
  state.refinementBudgetCeiling ??= options.policy.maxRefinements
  if (
    state.status === 'running' &&
    state.stage === 'refining' &&
    state.runtimeResultPath &&
    state.currentExplorationPath?.includes('.runtime-feedback.') &&
    state.diagnosis?.action === 'refine'
  ) {
    const runtime = await readJson<WorkflowExecutionResult>(state.runtimeResultPath, 'runtime result')
    const revisedDiagnosis = diagnoseWorkflowResult(runtime)
    if (revisedDiagnosis.action === 'retry' && assessMutationRecovery(runtime).safeToRetry) {
      state.diagnosis = revisedDiagnosis
      state.environmentRetries = 0
      delete state.error
      transitionAutonomousJob(state, 'executing', 'Reclassified stale Runtime feedback as a retryable environment failure')
      await store.save(state)
    }
  }
  let blockedDiagnosis = state.error ? diagnoseThrownError(state.error) : state.diagnosis
  let preActionRecoveryIsSafe = false
  let blockedMutationRecoveryPending = false
  let blockedExplorationHadNoMutation = false
  let blockedPolicyRevisionIsSafe = false
  let blockedExploration: WorkflowPlanExplorationReport | undefined
  if (state.status === 'blocked' && state.currentExplorationPath) {
    blockedExploration = await readJson<WorkflowPlanExplorationReport>(state.currentExplorationPath, 'exploration')
    blockedExplorationHadNoMutation = !assessMutationRecovery(blockedExploration.runtimeResult).attempted
    blockedPolicyRevisionIsSafe = state.policyDecision?.status === 'blocked' &&
      blockedExploration.status === 'passed' &&
      blockedExploration.runtimeResult.status === 'passed' &&
      blockedExplorationHadNoMutation
    if (!blockedDiagnosis || blockedDiagnosis.category === 'unknown') blockedDiagnosis = diagnoseExplorationFailure(blockedExploration)
  }
  if (
    state.status === 'blocked' &&
    (blockedDiagnosis?.category === 'test_code' || blockedDiagnosis?.category === 'product_defect') &&
    blockedDiagnosis.action === 'refine' &&
    state.currentExplorationPath
  ) {
    const recovery = assessMutationRecovery(blockedExploration!.runtimeResult)
    preActionRecoveryIsSafe = recovery.attempted && recovery.safeToRetry
    blockedMutationRecoveryPending = recovery.attempted && !recovery.safeToRetry
  }
  if (
    options.resumeBlocked &&
    state.status === 'blocked' &&
    state.outcome === 'blocked' &&
    (
      (blockedDiagnosis?.category === 'environment' && blockedDiagnosis.action === 'retry') ||
      preActionRecoveryIsSafe ||
      blockedMutationRecoveryPending ||
      blockedPolicyRevisionIsSafe ||
      (Boolean(state.humanInputRequestPath) && blockedExplorationHadNoMutation)
    )
  ) {
    const resumableStages = new Set<AutonomousWorkflowJobState['stage']>(['planning', 'exploring', 'refining', 'policy_gate', 'executing'])
    const resumeStage = [...state.events].reverse().find((event) => resumableStages.has(event.stage))?.stage
    if (!resumeStage || !resumableStages.has(resumeStage)) throw new Error('Blocked autonomous job has no resumable stage')
    const resumedAfterHumanInput = Boolean(state.humanInputRequestPath) && blockedExplorationHadNoMutation
    state.status = 'running'
    state.stage = resumeStage
    state.environmentRetries = 0
    delete state.outcome
    delete state.error
    delete state.diagnosis
    delete state.humanInputRequestPath
    transitionAutonomousJob(
      state,
      resumeStage,
      blockedMutationRecoveryPending
        ? `Resuming blocked autonomous job from ${resumeStage} to retry declared mutation recovery`
        : preActionRecoveryIsSafe
          ? `Resuming blocked autonomous job from ${resumeStage} after pre-action mutation reclassification`
          : blockedPolicyRevisionIsSafe
            ? `Resuming blocked autonomous job from ${resumeStage} after a policy revision at a zero-mutation boundary`
          : resumedAfterHumanInput
            ? `Resuming blocked autonomous job from ${resumeStage} after a human-input or policy revision at a zero-mutation boundary`
            : `Resuming blocked autonomous job from ${resumeStage} after environment recovery`,
    )
    await store.save(state)
  }
  if (
    options.resumeExhaustedTestCode &&
    state.status === 'completed' &&
    state.outcome === 'product_failed' &&
    state.diagnosis?.category === 'test_code' &&
    state.diagnosis.action === 'refine' &&
    state.currentExplorationPath
  ) {
    const exploration = await readJson<WorkflowPlanExplorationReport>(state.currentExplorationPath, 'exploration')
    const recovery = assessMutationRecovery(exploration.runtimeResult)
    if (!recovery.safeToRetry) throw new Error('Exhausted test-code job cannot resume with unrecovered mutations')
    state.status = 'running'
    state.stage = 'refining'
    state.environmentRetries = 0
    state.refinementBudgetCeiling = Math.max(state.refinementBudgetCeiling, state.round) + options.policy.maxRefinements
    delete state.outcome
    delete state.error
    delete state.diagnosis
    transitionAutonomousJob(state, 'refining', `Resuming exhausted test-code job with bounded refinement ceiling ${state.refinementBudgetCeiling}`)
    await store.save(state)
  }
  if (state.status !== 'running') return resultFromArtifacts(state)

  for (let transition = 0; transition < 100 && state.status === 'running'; transition++) {
    const stageAtStart = state.stage
    try {
      if (state.stage === 'planning') {
        const draft = await options.operations.plan()
        const path = resolve(options.outputDirectory, 'round-0.plan-draft.json')
        await writePrivateJson(path, draft)
        state.currentDraftPath = path
        state.workflowId = draft.workflowId
        state.sourceSha256 = draft.sourceSha256
        state.environmentRetries = 0
        transitionAutonomousJob(state, 'exploring', 'Planner draft persisted; starting live exploration')
        await store.save(state)
        continue
      }

      if (state.stage === 'exploring') {
        const draft = await readJson<WorkflowPlanDraft>(state.currentDraftPath, 'draft')
        const previous = state.currentExplorationPath
          ? await readJson<WorkflowPlanExplorationReport>(state.currentExplorationPath, 'exploration')
          : undefined
        const exploration = await options.operations.explore(draft, state.round, previous)
        const path = resolve(options.outputDirectory, `round-${state.round}.exploration.json`)
        await writePrivateJson(path, exploration)
        state.currentExplorationPath = path
        if (exploration.status === 'passed') {
          state.environmentRetries = 0
          transitionAutonomousJob(state, 'policy_gate', 'Live exploration passed; evaluating autonomous approval policy')
          await store.save(state)
          continue
        }

        const diagnosis = diagnoseExplorationFailure(exploration)
        const recovery = assessMutationRecovery(exploration.runtimeResult)
        state.diagnosis = diagnosis
        if (recovery.attempted && !recovery.safeToRetry) {
          await blockForHumanInput(store, state, options.outputDirectory, `Exploration changed business state and automatic recovery did not complete: ${diagnosis.reason}`)
          continue
        }
        if (diagnosis.action === 'retry') {
          state.environmentRetries += 1
          if (state.environmentRetries <= options.policy.maxEnvironmentRetries) {
            transitionAutonomousJob(state, 'exploring', `Retrying exploration after environment failure (${state.environmentRetries}/${options.policy.maxEnvironmentRetries})`)
            await store.save(state)
            continue
          }
          await blockForHumanInput(store, state, options.outputDirectory, `Exploration environment retry budget exhausted: ${diagnosis.reason}`)
          continue
        }
        state.environmentRetries = 0
        if (diagnosis.action === 'block') {
          await blockForHumanInput(store, state, options.outputDirectory, diagnosis.reason)
          continue
        }
        if (state.round >= state.refinementBudgetCeiling) {
          await finish(store, state, terminalOutcomeFor(diagnosis.category), `Refinement budget exhausted: ${diagnosis.reason}`)
          continue
        }
        transitionAutonomousJob(state, 'refining', `Exploration failure classified as ${diagnosis.category}; starting protected refinement`)
        await store.save(state)
        continue
      }

      if (state.stage === 'refining') {
        const draft = await readJson<WorkflowPlanDraft>(state.currentDraftPath, 'draft')
        const exploration = await readJson<WorkflowPlanExplorationReport>(state.currentExplorationPath, 'exploration')
        const refined = await options.operations.refine(draft, exploration, state.round)
        state.round += 1
        const path = resolve(options.outputDirectory, `round-${state.round}.plan-draft.json`)
        await writePrivateJson(path, refined)
        state.currentDraftPath = path
        transitionAutonomousJob(state, 'exploring', `Refined draft ${state.round} persisted; restarting live exploration`)
        await store.save(state)
        continue
      }

      if (state.stage === 'policy_gate') {
        const draft = await readJson<WorkflowPlanDraft>(state.currentDraftPath, 'draft')
        const exploration = await readJson<WorkflowPlanExplorationReport>(state.currentExplorationPath, 'exploration')
        const decision = evaluateAutonomousPolicy(draft, exploration, options.policy)
        state.policyDecision = decision
        if (decision.status === 'blocked') {
          await blockForHumanInput(store, state, options.outputDirectory, `Autonomous policy blocked execution: ${decision.reasons.join('; ')}`)
          continue
        }
        const plan = approveExploredWorkflowPlan(draft, exploration, decision.reviewer)
        const path = resolve(options.outputDirectory, 'workflow.execution-plan.json')
        await writePrivateJson(path, plan)
        state.executionPlanPath = path
        transitionAutonomousJob(state, 'executing', `Execution Plan approved by ${decision.reviewer}`)
        await store.save(state)
        continue
      }

      if (state.stage === 'executing') {
        const plan = await readJson<WorkflowExecutionPlan>(state.executionPlanPath, 'execution plan')
        const attempt = state.activeExecutionAttempt ?? state.executionAttempts + 1
        state.activeExecutionAttempt = attempt
        state.executionAttempts = Math.max(state.executionAttempts, attempt)
        await store.save(state)
        const runtime = await options.operations.execute(plan, attempt)
        const path = resolve(options.outputDirectory, `runtime-attempt-${attempt}.result.json`)
        await writePrivateJson(path, runtime)
        delete state.activeExecutionAttempt
        state.runtimeResultPath = path
        if (runtime.status === 'passed') {
          state.environmentRetries = 0
          await finish(store, state, 'passed', 'Approved Runtime and final assertions passed')
          continue
        }
        const diagnosis = diagnoseWorkflowResult(runtime)
        const recovery = assessMutationRecovery(runtime)
        state.diagnosis = diagnosis
        if (recovery.attempted && !recovery.safeToRetry) {
          await blockForHumanInput(store, state, options.outputDirectory, `Runtime failed with unrecovered business mutations: ${diagnosis.reason}`)
          continue
        }
        if (diagnosis.action === 'retry') {
          state.environmentRetries += 1
          if (state.environmentRetries <= options.policy.maxEnvironmentRetries) {
            transitionAutonomousJob(state, 'executing', `Retrying Runtime after environment failure (${state.environmentRetries}/${options.policy.maxEnvironmentRetries})`)
            await store.save(state)
            continue
          }
          await blockForHumanInput(store, state, options.outputDirectory, `Runtime environment retry budget exhausted: ${diagnosis.reason}`)
          continue
        }
        state.environmentRetries = 0
        if (diagnosis.action === 'block') {
          await blockForHumanInput(store, state, options.outputDirectory, diagnosis.reason)
          continue
        }
        if (state.round >= state.refinementBudgetCeiling) {
          await finish(store, state, terminalOutcomeFor(diagnosis.category), `Runtime refinement budget exhausted: ${diagnosis.reason}`)
          continue
        }
        const previousExploration = await readJson<WorkflowPlanExplorationReport>(state.currentExplorationPath, 'exploration')
        const feedback: WorkflowPlanExplorationReport = {
          ...previousExploration,
          startedAt: runtime.startedAt,
          finishedAt: runtime.finishedAt,
          status: 'failed',
          runtimeResult: runtime,
        }
        const feedbackPath = resolve(options.outputDirectory, `round-${state.round}.runtime-feedback.exploration.json`)
        await writePrivateJson(feedbackPath, feedback)
        state.currentExplorationPath = feedbackPath
        transitionAutonomousJob(state, 'refining', 'Runtime failed after safe recovery; invalidating approval and refining from Runtime feedback')
        await store.save(state)
        continue
      }

      throw new Error(`Unsupported autonomous stage: ${state.stage}`)
    } catch (error) {
      const diagnosis = diagnoseThrownError(error)
      state.diagnosis = diagnosis
      state.error = safeMessage(error)
      if (diagnosis.action === 'retry') {
        state.environmentRetries += 1
        if (state.environmentRetries <= options.policy.maxEnvironmentRetries) {
          transitionAutonomousJob(state, stageAtStart, `Retrying ${stageAtStart} after transient failure (${state.environmentRetries}/${options.policy.maxEnvironmentRetries})`)
          await store.save(state)
          continue
        }
      }
      if (diagnosis.action === 'refine' && stageAtStart === 'refining') {
        if (state.round < state.refinementBudgetCeiling) {
          state.round += 1
          state.environmentRetries = 0
          delete state.error
          transitionAutonomousJob(state, 'refining', `Rejected invalid refined draft; retrying within refinement ceiling (${state.round}/${state.refinementBudgetCeiling})`)
          await store.save(state)
          continue
        }
        await finish(store, state, terminalOutcomeFor(diagnosis.category), `Refinement budget exhausted after invalid refined draft: ${diagnosis.reason}`)
        continue
      }
      await blockForHumanInput(store, state, options.outputDirectory, state.error)
    }
  }

  if (state.status === 'running') {
    state.status = 'failed'
    state.error = 'Autonomous controller exceeded its transition budget'
    transitionAutonomousJob(state, 'failed', state.error)
    await store.save(state)
  }
  return resultFromArtifacts(state)
}
