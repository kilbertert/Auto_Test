import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAutonomousWorkflow } from '../src/workflow/autonomous-controller.js'
import type { AutonomousWorkflowPolicy } from '../src/workflow/autonomy-types.js'
import type { WorkflowPlanExplorationReport } from '../src/workflow/plan-exploration.js'
import type { WorkflowPlanDraft } from '../src/workflow/planner-types.js'
import { workflowDraftSha256 } from '../src/workflow/planner-validation.js'
import { diagnoseExplorationFailure, diagnoseThrownError, diagnoseWorkflowResult } from '../src/workflow/failure-diagnosis.js'
import type { WorkflowExecutionResult } from '../src/workflow/runtime-types.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function outputDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-autonomy-'))
  temporaryDirectories.push(directory)
  return directory
}

function draft(): WorkflowPlanDraft {
  return {
    version: '1.0',
    kind: 'workflow-plan-draft',
    workflowId: 'autonomous-fixture',
    sourceSha256: 'a'.repeat(64),
    targets: [{ id: 'app', baseUrl: 'https://app.example.test/', allowedOrigins: ['https://app.example.test/'] }],
    dataBindings: [],
    groups: [{
      id: 'single',
      phases: [{
        id: 'open-app',
        title: 'open app',
        targetId: 'app',
        risk: 'read',
        contextMode: 'shared',
        sourceRefs: ['cell:A2'],
        steps: [{ id: 'open', kind: 'navigate', sourceRefs: ['cell:A2'] }],
        assertions: [{ id: 'url-ok', kind: 'url', operator: 'contains', expected: { literal: 'app.example.test' }, sourceRefs: ['cell:B2'] }],
      }],
    }],
    policy: { phaseTimeoutMs: 10_000, actionTimeoutMs: 1_000, destructiveActions: 'requireApproval' },
    review: { status: 'draft', sourceRefs: ['source:fixture'], unresolvedAmbiguities: [] },
    planner: {
      provider: 'fixture',
      model: null,
      generatedAt: '2026-07-29T00:00:00.000Z',
      inputSha256: 'b'.repeat(64),
      imageSha256s: [],
      summary: [],
    },
  }
}

function runtime(status: 'passed' | 'failed', error?: string): WorkflowExecutionResult {
  return {
    version: '1.0',
    workflowId: 'autonomous-fixture',
    sourceSha256: 'a'.repeat(64),
    planSha256: 'c'.repeat(64),
    runId: 'run-fixture',
    startedAt: '2026-07-29T00:00:00.000Z',
    finishedAt: '2026-07-29T00:00:01.000Z',
    status,
    phases: [],
    steps: [],
    assertions: [],
    entityCaptures: [],
    mutations: [],
    recoveries: [],
    entities: {},
    ...(error ? { error } : {}),
  }
}

function exploration(input: WorkflowPlanDraft, status: 'passed' | 'failed', result: WorkflowExecutionResult): WorkflowPlanExplorationReport {
  return {
    version: '1.0',
    kind: 'workflow-plan-exploration',
    workflowId: input.workflowId,
    sourceSha256: input.sourceSha256,
    draftSha256: workflowDraftSha256(input),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    status,
    runtimeResult: result,
    locatorResolutions: [],
    tableResolutions: [],
    unresolvedTargetIds: [],
    unresolvedTableIds: [],
  }
}

const policy: AutonomousWorkflowPolicy = {
  id: 'fixture-policy',
  autoApprove: true,
  allowedRisks: ['read'],
  requireRecoveryFor: ['write', 'destructive'],
  maxRefinements: 2,
  maxEnvironmentRetries: 1,
}

describe('autonomous workflow controller', () => {
  it('classifies an expired login page as environment recovery rather than plan refinement', () => {
    expect(diagnoseThrownError(new Error('当前页面为登录页；没有设备入口'))).toMatchObject({
      category: 'environment',
      action: 'retry',
      confidence: 'high',
    })
  })

  it('does not let unresolved future locators hide a blocking runtime contract failure', () => {
    const report = exploration(draft(), 'failed', runtime('failed', 'Phase create-device has no autonomous recovery contract'))
    report.unresolvedTargetIds = ['future-page-control']

    expect(diagnoseExplorationFailure(report)).toMatchObject({
      category: 'data',
      action: 'block',
      confidence: 'high',
    })
  })

  it('classifies unresolved exploration tables as test code when runtime itself passed', () => {
    const report = exploration(draft(), 'failed', runtime('passed'))
    report.unresolvedTableIds = ['conditional-cleanup:actionTable']

    expect(diagnoseExplorationFailure(report)).toMatchObject({
      category: 'test_code',
      action: 'refine',
      confidence: 'high',
    })
  })

  it('classifies a step-attributed application validation error as refinable test code', () => {
    expect(diagnoseThrownError(new Error('Application error after step request-code: incorrect number format'))).toMatchObject({
      category: 'test_code',
      action: 'refine',
      confidence: 'high',
    })
  })

  it('classifies a rejected graphical captcha as a retryable environment failure', () => {
    expect(diagnoseThrownError(new Error('Application error after step login-submit: 验证码错误'))).toMatchObject({
      category: 'environment',
      action: 'retry',
      confidence: 'high',
    })
  })

  it('classifies a transient assertion failure in an authentication phase as an environment retry', () => {
    const result = runtime('failed', 'Locator is not visible')
    result.phases = [{
      groupId: 'single',
      phaseId: 'login-admin',
      iteration: null,
      attempt: 1,
      title: 'Log in to admin',
      targetId: 'app',
      contextMode: 'shared',
      status: 'failed',
      durationMs: 1,
      error: 'Locator is not visible',
    }]

    expect(diagnoseWorkflowResult(result)).toMatchObject({
      category: 'environment',
      action: 'retry',
      confidence: 'high',
    })
  })

  it('classifies invalid refined plans as refinable test code', () => {
    expect(diagnoseThrownError(new Error('Invalid workflow execution plan: check-name references entity before capture: device'))).toMatchObject({
      category: 'test_code',
      action: 'refine',
      confidence: 'high',
    })
  })

  it('classifies a missing environment option as blocking test data', () => {
    expect(diagnoseThrownError(new Error('Required option is unavailable in the current environment: expected "Required Type"; available options ["Type A"]'))).toMatchObject({
      category: 'data',
      action: 'block',
      confidence: 'high',
    })
  })

  it('classifies a disabled tenant as blocking environment authorization', () => {
    expect(diagnoseThrownError(new Error('Visible application error while expected hidden assertion login-complete: 对不起，您的租户已禁用，请联系管理员'))).toMatchObject({
      category: 'policy',
      action: 'block',
      confidence: 'high',
    })
  })

  it('classifies model capacity exhaustion as a retryable environment failure', () => {
    expect(diagnoseThrownError(new Error("You've hit your usage limit. Try again later."))).toMatchObject({
      category: 'environment',
      action: 'retry',
      confidence: 'high',
    })
  })

  it('resumes the last active stage of a blocked environment job when enabled', async () => {
    const directory = await outputDirectory()
    const storePath = resolve(directory, 'autonomous-job.state.json')
    const initial = draft()
    const state = {
      version: '1.0',
      jobId: 'blocked-job',
      requestSha256: 'd'.repeat(64),
      status: 'blocked',
      stage: 'blocked',
      round: 0,
      environmentRetries: 2,
      executionAttempts: 0,
      outcome: 'blocked',
      diagnosis: { category: 'unknown', action: 'block', confidence: 'low', reason: 'stale diagnosis' },
      error: 'Claude fallback command exited with 1: API Error: Content block is not a thinking block',
      events: [
        { sequence: 1, at: '2026-07-29T00:00:00.000Z', stage: 'planning', message: 'created' },
        { sequence: 2, at: '2026-07-29T00:00:01.000Z', stage: 'blocked', message: 'capacity' },
      ],
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:01.000Z',
    }
    await writeFile(storePath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    const result = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256: state.requestSha256,
      policy,
      resumeBlocked: true,
      operations: {
        plan: async () => initial,
        explore: async (value) => exploration(value, 'passed', runtime('passed')),
        refine: async () => initial,
        execute: async () => runtime('passed'),
      },
    })

    expect(result.state).toMatchObject({ status: 'completed', outcome: 'passed', environmentRetries: 0 })
    expect(result.state.events).toContainEqual(expect.objectContaining({
      stage: 'planning',
      message: expect.stringContaining('Resuming blocked autonomous job'),
    }))
  })

  it('bounds consecutive exploration environment retries without invoking the Refiner', async () => {
    const directory = await outputDirectory()
    const initial = draft()
    const explore = vi.fn(async (value: WorkflowPlanDraft) => exploration(
      value,
      'failed',
      runtime('failed', '当前页面为登录页；没有设备入口'),
    ))
    const refine = vi.fn(async () => initial)

    const result = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256: 'd'.repeat(64),
      policy,
      operations: {
        plan: async () => initial,
        explore,
        refine,
        execute: async () => runtime('passed'),
      },
    })

    expect(result.state).toMatchObject({ status: 'blocked', outcome: 'blocked', environmentRetries: 2 })
    expect(result.state.events).toContainEqual(expect.objectContaining({
      stage: 'exploring',
      message: 'Retrying exploration after environment failure (1/1)',
    }))
    expect(result.state.events.at(-1)?.message).toContain('Exploration environment retry budget exhausted')
    expect(explore).toHaveBeenCalledTimes(2)
    expect(refine).not.toHaveBeenCalled()
  })

  it('bounds consecutive Runtime environment retries without invoking the Refiner', async () => {
    const directory = await outputDirectory()
    const initial = draft()
    const refine = vi.fn(async () => initial)
    const execute = vi.fn(async () => runtime('failed', '当前页面为登录页；没有设备入口'))

    const result = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256: 'd'.repeat(64),
      policy,
      operations: {
        plan: async () => initial,
        explore: async (value) => exploration(value, 'passed', runtime('passed')),
        refine,
        execute,
      },
    })

    expect(result.state).toMatchObject({
      status: 'blocked',
      outcome: 'blocked',
      environmentRetries: 2,
      executionAttempts: 2,
    })
    expect(result.state.events).toContainEqual(expect.objectContaining({
      stage: 'executing',
      message: 'Retrying Runtime after environment failure (1/1)',
    }))
    expect(result.state.events.at(-1)?.message).toContain('Runtime environment retry budget exhausted')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(refine).not.toHaveBeenCalled()
  })

  it('reevaluates a blocked Policy Gate after a zero-mutation policy revision', async () => {
    const directory = await outputDirectory()
    const initial = draft()
    const requestSha256 = 'd'.repeat(64)
    const operations = {
      plan: async () => initial,
      explore: async (value: WorkflowPlanDraft) => exploration(value, 'passed', runtime('passed')),
      refine: async () => initial,
      execute: async () => runtime('passed'),
    }

    const blocked = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256,
      policy: { ...policy, autoApprove: false },
      operations,
    })
    expect(blocked.state).toMatchObject({ status: 'blocked', outcome: 'blocked' })
    expect(blocked.state.policyDecision?.reasons).toContain('Policy does not allow automatic approval')
    expect(blocked.state.humanInputRequestPath).toBeUndefined()

    const resumed = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256,
      policy,
      operations,
      resumeBlocked: true,
    })

    expect(resumed.state).toMatchObject({ status: 'completed', outcome: 'passed' })
    expect(resumed.state.events).toContainEqual(expect.objectContaining({
      stage: 'policy_gate',
      message: expect.stringContaining('policy revision at a zero-mutation boundary'),
    }))
  })

  it('reclassifies stale Runtime feedback before invoking the Refiner', async () => {
    const directory = await outputDirectory()
    const requestSha256 = 'd'.repeat(64)
    const initial = draft()
    const failedRuntime = runtime('failed', 'Locator is not visible')
    failedRuntime.phases = [{
      groupId: 'single', phaseId: 'login-admin', iteration: null, attempt: 1, title: 'Log in to admin',
      targetId: 'app', contextMode: 'shared', status: 'failed', durationMs: 1, error: 'Locator is not visible',
    }]
    const execute = vi.fn()
      .mockResolvedValueOnce(failedRuntime)
      .mockResolvedValueOnce(runtime('passed'))
    const operations = {
      plan: async () => initial,
      explore: async (value: WorkflowPlanDraft) => exploration(value, 'passed', runtime('passed')),
      refine: vi.fn(async () => initial),
      execute,
    }

    const blocked = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256,
      policy: { ...policy, maxEnvironmentRetries: 0 },
      operations,
    })
    expect(blocked.state).toMatchObject({ status: 'blocked', outcome: 'blocked', executionAttempts: 1 })

    const feedbackPath = resolve(directory, 'round-0.runtime-feedback.exploration.json')
    await writeFile(feedbackPath, `${JSON.stringify(exploration(initial, 'failed', failedRuntime))}\n`, { mode: 0o640 })
    const storePath = resolve(directory, 'autonomous-job.state.json')
    const stale = JSON.parse(await readFile(storePath, 'utf8')) as Record<string, unknown>
    stale.status = 'running'
    stale.stage = 'refining'
    stale.currentExplorationPath = feedbackPath
    stale.diagnosis = { category: 'test_code', action: 'refine', confidence: 'medium', reason: 'Locator is not visible' }
    delete stale.outcome
    delete stale.humanInputRequestPath
    await writeFile(storePath, `${JSON.stringify(stale)}\n`, { mode: 0o600 })

    const resumed = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256,
      policy,
      operations,
    })

    expect(resumed.state).toMatchObject({ status: 'completed', outcome: 'passed', executionAttempts: 2 })
    expect(resumed.state.events).toContainEqual(expect.objectContaining({
      stage: 'executing',
      message: 'Reclassified stale Runtime feedback as a retryable environment failure',
    }))
    expect(operations.refine).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('resumes a legacy blocked job when both source and compensation failed before their actions', async () => {
    const directory = await outputDirectory()
    const storePath = resolve(directory, 'autonomous-job.state.json')
    const draftPath = resolve(directory, 'round-0.plan-draft.json')
    const explorationPath = resolve(directory, 'round-0.exploration.json')
    const initial = draft()
    const message = 'Locator resolver found no valid live element: synthetic switch is not actionable'
    const failed = runtime('failed', `${message}; automatic recovery failed: ${message}`)
    failed.phases = [{
      groupId: 'single', phaseId: 'open-app', iteration: null, attempt: 1, title: 'open app',
      targetId: 'app', contextMode: 'shared', status: 'failed', durationMs: 1, error: message,
    }]
    failed.steps = [{
      groupId: 'single', phaseId: 'open-app', iteration: null, stepId: 'open', attempt: 1,
      status: 'failed', durationMs: 1, error: message,
    }]
    failed.mutations = [
      { mutationId: 'single:single:open-app:1', groupId: 'single', phaseId: 'open-app', iteration: null, attempt: 1, risk: 'write', status: 'started', recordedAt: '2026-07-29T00:00:00.000Z' },
      { mutationId: 'single:single:open-app:1', groupId: 'single', phaseId: 'open-app', iteration: null, attempt: 1, risk: 'write', status: 'failed', recordedAt: '2026-07-29T00:00:01.000Z', error: message },
      { mutationId: 'single:single:open-app:1', groupId: 'single', phaseId: 'open-app', iteration: null, attempt: 1, risk: 'write', status: 'compensation_started', recordedAt: '2026-07-29T00:00:02.000Z' },
      { mutationId: 'single:single:open-app:1', groupId: 'single', phaseId: 'open-app', iteration: null, attempt: 1, risk: 'write', status: 'compensation_failed', recordedAt: '2026-07-29T00:00:03.000Z', error: `Recovery phase cleanup failed: ${message}` },
    ]
    failed.recoveries = [{
      mutationId: 'single:single:open-app:1', groupId: 'single', sourcePhaseId: 'open-app',
      recoveryPhaseId: 'cleanup', iteration: null, attempt: 1, status: 'failed', durationMs: 1, error: message,
    }]
    const priorExploration = exploration(initial, 'failed', failed)
    priorExploration.unresolvedTargetIds = ['open']
    await writeFile(draftPath, `${JSON.stringify(initial)}\n`, { mode: 0o640 })
    await writeFile(explorationPath, `${JSON.stringify(priorExploration)}\n`, { mode: 0o640 })
    const state = {
      version: '1.0', jobId: 'legacy-pre-action-job', requestSha256: 'd'.repeat(64), status: 'blocked', stage: 'blocked',
      round: 0, environmentRetries: 0, executionAttempts: 0, outcome: 'blocked', currentDraftPath: draftPath,
      currentExplorationPath: explorationPath,
      diagnosis: { category: 'test_code', action: 'refine', confidence: 'high', reason: 'unresolved locator' },
      events: [
        { sequence: 1, at: '2026-07-29T00:00:00.000Z', stage: 'planning', message: 'created' },
        { sequence: 2, at: '2026-07-29T00:00:01.000Z', stage: 'exploring', message: 'exploring' },
        { sequence: 3, at: '2026-07-29T00:00:02.000Z', stage: 'blocked', message: 'automatic recovery did not complete' },
      ],
      createdAt: '2026-07-29T00:00:00.000Z', updatedAt: '2026-07-29T00:00:02.000Z',
    }
    await writeFile(storePath, `${JSON.stringify(state)}\n`, { mode: 0o600 })

    const result = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256: state.requestSha256,
      policy,
      resumeBlocked: true,
      operations: {
        plan: async () => initial,
        explore: async (value) => exploration(value, 'passed', runtime('passed')),
        refine: async () => initial,
        execute: async () => runtime('passed'),
      },
    })

    expect(result.state).toMatchObject({ status: 'completed', outcome: 'passed' })
    expect(result.state.events).toContainEqual(expect.objectContaining({
      stage: 'exploring',
      message: expect.stringContaining('pre-action mutation reclassification'),
    }))
  })

  it('opens a bounded refinement window for an exhausted test-code job after safe recovery', async () => {
    const directory = await outputDirectory()
    const storePath = resolve(directory, 'autonomous-job.state.json')
    const draftPath = resolve(directory, 'round-12.plan-draft.json')
    const explorationPath = resolve(directory, 'round-12.exploration.json')
    const initial = draft()
    const failed = runtime('failed', 'Locator text did not contain expected text')
    failed.mutations = [{
      mutationId: 'single:single:open-app:1',
      groupId: 'single',
      phaseId: 'open-app',
      iteration: null,
      attempt: 1,
      risk: 'write',
      status: 'retry_ready',
      recordedAt: '2026-07-29T00:00:01.000Z',
    }]
    const priorExploration = exploration(initial, 'failed', failed)
    priorExploration.unresolvedTargetIds = ['open']
    await writeFile(draftPath, `${JSON.stringify(initial)}\n`, { mode: 0o640 })
    await writeFile(explorationPath, `${JSON.stringify(priorExploration)}\n`, { mode: 0o640 })
    const state = {
      version: '1.0', jobId: 'exhausted-test-code-job', requestSha256: 'd'.repeat(64),
      status: 'completed', stage: 'completed', round: 12, refinementBudgetCeiling: 12,
      environmentRetries: 0, executionAttempts: 0, outcome: 'product_failed',
      currentDraftPath: draftPath, currentExplorationPath: explorationPath,
      diagnosis: { category: 'test_code', action: 'refine', confidence: 'high', reason: 'unresolved locator' },
      events: [
        { sequence: 1, at: '2026-07-29T00:00:00.000Z', stage: 'planning', message: 'created' },
        { sequence: 2, at: '2026-07-29T00:00:01.000Z', stage: 'completed', message: 'budget exhausted' },
      ],
      createdAt: '2026-07-29T00:00:00.000Z', updatedAt: '2026-07-29T00:00:01.000Z',
    }
    await writeFile(storePath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    const resumedPolicy: AutonomousWorkflowPolicy = { ...policy, maxRefinements: 12 }
    const plan = vi.fn(async () => initial)
    const refine = vi.fn(async () => initial)

    const result = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256: state.requestSha256,
      policy: resumedPolicy,
      resumeExhaustedTestCode: true,
      operations: {
        plan,
        explore: async (value) => exploration(value, 'passed', runtime('passed')),
        refine,
        execute: async () => runtime('passed'),
      },
    })

    expect(result.state).toMatchObject({
      status: 'completed',
      outcome: 'passed',
      round: 13,
      refinementBudgetCeiling: 24,
    })
    expect(result.state.events).toContainEqual(expect.objectContaining({
      stage: 'refining',
      message: 'Resuming exhausted test-code job with bounded refinement ceiling 24',
    }))
    expect(plan).not.toHaveBeenCalled()
    expect(refine).toHaveBeenCalledTimes(1)
  })

  it('refuses to resume an exhausted test-code job with an unrecovered mutation', async () => {
    const directory = await outputDirectory()
    const storePath = resolve(directory, 'autonomous-job.state.json')
    const draftPath = resolve(directory, 'round-12.plan-draft.json')
    const explorationPath = resolve(directory, 'round-12.exploration.json')
    const initial = draft()
    const failed = runtime('failed', 'Locator text did not contain expected text')
    failed.mutations = [{
      mutationId: 'single:single:open-app:1',
      groupId: 'single',
      phaseId: 'open-app',
      iteration: null,
      attempt: 1,
      risk: 'write',
      status: 'failed',
      recordedAt: '2026-07-29T00:00:01.000Z',
    }]
    const priorExploration = exploration(initial, 'failed', failed)
    priorExploration.unresolvedTargetIds = ['open']
    await writeFile(draftPath, `${JSON.stringify(initial)}\n`, { mode: 0o640 })
    await writeFile(explorationPath, `${JSON.stringify(priorExploration)}\n`, { mode: 0o640 })
    const state = {
      version: '1.0', jobId: 'unsafe-exhausted-test-code-job', requestSha256: 'd'.repeat(64),
      status: 'completed', stage: 'completed', round: 12, refinementBudgetCeiling: 12,
      environmentRetries: 0, executionAttempts: 0, outcome: 'product_failed',
      currentDraftPath: draftPath, currentExplorationPath: explorationPath,
      diagnosis: { category: 'test_code', action: 'refine', confidence: 'high', reason: 'unresolved locator' },
      events: [
        { sequence: 1, at: '2026-07-29T00:00:00.000Z', stage: 'planning', message: 'created' },
        { sequence: 2, at: '2026-07-29T00:00:01.000Z', stage: 'completed', message: 'budget exhausted' },
      ],
      createdAt: '2026-07-29T00:00:00.000Z', updatedAt: '2026-07-29T00:00:01.000Z',
    }
    await writeFile(storePath, `${JSON.stringify(state)}\n`, { mode: 0o600 })

    await expect(runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256: state.requestSha256,
      policy: { ...policy, maxRefinements: 12 },
      resumeExhaustedTestCode: true,
      operations: {
        plan: async () => initial,
        explore: async (value) => exploration(value, 'passed', runtime('passed')),
        refine: async () => initial,
        execute: async () => runtime('passed'),
      },
    })).rejects.toThrow('Exhausted test-code job cannot resume with unrecovered mutations')

    expect(JSON.parse(await readFile(storePath, 'utf8'))).toMatchObject({
      status: 'completed',
      outcome: 'product_failed',
      round: 12,
      refinementBudgetCeiling: 12,
    })
  })

  it('persists and completes exploration, protected refinement, policy approval and Runtime', async () => {
    const directory = await outputDirectory()
    const initial = draft()
    const refined = structuredClone(initial)
    refined.planner.generatedAt = '2026-07-29T00:01:00.000Z'
    refined.planner.summary.push('Refined synthetic locator timing')
    const explore = vi.fn(async (value: WorkflowPlanDraft, round: number) => round === 0
      ? exploration(value, 'failed', runtime('failed', 'locator did not match expected element'))
      : exploration(value, 'passed', runtime('passed')))
    const refine = vi.fn(async () => refined)
    const execute = vi.fn(async () => runtime('passed'))

    const result = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256: 'd'.repeat(64),
      policy,
      operations: { plan: async () => initial, explore, refine, execute },
    })

    expect(result.state).toMatchObject({ status: 'completed', outcome: 'passed', stage: 'completed', round: 1, executionAttempts: 1 })
    expect(explore).toHaveBeenCalledTimes(2)
    expect(refine).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.plan?.review.reviewedBy).toBe('policy:fixture-policy')
    expect((await stat(resolve(directory, 'autonomous-job.state.json'))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(resolve(directory, 'autonomous-job.state.json'), 'utf8')).outcome).toBe('passed')
  })

  it('blocks immediately when a failed exploration leaves an unrecovered mutation', async () => {
    const directory = await outputDirectory()
    const input = draft()
    const failed = runtime('failed', 'click failed after mutation')
    failed.mutations = [
      {
        mutationId: 'single:single:mutate:1',
        groupId: 'single',
        phaseId: 'mutate',
        iteration: null,
        attempt: 1,
        risk: 'destructive',
        status: 'started',
        recordedAt: '2026-07-29T00:00:00.000Z',
      },
      {
        mutationId: 'single:single:mutate:1',
        groupId: 'single',
        phaseId: 'mutate',
        iteration: null,
        attempt: 1,
        risk: 'destructive',
        status: 'failed',
        recordedAt: '2026-07-29T00:00:01.000Z',
      },
    ]
    const refine = vi.fn(async () => input)

    const result = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256: 'd'.repeat(64),
      policy,
      operations: {
        plan: async () => input,
        explore: async (value) => exploration(value, 'failed', failed),
        refine,
        execute: async () => runtime('passed'),
      },
    })

    expect(result.state).toMatchObject({ status: 'blocked', outcome: 'blocked', stage: 'blocked' })
    expect(result.state.events.at(-1)?.message).toContain('automatic recovery did not complete')
    expect(refine).not.toHaveBeenCalled()
    await expect(access(resolve(directory, 'workflow.execution-plan.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('blocks policy approval for a write phase without a recovery contract', async () => {
    const directory = await outputDirectory()
    const input = draft()
    input.groups[0]!.phases[0]!.risk = 'write'
    const writePolicy: AutonomousWorkflowPolicy = { ...policy, allowedRisks: ['read', 'write'] }

    const result = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256: 'd'.repeat(64),
      policy: writePolicy,
      operations: {
        plan: async () => input,
        explore: async (value) => exploration(value, 'passed', runtime('passed')),
        refine: async () => input,
        execute: async () => runtime('passed'),
      },
    })

    expect(result.state).toMatchObject({ status: 'blocked', outcome: 'blocked' })
    expect(result.state.policyDecision?.reasons).toContain('Phase open-app has no recovery contract')
  })

  it('writes a structured human-input request when business recovery authority is missing', async () => {
    const directory = await outputDirectory()
    const input = draft()
    input.groups[0]!.phases[0]!.risk = 'write'
    input.review.unresolvedAmbiguities = [
      'The fixed identifier may already exist and no baseline is provided.',
      'No stop, delete, or cleanup authority is provided for current-run entities.',
    ]
    const failed = runtime('failed', 'Phase open-app has no autonomous recovery contract')

    const result = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256: 'd'.repeat(64),
      policy: { ...policy, allowedRisks: ['read', 'write'] },
      operations: {
        plan: async () => input,
        explore: async (value) => exploration(value, 'failed', failed),
        refine: async () => input,
        execute: async () => runtime('passed'),
      },
    })

    expect(result.state.humanInputRequestPath).toBe(resolve(directory, 'human-input-request.json'))
    const request = JSON.parse(await readFile(result.state.humanInputRequestPath!, 'utf8')) as { questions: Array<{ id: string }>; status: string }
    expect(request.status).toBe('pending')
    expect(request.questions.map((question) => question.id)).toEqual([
      'authorization.recovery-cleanup',
      'business-rule.identifier-conflict',
    ])
    expect((await stat(result.state.humanInputRequestPath!)).mode & 0o777).toBe(0o600)
  })

  it('requests an environment option instead of refining when the case value is unavailable', async () => {
    const directory = await outputDirectory()
    const input = draft()
    const failed = runtime('failed', 'Required option is unavailable in the current environment: expected "Required Type"; available options ["Type A", "Type B"]')

    const result = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256: 'd'.repeat(64),
      policy,
      operations: {
        plan: async () => input,
        explore: async (value) => exploration(value, 'failed', failed),
        refine: async () => { throw new Error('Refiner must not run for missing environment data') },
        execute: async () => runtime('passed'),
      },
    })

    expect(result.state).toMatchObject({ status: 'blocked', outcome: 'blocked' })
    const request = JSON.parse(await readFile(result.state.humanInputRequestPath!, 'utf8')) as { questions: Array<{ id: string }> }
    expect(request.questions.map((question) => question.id)).toContain('test-data.environment-option')
  })

  it('resumes a human-input block from the same stage when no mutation was attempted', async () => {
    const directory = await outputDirectory()
    const input = draft()
    let resolved = false
    const operations = {
      plan: async () => input,
      explore: async (value: WorkflowPlanDraft) => exploration(
        value,
        resolved ? 'passed' : 'failed',
        resolved ? runtime('passed') : runtime('failed', 'missing required secret for test data'),
      ),
      refine: async () => input,
      execute: async () => runtime('passed'),
    }
    const first = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256: 'd'.repeat(64),
      policy,
      operations,
    })
    expect(first.state).toMatchObject({ status: 'blocked', outcome: 'blocked' })
    expect(first.state.humanInputRequestPath).toBeDefined()

    resolved = true
    const resumed = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256: 'd'.repeat(64),
      policy,
      operations,
      resumeBlocked: true,
    })
    expect(resumed.state).toMatchObject({ status: 'completed', outcome: 'passed' })
    expect(resumed.state.events.some((event) => event.message.includes('zero-mutation boundary'))).toBe(true)
    expect(resumed.state.humanInputRequestPath).toBeUndefined()
  })

  it('retries an invalid Refiner result without opening the Human Input Gate', async () => {
    const directory = await outputDirectory()
    const input = draft()
    let refinementAttempts = 0
    const result = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256: 'd'.repeat(64),
      policy,
      operations: {
        plan: async () => input,
        explore: async (value) => refinementAttempts > 1
          ? exploration(value, 'passed', runtime('passed'))
          : exploration(value, 'failed', runtime('failed', 'locator did not match')),
        refine: async () => {
          refinementAttempts += 1
          if (refinementAttempts === 1) throw new Error('Invalid workflow execution plan: assertion references entity before capture: device')
          return input
        },
        execute: async () => runtime('passed'),
      },
    })

    expect(result.state).toMatchObject({ status: 'completed', outcome: 'passed' })
    expect(refinementAttempts).toBe(2)
    expect(result.state.events.some((event) => event.message.includes('Rejected invalid refined draft'))).toBe(true)
    expect(result.state.humanInputRequestPath).toBeUndefined()
  })

  it('reuses the active Runtime attempt after an interrupted execution call', async () => {
    const directory = await outputDirectory()
    const input = draft()
    const attempts: number[] = []

    const result = await runAutonomousWorkflow({
      outputDirectory: directory,
      requestSha256: 'd'.repeat(64),
      policy,
      operations: {
        plan: async () => input,
        explore: async (value) => exploration(value, 'passed', runtime('passed')),
        refine: async () => input,
        execute: async (_plan, attempt) => {
          attempts.push(attempt)
          if (attempts.length === 1) throw new Error('browser closed unexpectedly')
          return runtime('passed')
        },
      },
    })

    expect(attempts).toEqual([1, 1])
    expect(result.state).toMatchObject({ outcome: 'passed', executionAttempts: 1 })
    expect(result.state.activeExecutionAttempt).toBeUndefined()
  })
})
