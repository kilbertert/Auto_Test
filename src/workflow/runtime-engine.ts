import { createHash, randomUUID } from 'node:crypto'
import { redactSensitiveContent } from '../input/text.js'
import { resolveOperand, resolveWorkflowBindings } from './runtime-data.js'
import type { WorkflowRunCursor, WorkflowRunState } from './runtime-state.js'
import { WorkflowStateStore } from './runtime-state.js'
import type {
  WorkflowAssertionEvent,
  WorkflowCapturedEntity,
  WorkflowExecutionPlan,
  WorkflowExecutionResult,
  WorkflowMutationEvent,
  WorkflowPageSession,
  WorkflowPhaseEvent,
  WorkflowRuntimeAssertion,
  WorkflowRuntimeCapturedEntity,
  WorkflowRuntimeDriver,
  WorkflowRuntimePhase,
  WorkflowRuntimeStep,
  WorkflowRuntimeTarget,
  WorkflowRuntimeValue,
  WorkflowStepEvent,
} from './runtime-types.js'
import { validateWorkflowExecutionPlan } from './runtime-validation.js'
import { isIdempotentCleanupPhase } from './recovery-semantics.js'
import { isWorkflowPreActionError } from './workflow-errors.js'

export interface WorkflowExecutionOptions {
  allowWrite?: boolean
  allowDestructive?: boolean
  requireRecoveryFor?: Array<WorkflowRuntimePhase['risk']>
  resume?: boolean
  resumeFromTarget?: string
  environment?: NodeJS.ProcessEnv
  stateStore?: WorkflowStateStore
  runId?: string
  maxIterationsPerGroup?: number
  iterationOffsetPerGroup?: number
  stopBeforeTarget?: string
  stopAfterRecovery?: boolean
  autoRecover?: boolean
}

class WorkflowPartialStop extends Error {
  constructor(readonly targetId: string) {
    super(`Workflow stopped before target: ${targetId}`)
  }
}

class WorkflowRecoveryEntityAbsent extends Error {
  constructor(readonly entityName: string) {
    super(`Recovery entity is absent: ${entityName}`)
  }
}

function iterationValue(groupHasLoop: boolean, iterationIndex: number): number | null {
  return groupHasLoop ? iterationIndex : null
}

function entityScopeKey(groupId: string, iteration: number | null, name: string): string {
  return `${groupId}[${iteration ?? 'single'}].${name}`
}

function publicEntity(entity: WorkflowRuntimeCapturedEntity): WorkflowCapturedEntity {
  return {
    name: entity.name,
    id: entity.id,
    rowIndex: entity.rowIndex,
    rowSha256: entity.rowSha256,
    capturedAt: entity.capturedAt,
  }
}

function secretStrings(values: Record<string, WorkflowRuntimeValue>, plan: WorkflowExecutionPlan): string[] {
  return plan.dataBindings
    .filter((binding) => binding.source === 'secret')
    .flatMap((binding) => {
      const value = values[binding.name]
      return Array.isArray(value) ? value : value === undefined ? [] : [String(value)]
    })
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
}

function safeError(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of secrets) message = message.replaceAll(secret, '<redacted-secret>')
  return redactSensitiveContent(message)
}

function allowedOrigins(target: WorkflowRuntimeTarget): string[] {
  return [...new Set(target.allowedOrigins.map((value) => new URL(value).origin))]
}

function assertAllowedUrl(url: string, target: WorkflowRuntimeTarget): void {
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    throw new Error(`Browser URL is invalid for target ${target.id}`)
  }
  if (!allowedOrigins(target).includes(origin)) throw new Error(`Browser left allowedOrigins for target ${target.id}: ${origin}`)
}

function absoluteUrl(value: string, target: WorkflowRuntimeTarget): string {
  const url = new URL(value, target.baseUrl).toString()
  assertAllowedUrl(url, target)
  return url
}

function phaseSessionKey(
  groupId: string,
  iterationIndex: number,
  phase: WorkflowRuntimePhase,
): string {
  if (phase.contextMode === 'shared') return `shared:${phase.targetId}`
  if (phase.contextMode === 'freshPhase') return `phase:${groupId}:${iterationIndex}:${phase.id}:${phase.targetId}`
  return `iteration:${groupId}:${iterationIndex}:${phase.targetId}`
}

function requireRiskApproval(phase: WorkflowRuntimePhase, plan: WorkflowExecutionPlan, options: WorkflowExecutionOptions): void {
  if (phase.risk === 'write' && !options.allowWrite) throw new Error(`Write phase requires explicit approval: ${phase.id}`)
  if (phase.risk === 'destructive') {
    if (plan.policy.destructiveActions === 'blocked') throw new Error(`Destructive phase is blocked by workflow policy: ${phase.id}`)
    if (!options.allowDestructive) throw new Error(`Destructive phase requires explicit approval: ${phase.id}`)
  }
}

function requireCompensationApprovals(
  phase: WorkflowRuntimePhase,
  group: WorkflowExecutionPlan['groups'][number],
  plan: WorkflowExecutionPlan,
  options: WorkflowExecutionOptions,
): void {
  if (phase.recovery?.strategy !== 'compensate') return
  const checked = new Set<string>()
  const visit = (sourcePhase: WorkflowRuntimePhase): void => {
    if (sourcePhase.recovery?.strategy !== 'compensate') return
    for (const phaseId of sourcePhase.recovery.phaseIds) {
      if (checked.has(phaseId)) continue
      checked.add(phaseId)
      const compensationPhase = group.phases.find((candidate) => candidate.id === phaseId)!
      try {
        requireRiskApproval(compensationPhase, plan, options)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Compensation for phase ${phase.id} is not approved before mutation: ${message}`)
      }
      visit(compensationPhase)
    }
  }
  visit(phase)
}

function requireRecoveryContract(phase: WorkflowRuntimePhase, options: WorkflowExecutionOptions): void {
  if (phase.risk === 'read' || !options.requireRecoveryFor?.includes(phase.risk) || recoveryContract(phase)) return
  throw new Error(`Phase ${phase.id} has no autonomous recovery contract`)
}

function recoveryContract(phase: WorkflowRuntimePhase): WorkflowRuntimePhase['recovery'] {
  if (phase.recovery) return phase.recovery
  if (!isIdempotentCleanupPhase(phase)) return undefined
  return { strategy: 'retry', maxAttempts: 1, sourceRefs: ['policy:implicit-idempotent-cleanup'] }
}

function comparison(actual: string, expected: string, operator: 'equals' | 'contains'): boolean {
  return operator === 'equals' ? actual === expected : actual.includes(expected)
}

function countComparison(actual: number, expected: number, operator: 'equals' | 'gt' | 'gte' | 'lt' | 'lte'): boolean {
  if (operator === 'equals') return actual === expected
  if (operator === 'gt') return actual > expected
  if (operator === 'gte') return actual >= expected
  if (operator === 'lt') return actual < expected
  return actual <= expected
}

function assertComparison(actual: string, expected: string, operator: 'equals' | 'contains', label: string): void {
  if (!comparison(actual, expected, operator)) throw new Error(`${label} did not ${operator} expected text`)
}

function isEntityIdOperand(operand: { valueRef?: string }): boolean {
  return /^entities\.[A-Za-z0-9_-]+\.id$/.test(operand.valueRef ?? '')
}

function containsCompleteEntityId(actual: string, expected: string): boolean {
  if (actual === expected) return true
  const index = actual.indexOf(expected)
  if (index < 0) return false
  const before = actual[index - 1]
  const after = actual[index + expected.length]
  const identifierCharacter = /[\p{L}\p{N}_-]/u
  return (!before || !identifierCharacter.test(before)) && (!after || !identifierCharacter.test(after))
}

function urlRouteDiagnostic(value: string): string {
  try {
    const url = new URL(value)
    const hash = url.hash.replace(/^#/, '')
    const separator = hash.indexOf('?')
    const hashPath = separator >= 0 ? hash.slice(0, separator) : hash
    const hashQuery = separator >= 0 ? hash.slice(separator + 1) : ''
    const parameters = new URLSearchParams(hashQuery || url.search)
    const message = parameters.get('errMsg') ?? parameters.get('message')
    const route = hashPath ? `${url.pathname}#${hashPath}` : url.pathname
    return message ? `${route} (${message})` : route
  } catch {
    return '<invalid-url>'
  }
}

function phaseAttempt(events: WorkflowPhaseEvent[], groupId: string, phaseId: string, iteration: number | null): number {
  return events.filter((event) => event.groupId === groupId && event.phaseId === phaseId && event.iteration === iteration).length + 1
}

function stepAttempt(events: WorkflowStepEvent[], groupId: string, phaseId: string, iteration: number | null, stepId: string): number {
  return events.filter((event) => event.groupId === groupId && event.phaseId === phaseId && event.iteration === iteration && event.stepId === stepId).length + 1
}

function assertionAttempt(events: WorkflowAssertionEvent[], groupId: string, phaseId: string, iteration: number | null, assertionId: string): number {
  return events.filter((event) => event.groupId === groupId && event.phaseId === phaseId && event.iteration === iteration && event.assertionId === assertionId).length + 1
}

function mutationId(groupId: string, phaseId: string, iteration: number | null, attempt: number): string {
  return `${groupId}:${iteration ?? 'single'}:${phaseId}:${attempt}`
}

function mutationBoundaryIndex(phase: WorkflowRuntimePhase): number {
  for (let index = 0; index < phase.steps.length; index++) {
    const kind = phase.steps[index]!.kind
    if (['click', 'press', 'check', 'ensureChecked', 'select', 'clickAlignedTableAction'].includes(kind)) return index
  }
  return 0
}

function recordMutation(
  state: WorkflowRunState,
  base: Omit<WorkflowMutationEvent, 'recordedAt'>,
): void {
  state.mutations.push({ ...base, recordedAt: new Date().toISOString() })
}

function latestMutationEvents(events: WorkflowMutationEvent[]): WorkflowMutationEvent[] {
  const latest = new Map<string, WorkflowMutationEvent>()
  for (const event of events) latest.set(event.mutationId, event)
  return [...latest.values()]
}

function mutationIsOutstanding(event: WorkflowMutationEvent): boolean {
  return ['started', 'committed', 'failed', 'interrupted'].includes(event.status)
}

function mutationNeedsRecovery(event: WorkflowMutationEvent): boolean {
  return mutationIsOutstanding(event) || event.status === 'compensation_failed'
}

export function workflowStateNeedsMutationRecovery(state: WorkflowRunState): boolean {
  return latestMutationEvents(state.mutations).some(mutationNeedsRecovery)
}

function phaseProducedEntities(phase: WorkflowRuntimePhase): string[] {
  return phase.steps
    .filter((step): step is Extract<WorkflowRuntimeStep, { kind: 'captureTableRow' }> => step.kind === 'captureTableRow')
    .map((step) => step.entityName)
}

function phaseEntityDependencies(phase: WorkflowRuntimePhase): Set<string> {
  const produced = new Set(phaseProducedEntities(phase))
  const dependencies = new Set<string>()
  for (const match of JSON.stringify(phase).matchAll(/"valueRef":"entities\.([A-Za-z0-9_-]+)\.id"/g)) {
    dependencies.add(match[1]!)
  }
  for (const step of phase.steps) {
    if (step.kind === 'clickAlignedTableAction') dependencies.add(step.entityName)
  }
  for (const assertion of phase.assertions) {
    if (assertion.kind === 'entityText') dependencies.add(assertion.entityName)
  }
  for (const entityName of produced) dependencies.delete(entityName)
  return dependencies
}

async function verifySessionOrigin(session: WorkflowPageSession, target: WorkflowRuntimeTarget): Promise<void> {
  assertAllowedUrl(await session.url(), target)
}

async function executeStep(
  step: WorkflowRuntimeStep,
  session: WorkflowPageSession,
  target: WorkflowRuntimeTarget,
  values: Record<string, WorkflowRuntimeValue>,
  entities: Record<string, WorkflowRuntimeCapturedEntity>,
): Promise<WorkflowRuntimeCapturedEntity | undefined> {
  switch (step.kind) {
    case 'navigate': {
      const destination = step.url ? resolveOperand(step.url, values, entities) : target.baseUrl
      await session.navigate(absoluteUrl(destination, target))
      break
    }
    case 'click':
      await session.click(step.locator)
      break
    case 'fill':
      await session.fill(step.locator, resolveOperand(step.value, values, entities))
      break
    case 'press':
      await session.press(step.locator, step.key)
      break
    case 'check':
      await session.check(step.locator)
      break
    case 'ensureChecked':
      await session.ensureChecked(step.locator, step.expected)
      break
    case 'select':
      await session.select(step.locator, resolveOperand(step.value, values, entities))
      break
    case 'solveCaptcha':
      await session.solveCaptcha(step.imageLocator, step.inputLocator)
      break
    case 'reload':
      await session.reload()
      break
    case 'wait':
      await session.wait(step.timeoutMs)
      break
    case 'captureTableRow': {
      const captured = await session.captureTableRow({
        table: step.table,
        match: step.match.map((operand) => resolveOperand(operand, values, entities)),
        ...(step.exclude ? { exclude: step.exclude.map((operand) => resolveOperand(operand, values, entities)) } : {}),
        idPattern: step.idPattern,
        timeoutMs: step.timeoutMs,
        pollIntervalMs: step.pollIntervalMs,
        ...(step.refresh ? {
          refresh: step.refresh.kind === 'navigate'
            ? { kind: 'navigate', url: absoluteUrl(resolveOperand(step.refresh.url, values, entities), target) }
            : step.refresh,
        } : {}),
      })
      await verifySessionOrigin(session, target)
      return { name: step.entityName, ...captured }
    }
    case 'clickAlignedTableAction': {
      const entity = entities[step.entityName]
      if (!entity) throw new Error(`Workflow entity is not available: ${step.entityName}`)
      await session.clickAlignedTableAction({
        dataTable: step.dataTable,
        actionTable: step.actionTable,
        entityId: entity.id,
        actionNames: step.actionNames,
      })
      break
    }
  }
  await verifySessionOrigin(session, target)
  return undefined
}

async function executeAssertion(
  assertion: WorkflowRuntimeAssertion,
  session: WorkflowPageSession,
  target: WorkflowRuntimeTarget,
  values: Record<string, WorkflowRuntimeValue>,
  entities: Record<string, WorkflowRuntimeCapturedEntity>,
): Promise<void> {
  if (assertion.kind === 'url') {
    const actual = await session.url()
    const expected = resolveOperand(assertion.expected, values, entities)
    if (!comparison(actual, expected, assertion.operator)) {
      throw new Error(`URL route ${urlRouteDiagnostic(actual)} did not ${assertion.operator} expected text`)
    }
  } else if (assertion.kind === 'locatorText') {
    assertComparison(
      await session.locatorText(assertion.locator),
      resolveOperand(assertion.expected, values, entities),
      assertion.operator,
      'Locator text',
    )
  } else if (assertion.kind === 'locatorState') {
    if (!await session.locatorState(assertion.locator, assertion.expected)) throw new Error(`Locator is not ${assertion.expected}`)
  } else if (assertion.kind === 'locatorCount') {
    const count = await session.locatorCount(assertion.locator)
    if (count !== assertion.expected) throw new Error(`Locator count was ${count}; expected ${assertion.expected}`)
  } else if (assertion.kind === 'entityText') {
    const entity = entities[assertion.entityName]
    if (!entity) throw new Error(`Workflow entity is not available: ${assertion.entityName}`)
    const live = await session.entityRow(entity.table, entity.id)
    const expected = resolveOperand(assertion.expected, values, entities)
    const entityIdEquals = assertion.operator === 'equals' && isEntityIdOperand(assertion.expected)
    const fieldIndex = assertion.field
      ? entity.table.headerLabels.findIndex((label) => label.trim().toLocaleLowerCase() === assertion.field!.trim().toLocaleLowerCase())
      : -1
    const positionalFieldIsReliable = entity.table.headerLabels.length === live.cells.length
    if (fieldIndex >= 0 && positionalFieldIsReliable && live.cells[fieldIndex] !== undefined) {
      if (entityIdEquals) {
        if (!containsCompleteEntityId(live.cells[fieldIndex]!, expected)) throw new Error(`Entity ${assertion.entityName} field did not equal expected entity ID`)
      } else {
        assertComparison(live.cells[fieldIndex]!, expected, assertion.operator, `Entity ${assertion.entityName} field`)
      }
    } else if (assertion.operator === 'equals') {
      const matches = entityIdEquals
        ? live.cells.filter((cell) => containsCompleteEntityId(cell, expected))
        : live.cells.filter((cell) => cell === expected)
      if (matches.length !== 1) throw new Error(`Entity ${assertion.entityName} did not contain exactly one cell equal to expected text`)
    } else {
      assertComparison(live.rowText, expected, assertion.operator, `Entity ${assertion.entityName}`)
    }
  } else {
    const matches = assertion.match.map((operand) => resolveOperand(operand, values, entities))
    const exclusions = (assertion.exclude ?? []).map((operand) => resolveOperand(operand, values, entities))
    const count = (await session.tableRows(assertion.table)).filter((row) =>
      matches.every((match) => row.includes(match)) && exclusions.every((excluded) => !row.includes(excluded)),
    ).length
    const operator = assertion.operator ?? 'equals'
    if (!countComparison(count, assertion.expected, operator)) {
      throw new Error(`Matching table row count was ${count}; expected ${operator} ${assertion.expected}`)
    }
  }
  await verifySessionOrigin(session, target)
}

function initialCursor(): WorkflowRunCursor {
  return { groupIndex: 0, iterationIndex: 0, phaseIndex: 0, nextStepIndex: 0, nextAssertionIndex: 0 }
}

function initialState(
  plan: WorkflowExecutionPlan,
  planSha256: string,
  runId: string,
  maxIterationsPerGroup: number | undefined,
  iterationOffsetPerGroup: number,
): WorkflowRunState {
  const now = new Date().toISOString()
  return {
    version: '1.0',
    workflowId: plan.workflowId,
    sourceSha256: plan.sourceSha256,
    planSha256,
    runId,
    maxIterationsPerGroup: maxIterationsPerGroup ?? null,
    iterationOffsetPerGroup,
    status: 'running',
    startedAt: now,
    cursor: initialCursor(),
    entities: {},
    phases: [],
    steps: [],
    assertions: [],
    entityCaptures: [],
    mutations: [],
    recoveries: [],
    updatedAt: now,
  }
}

function validateStoredState(
  state: WorkflowRunState,
  plan: WorkflowExecutionPlan,
  planSha256: string,
  maxIterationsPerGroup: number | undefined,
  iterationOffsetPerGroup: number,
): void {
  if (state.version !== '1.0') throw new Error('Unsupported workflow state version')
  if (state.workflowId !== plan.workflowId) throw new Error('Workflow state belongs to another workflow')
  if (state.sourceSha256 !== plan.sourceSha256) throw new Error('Workflow state source hash does not match the execution plan')
  if (state.planSha256 !== planSha256) throw new Error('Workflow state plan hash does not match the execution plan revision')
  if (state.maxIterationsPerGroup !== (maxIterationsPerGroup ?? null)) throw new Error('Workflow state iteration limit does not match the resumed execution')
  if (state.iterationOffsetPerGroup !== iterationOffsetPerGroup) throw new Error('Workflow state iteration offset does not match the resumed execution')
  if (!state.cursor || !Array.isArray(state.steps) || !Array.isArray(state.assertions) || !Array.isArray(state.phases) || !Array.isArray(state.entityCaptures)) {
    throw new Error('Workflow state is incomplete or from an unsupported runtime revision')
  }
  state.mutations ??= []
  state.recoveries ??= []
}

function restoreCurrentEntities(
  state: WorkflowRunState,
  group: WorkflowExecutionPlan['groups'][number],
  iteration: number | null,
): Record<string, WorkflowRuntimeCapturedEntity> {
  const entities: Record<string, WorkflowRuntimeCapturedEntity> = {}
  const prefix = `${group.id}[${iteration ?? 'single'}].`
  const captureTables = new Map(group.phases.flatMap((phase) => phase.steps)
    .filter((step): step is Extract<WorkflowRuntimeStep, { kind: 'captureTableRow' }> => step.kind === 'captureTableRow')
    .map((step) => [step.entityName, step.table]))
  for (const [key, entity] of Object.entries(state.entities)) {
    if (!key.startsWith(prefix)) continue
    const table = captureTables.get(entity.name)
    if (!table) throw new Error(`Stored workflow entity has no capture table in the current plan: ${entity.name}`)
    entities[entity.name] = { ...entity, rowText: '', table }
  }
  return entities
}

function applyResumeTarget(state: WorkflowRunState, plan: WorkflowExecutionPlan, targetId: string, allowEarlierPhase = false): void {
  const group = plan.groups[state.cursor.groupIndex]
  if (!group) throw new Error('Stored workflow cursor does not point to a resumable group')
  let selected: { phaseIndex: number; stepIndex: number; assertionIndex: number } | undefined
  for (let phaseIndex = allowEarlierPhase ? 0 : state.cursor.phaseIndex; phaseIndex < group.phases.length; phaseIndex++) {
    const candidate = group.phases[phaseIndex]!
    const stepIndex = candidate.steps.findIndex((step) => step.id === targetId)
    const assertionIndex = candidate.assertions.findIndex((assertion) => assertion.id === targetId)
    if (stepIndex >= 0 || assertionIndex >= 0) {
      selected = { phaseIndex, stepIndex, assertionIndex }
      break
    }
  }
  if (!selected) throw new Error(`Resume target must belong to the interrupted or a later phase in group ${group.id}: ${targetId}`)
  state.cursor.phaseIndex = selected.phaseIndex
  if (selected.stepIndex >= 0) {
    state.cursor.nextStepIndex = selected.stepIndex
    state.cursor.nextAssertionIndex = 0
  } else {
    const phase = group.phases[selected.phaseIndex]!
    state.cursor.nextStepIndex = phase.steps.length
    state.cursor.nextAssertionIndex = selected.assertionIndex
  }
  delete state.cursor.activeTarget
  delete state.error
  state.status = 'running'
}

export function workflowResumeTarget(state: WorkflowRunState, plan: WorkflowExecutionPlan): string {
  if (state.recoveryResumeTarget) return state.recoveryResumeTarget
  if (state.cursor.activeTarget?.id) return state.cursor.activeTarget.id
  const group = plan.groups[state.cursor.groupIndex]
  const phase = group?.phases[state.cursor.phaseIndex]
  const target = phase?.steps[state.cursor.nextStepIndex]?.id ?? phase?.assertions[state.cursor.nextAssertionIndex]?.id
  if (!target) throw new Error('Stored workflow cursor has no resumable target')
  return target
}

function resultFromState(plan: WorkflowExecutionPlan, state: WorkflowRunState, status: 'passed' | 'failed' | 'partial'): WorkflowExecutionResult {
  return {
    version: '1.0',
    workflowId: plan.workflowId,
    sourceSha256: plan.sourceSha256,
    planSha256: state.planSha256,
    runId: state.runId,
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    status,
    phases: state.phases,
    steps: state.steps,
    assertions: state.assertions,
    entityCaptures: state.entityCaptures,
    mutations: state.mutations,
    recoveries: state.recoveries,
    entities: state.entities,
    ...(state.error ? { error: state.error } : {}),
  }
}

function unresolvedPhaseFailures(events: WorkflowPhaseEvent[]): WorkflowPhaseEvent[] {
  const latest = new Map<string, WorkflowPhaseEvent>()
  for (const event of events) {
    latest.set(`${event.groupId}:${event.iteration ?? 'single'}:${event.phaseId}`, event)
  }
  return [...latest.values()].filter((event) => event.status === 'failed')
}

async function persist(store: WorkflowStateStore | undefined, state: WorkflowRunState): Promise<void> {
  state.updatedAt = new Date().toISOString()
  if (store) await store.save(state)
}

async function executeRecoveryPhase(options: {
  plan: WorkflowExecutionPlan
  group: WorkflowExecutionPlan['groups'][number]
  phase: WorkflowRuntimePhase
  sourcePhaseId: string
  mutationId: string
  recoveryAttempt: number
  sourceIterationIndex: number
  iteration: number | null
  values: Record<string, WorkflowRuntimeValue>
  entities: Record<string, WorkflowRuntimeCapturedEntity>
  state: WorkflowRunState
  driver: WorkflowRuntimeDriver
  executionOptions: WorkflowExecutionOptions
  secrets: string[]
  store: WorkflowStateStore | undefined
}): Promise<string | undefined> {
  const started = Date.now()
  const eventBase = {
    mutationId: options.mutationId,
    groupId: options.group.id,
    sourcePhaseId: options.sourcePhaseId,
    recoveryPhaseId: options.phase.id,
    iteration: options.iteration,
    attempt: options.recoveryAttempt,
  }
  const target = options.plan.targets.find((candidate) => candidate.id === options.phase.targetId)!
  const sessionKey = phaseSessionKey(options.group.id, options.sourceIterationIndex, options.phase)
  try {
    requireRiskApproval(options.phase, options.plan, options.executionOptions)
    const session = await options.driver.session(sessionKey, target)
    session.setDefaultTimeout(options.plan.policy.actionTimeoutMs ?? Math.min(options.plan.policy.phaseTimeoutMs, 30_000))
    const deadline = started + options.plan.policy.phaseTimeoutMs
    for (const step of options.phase.steps) {
      if (Date.now() > deadline) throw new Error(`Recovery phase timed out before step ${step.id}`)
      let captured: WorkflowRuntimeCapturedEntity | undefined
      try {
        captured = await executeStep(step, session, target, options.values, options.entities)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (step.kind === 'captureTableRow' && /Expected exactly one matching entity row; found 0/.test(message)) {
          throw new WorkflowRecoveryEntityAbsent(step.entityName)
        }
        throw error
      }
      if (captured) {
        options.entities[captured.name] = captured
        const safeCaptured = publicEntity(captured)
        options.state.entities[entityScopeKey(options.group.id, options.iteration, captured.name)] = safeCaptured
        options.state.entityCaptures.push({
          groupId: options.group.id,
          phaseId: `recovery:${options.sourcePhaseId}:${options.phase.id}`,
          iteration: options.iteration,
          stepId: step.id,
          ...safeCaptured,
        })
      }
      await persist(options.store, options.state)
    }
    for (const assertion of options.phase.assertions) {
      if (Date.now() > deadline) throw new Error(`Recovery phase timed out before assertion ${assertion.id}`)
      await executeAssertion(assertion, session, target, options.values, options.entities)
    }
    if (options.phase.contextMode === 'freshPhase') await options.driver.closeSession(sessionKey)
    options.state.recoveries.push({ ...eventBase, status: 'passed', durationMs: Date.now() - started })
    await persist(options.store, options.state)
    return undefined
  } catch (error) {
    if (options.phase.contextMode === 'freshPhase') {
      try {
        await options.driver.closeSession(sessionKey)
      } catch {
        // The recovery failure remains authoritative.
      }
    }
    if (error instanceof WorkflowRecoveryEntityAbsent) {
      options.state.recoveries.push({ ...eventBase, status: 'not_needed', durationMs: Date.now() - started })
      await persist(options.store, options.state)
      return error.entityName
    }
    const message = safeError(error, options.secrets)
    options.state.recoveries.push({ ...eventBase, status: 'failed', durationMs: Date.now() - started, error: message })
    await persist(options.store, options.state)
    throw new Error(`Recovery phase ${options.phase.id} failed: ${message}`)
  }
}

async function replayRecoveryReadPrefix(options: {
  plan: WorkflowExecutionPlan
  group: WorkflowExecutionPlan['groups'][number]
  sourceIterationIndex: number
  iteration: number | null
  values: Record<string, WorkflowRuntimeValue>
  entities: Record<string, WorkflowRuntimeCapturedEntity>
  state: WorkflowRunState
  driver: WorkflowRuntimeDriver
  store: WorkflowStateStore | undefined
}): Promise<void> {
  for (const phase of options.group.phases) {
    if (phase.risk !== 'read') break
    const target = options.plan.targets.find((candidate) => candidate.id === phase.targetId)!
    const sessionKey = phaseSessionKey(options.group.id, options.sourceIterationIndex, phase)
    const session = await options.driver.session(sessionKey, target)
    session.setDefaultTimeout(options.plan.policy.actionTimeoutMs ?? Math.min(options.plan.policy.phaseTimeoutMs, 30_000))
    for (const step of phase.steps) {
      const captured = await executeStep(step, session, target, options.values, options.entities)
      if (!captured) continue
      options.entities[captured.name] = captured
      options.state.entities[entityScopeKey(options.group.id, options.iteration, captured.name)] = publicEntity(captured)
      await persist(options.store, options.state)
    }
    for (const assertion of phase.assertions) {
      await executeAssertion(assertion, session, target, options.values, options.entities)
    }
    if (phase.contextMode === 'freshPhase') await options.driver.closeSession(sessionKey)
  }
}

async function recoverOutstandingMutations(options: {
  plan: WorkflowExecutionPlan
  group: WorkflowExecutionPlan['groups'][number]
  sourceIterationIndex: number
  iteration: number | null
  values: Record<string, WorkflowRuntimeValue>
  entities: Record<string, WorkflowRuntimeCapturedEntity>
  state: WorkflowRunState
  driver: WorkflowRuntimeDriver
  executionOptions: WorkflowExecutionOptions
  secrets: string[]
  store: WorkflowStateStore | undefined
}): Promise<string | undefined> {
  const outstanding = latestMutationEvents(options.state.mutations)
    .filter((event) => event.groupId === options.group.id && event.iteration === options.iteration && mutationNeedsRecovery(event))
  const earliestPhaseIndex = outstanding.reduce((minimum, event) => {
    const index = options.group.phases.findIndex((phase) => phase.id === event.phaseId)
    return index >= 0 ? Math.min(minimum, index) : minimum
  }, Number.POSITIVE_INFINITY)
  for (const mutation of [...outstanding].reverse()) {
    const sourcePhase = options.group.phases.find((phase) => phase.id === mutation.phaseId)
    const recovery = sourcePhase ? recoveryContract(sourcePhase) : undefined
    if (!sourcePhase || !recovery) throw new Error(`Mutation ${mutation.phaseId} has no autonomous recovery contract`)
    if (recovery.strategy === 'retry') {
      recordMutation(options.state, {
        ...mutation,
        status: 'retry_ready',
      })
      await persist(options.store, options.state)
      continue
    }
    recordMutation(options.state, {
      ...mutation,
      status: 'compensation_started',
      recoveryPhaseIds: recovery.phaseIds,
    })
    await persist(options.store, options.state)
    const completedPhaseIds = new Set(options.state.recoveries
      .filter((event) => event.mutationId === mutation.mutationId && event.status === 'passed')
      .map((event) => event.recoveryPhaseId))
    let recoveryFailure: unknown
    for (let recoveryAttempt = 1; recoveryAttempt <= recovery.maxAttempts; recoveryAttempt++) {
      const unavailableEntities = new Set<string>()
      try {
        for (const phaseId of recovery.phaseIds) {
          if (completedPhaseIds.has(phaseId)) continue
          const phase = options.group.phases.find((candidate) => candidate.id === phaseId)!
          if ([...phaseEntityDependencies(phase)].some((entityName) => unavailableEntities.has(entityName))) {
            for (const entityName of phaseProducedEntities(phase)) unavailableEntities.add(entityName)
            options.state.recoveries.push({
              mutationId: mutation.mutationId,
              groupId: options.group.id,
              sourcePhaseId: sourcePhase.id,
              recoveryPhaseId: phase.id,
              iteration: options.iteration,
              attempt: recoveryAttempt,
              status: 'not_needed',
              durationMs: 0,
            })
            await persist(options.store, options.state)
            continue
          }
          const absentEntityName = await executeRecoveryPhase({ ...options, phase, sourcePhaseId: sourcePhase.id, mutationId: mutation.mutationId, recoveryAttempt })
          if (absentEntityName) {
            unavailableEntities.add(absentEntityName)
            continue
          }
          completedPhaseIds.add(phaseId)
        }
        recoveryFailure = undefined
        break
      } catch (error) {
        recoveryFailure = error
      }
    }
    if (recoveryFailure) {
      const message = safeError(recoveryFailure, options.secrets)
      recordMutation(options.state, {
        ...mutation,
        status: 'compensation_failed',
        recoveryPhaseIds: recovery.phaseIds,
        error: message,
      })
      await persist(options.store, options.state)
      throw recoveryFailure
    }
    recordMutation(options.state, {
      ...mutation,
      status: 'compensated',
      recoveryPhaseIds: recovery.phaseIds,
    })
    await persist(options.store, options.state)
  }
  if (!Number.isFinite(earliestPhaseIndex)) return undefined
  const phase = options.group.phases[earliestPhaseIndex]!
  return phase.steps[0]?.id ?? phase.assertions[0]?.id
}

function markSatisfiedCompensations(
  state: WorkflowRunState,
  group: WorkflowExecutionPlan['groups'][number],
  iteration: number | null,
): void {
  const latestPhases = new Map<string, WorkflowPhaseEvent>()
  for (const event of state.phases) {
    if (event.groupId === group.id && event.iteration === iteration) latestPhases.set(event.phaseId, event)
  }
  for (const mutation of latestMutationEvents(state.mutations)) {
    if (mutation.groupId !== group.id || mutation.iteration !== iteration || !mutationIsOutstanding(mutation)) continue
    const sourcePhase = group.phases.find((phase) => phase.id === mutation.phaseId)
    if (sourcePhase?.recovery?.strategy !== 'compensate') continue
    if (!sourcePhase.recovery.phaseIds.every((phaseId) => latestPhases.get(phaseId)?.status === 'passed')) continue
    recordMutation(state, {
      ...mutation,
      status: 'compensated',
      recoveryPhaseIds: sourcePhase.recovery.phaseIds,
    })
  }
}

export async function executeWorkflow(
  input: unknown,
  driver: WorkflowRuntimeDriver,
  options: WorkflowExecutionOptions = {},
): Promise<WorkflowExecutionResult> {
  const plan = validateWorkflowExecutionPlan(input)
  const planSha256 = createHash('sha256').update(JSON.stringify(plan)).digest('hex')
  if (options.maxIterationsPerGroup !== undefined && (!Number.isInteger(options.maxIterationsPerGroup) || options.maxIterationsPerGroup <= 0)) {
    throw new Error('maxIterationsPerGroup must be a positive integer')
  }
  const iterationOffset = options.iterationOffsetPerGroup ?? 0
  if (!Number.isInteger(iterationOffset) || iterationOffset < 0) throw new Error('iterationOffsetPerGroup must be a non-negative integer')
  if (options.resume && options.stopBeforeTarget) throw new Error('stopBeforeTarget cannot be combined with resume')
  if (options.stopAfterRecovery && !options.resume) throw new Error('stopAfterRecovery requires resume')
  if (options.stopBeforeTarget) {
    const found = plan.groups.some((group) => group.phases.some((phase) =>
      phase.steps.some((step) => step.id === options.stopBeforeTarget) ||
      phase.assertions.some((assertion) => assertion.id === options.stopBeforeTarget),
    ))
    if (!found) throw new Error(`Unknown stopBeforeTarget: ${options.stopBeforeTarget}`)
  }
  const baseValues = resolveWorkflowBindings(plan.dataBindings, options.environment)
  const secrets = secretStrings(baseValues, plan)
  const store = options.stateStore
  const existing = await store?.load()
  let state: WorkflowRunState
  if (existing) {
    validateStoredState(existing, plan, planSha256, options.maxIterationsPerGroup, iterationOffset)
    if (!options.resume) throw new Error(`An unfinished workflow state exists at ${store!.path}; use --resume with --resume-from`)
    if (!options.resumeFromTarget) throw new Error('Resuming an interrupted workflow requires an explicit --resume-from target')
    state = existing
    let resumeFromTarget = state.recoveryResumeTarget ?? options.resumeFromTarget
    let allowEarlierPhase = Boolean(state.recoveryResumeTarget)
    if (options.autoRecover && workflowStateNeedsMutationRecovery(state)) {
      const group = plan.groups[state.cursor.groupIndex]
      if (!group) throw new Error('Stored workflow cursor does not point to a recoverable group')
      const sourceValues = group.forEach ? baseValues[group.forEach.valuesRef] : undefined
      if (group.forEach && !Array.isArray(sourceValues)) throw new Error(`Workflow loop binding is not a list: ${group.forEach.valuesRef}`)
      const allIterations = group.forEach ? sourceValues as string[] : [null]
      const offsetIterations = group.forEach ? allIterations.slice(iterationOffset) : allIterations
      const iterations = options.maxIterationsPerGroup === undefined
        ? offsetIterations
        : offsetIterations.slice(0, options.maxIterationsPerGroup)
      const sourceIterationIndex = group.forEach ? iterationOffset + state.cursor.iterationIndex : state.cursor.iterationIndex
      const iteration = iterationValue(Boolean(group.forEach), sourceIterationIndex)
      const values: Record<string, WorkflowRuntimeValue> = { ...baseValues }
      if (group.forEach) values[group.forEach.itemName] = iterations[state.cursor.iterationIndex]!
      const entities = restoreCurrentEntities(state, group, iteration)
      try {
        await replayRecoveryReadPrefix({
          plan,
          group,
          sourceIterationIndex,
          iteration,
          values,
          entities,
          state,
          driver,
          store,
        })
        const recoveredTarget = await recoverOutstandingMutations({
          plan,
          group,
          sourceIterationIndex,
          iteration,
          values,
          entities,
          state,
          driver,
          executionOptions: options,
          secrets,
          store,
        })
        if (recoveredTarget) {
          if (options.stopAfterRecovery) {
            state.status = 'interrupted'
            delete state.recoveryResumeTarget
            await persist(store, state)
            await driver.closeAll()
            return resultFromState(plan, state, 'failed')
          }
          resumeFromTarget = recoveredTarget
          allowEarlierPhase = true
        }
      } catch (error) {
        try {
          await driver.closeAll()
        } catch {
          // The recovery error remains authoritative.
        }
        throw error
      }
    }
    applyResumeTarget(state, plan, resumeFromTarget, allowEarlierPhase)
    delete state.recoveryResumeTarget
  } else {
    if (options.resume) throw new Error('Cannot resume because no unfinished workflow state exists')
    if (options.resumeFromTarget) throw new Error('--resume-from requires --resume and an unfinished workflow state')
    state = initialState(plan, planSha256, options.runId ?? randomUUID(), options.maxIterationsPerGroup, iterationOffset)
  }
  await persist(store, state)

  let failure: unknown
  let partialStop = false
  try {
    workflowLoop: while (state.cursor.groupIndex < plan.groups.length) {
      const group = plan.groups[state.cursor.groupIndex]!
      const sourceValues = group.forEach ? baseValues[group.forEach.valuesRef] : undefined
      if (group.forEach && !Array.isArray(sourceValues)) throw new Error(`Workflow loop binding is not a list: ${group.forEach.valuesRef}`)
      const allIterations = group.forEach ? sourceValues as string[] : [null]
      if (group.forEach && iterationOffset >= allIterations.length) {
        throw new Error(`Workflow iteration offset is outside binding ${group.forEach.valuesRef}`)
      }
      const offsetIterations = group.forEach ? allIterations.slice(iterationOffset) : allIterations
      const iterations = options.maxIterationsPerGroup === undefined
        ? offsetIterations
        : offsetIterations.slice(0, options.maxIterationsPerGroup)
      if (state.cursor.iterationIndex >= iterations.length) {
        state.cursor.groupIndex += 1
        state.cursor.iterationIndex = 0
        state.cursor.phaseIndex = 0
        state.cursor.nextStepIndex = 0
        state.cursor.nextAssertionIndex = 0
        await persist(store, state)
        continue
      }
      const sourceIterationIndex = group.forEach ? iterationOffset + state.cursor.iterationIndex : state.cursor.iterationIndex
      const iteration = iterationValue(Boolean(group.forEach), sourceIterationIndex)
      const values: Record<string, WorkflowRuntimeValue> = { ...baseValues }
      if (group.forEach) values[group.forEach.itemName] = iterations[state.cursor.iterationIndex]!
      let entities = restoreCurrentEntities(state, group, iteration)

      if (state.cursor.phaseIndex >= group.phases.length) {
        const iterationSessionKeys = [...new Set(group.phases
          .filter((phase) => phase.contextMode === 'freshPerIteration')
          .map((phase) => phaseSessionKey(group.id, sourceIterationIndex, phase)))]
        for (const key of iterationSessionKeys) await driver.closeSession(key)
        state.cursor.iterationIndex += 1
        state.cursor.phaseIndex = 0
        state.cursor.nextStepIndex = 0
        state.cursor.nextAssertionIndex = 0
        await persist(store, state)
        continue
      }

      const phase = group.phases[state.cursor.phaseIndex]!
      const effectiveRecovery = recoveryContract(phase)
      const target = plan.targets.find((candidate) => candidate.id === phase.targetId)!
      const sessionKey = phaseSessionKey(group.id, sourceIterationIndex, phase)
      const phaseStarted = Date.now()
      const attempt = phaseAttempt(state.phases, group.id, phase.id, iteration)
      const mutation = phase.risk === 'read'
        ? undefined
        : {
            mutationId: mutationId(group.id, phase.id, iteration, attempt),
            groupId: group.id,
            phaseId: phase.id,
            iteration,
            attempt,
            risk: phase.risk,
            ...(effectiveRecovery?.strategy === 'compensate' ? { recoveryPhaseIds: effectiveRecovery.phaseIds } : {}),
          }
      let phaseFailure: unknown
      let noMutationNeeded = false
      const mutationStepIndex = mutation ? mutationBoundaryIndex(phase) : -1
      let mutationMayHaveOccurred = Boolean(mutation && state.cursor.nextStepIndex > mutationStepIndex)
      try {
        const firstPendingTarget = state.cursor.nextStepIndex < phase.steps.length
          ? phase.steps[state.cursor.nextStepIndex]?.id
          : phase.assertions[state.cursor.nextAssertionIndex]?.id
        if (state.cursor.nextStepIndex === 0 && state.cursor.nextAssertionIndex === 0 && options.stopBeforeTarget === firstPendingTarget) {
          throw new WorkflowPartialStop(firstPendingTarget!)
        }
        requireRiskApproval(phase, plan, options)
        requireRecoveryContract(phase, options)
        requireCompensationApprovals(phase, group, plan, options)
        const session = await driver.session(sessionKey, target)
        session.setDefaultTimeout(plan.policy.actionTimeoutMs ?? Math.min(plan.policy.phaseTimeoutMs, 30_000))
        const deadline = phaseStarted + plan.policy.phaseTimeoutMs
        const unavailableCleanupEntities = new Set<string>()
        for (let index = state.cursor.nextStepIndex; index < phase.steps.length; index++) {
          if (Date.now() > deadline) throw new Error(`Phase timed out before step ${phase.steps[index]!.id}`)
          const step = phase.steps[index]!
          if (options.stopBeforeTarget === step.id) throw new WorkflowPartialStop(step.id)
          const started = Date.now()
          state.cursor.activeTarget = { kind: 'step', id: step.id }
          await persist(store, state)
          try {
            if (step.kind === 'clickAlignedTableAction' && unavailableCleanupEntities.has(step.entityName)) {
              state.steps.push({
                groupId: group.id,
                phaseId: phase.id,
                iteration,
                stepId: step.id,
                attempt: stepAttempt(state.steps, group.id, phase.id, iteration, step.id),
                status: 'passed',
                durationMs: Date.now() - started,
              })
              state.cursor.nextStepIndex = index + 1
              delete state.cursor.activeTarget
              await persist(store, state)
              continue
            }
            if (mutation && index === mutationStepIndex && !state.mutations.some((event) => event.mutationId === mutation.mutationId)) {
              recordMutation(state, { ...mutation, status: 'started' })
              await persist(store, state)
            }
            const captured = await executeStep(step, session, target, values, entities)
            if (mutation && index === mutationStepIndex) mutationMayHaveOccurred = true
            if (captured) {
              entities[captured.name] = captured
              const safeCaptured = publicEntity(captured)
              state.entities[entityScopeKey(group.id, iteration, captured.name)] = safeCaptured
              state.entityCaptures.push({
                groupId: group.id,
                phaseId: phase.id,
                iteration,
                stepId: step.id,
                ...safeCaptured,
              })
            }
            state.steps.push({
              groupId: group.id,
              phaseId: phase.id,
              iteration,
              stepId: step.id,
              attempt: stepAttempt(state.steps, group.id, phase.id, iteration, step.id),
              status: 'passed',
              durationMs: Date.now() - started,
            })
            state.cursor.nextStepIndex = index + 1
            delete state.cursor.activeTarget
            await persist(store, state)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (
              isIdempotentCleanupPhase(phase) &&
              step.kind === 'captureTableRow' &&
              /Expected exactly one matching entity row; found 0|Timed out capturing a unique table entity:.*found 0/i.test(message)
            ) {
              unavailableCleanupEntities.add(step.entityName)
              noMutationNeeded = true
              state.steps.push({
                groupId: group.id,
                phaseId: phase.id,
                iteration,
                stepId: step.id,
                attempt: stepAttempt(state.steps, group.id, phase.id, iteration, step.id),
                status: 'passed',
                durationMs: Date.now() - started,
              })
              state.cursor.nextStepIndex = index + 1
              delete state.cursor.activeTarget
              await persist(store, state)
              continue
            }
            state.steps.push({
              groupId: group.id,
              phaseId: phase.id,
              iteration,
              stepId: step.id,
              attempt: stepAttempt(state.steps, group.id, phase.id, iteration, step.id),
              status: 'failed',
              durationMs: Date.now() - started,
              error: safeError(error, secrets),
            })
            throw error
          }
        }
        for (let index = state.cursor.nextAssertionIndex; index < phase.assertions.length; index++) {
          if (Date.now() > deadline) throw new Error(`Phase timed out before assertion ${phase.assertions[index]!.id}`)
          const assertion = phase.assertions[index]!
          if (options.stopBeforeTarget === assertion.id) throw new WorkflowPartialStop(assertion.id)
          state.cursor.activeTarget = { kind: 'assertion', id: assertion.id }
          await persist(store, state)
          try {
            await executeAssertion(assertion, session, target, values, entities)
            state.assertions.push({
              groupId: group.id,
              phaseId: phase.id,
              iteration,
              assertionId: assertion.id,
              attempt: assertionAttempt(state.assertions, group.id, phase.id, iteration, assertion.id),
              status: 'passed',
            })
            state.cursor.nextAssertionIndex = index + 1
            delete state.cursor.activeTarget
            await persist(store, state)
          } catch (error) {
            state.assertions.push({
              groupId: group.id,
              phaseId: phase.id,
              iteration,
              assertionId: assertion.id,
              attempt: assertionAttempt(state.assertions, group.id, phase.id, iteration, assertion.id),
              status: 'failed',
              error: safeError(error, secrets),
            })
            throw error
          }
        }
        if (phase.contextMode === 'freshPhase') await driver.closeSession(sessionKey)
        if (mutation && noMutationNeeded && state.mutations.some((event) => event.mutationId === mutation.mutationId)) {
          recordMutation(state, { ...mutation, status: 'retry_ready' })
        } else if (mutation) {
          if (!state.mutations.some((event) => event.mutationId === mutation.mutationId)) {
            recordMutation(state, { ...mutation, status: 'started' })
          }
          recordMutation(state, { ...mutation, status: 'committed' })
          if (effectiveRecovery?.strategy === 'retry') recordMutation(state, { ...mutation, status: 'retry_ready' })
        }
        state.phases.push({
          groupId: group.id,
          phaseId: phase.id,
          iteration,
          attempt,
          title: phase.title,
          targetId: phase.targetId,
          contextMode: phase.contextMode,
          status: 'passed',
          durationMs: Date.now() - phaseStarted,
        })
        markSatisfiedCompensations(state, group, iteration)
        state.cursor.phaseIndex += 1
        state.cursor.nextStepIndex = 0
        state.cursor.nextAssertionIndex = 0
        delete state.cursor.activeTarget
        await persist(store, state)
      } catch (error) {
        if (error instanceof WorkflowPartialStop) {
          partialStop = true
          if (mutation && state.mutations.some((event) => event.mutationId === mutation.mutationId)) {
            recordMutation(state, { ...mutation, status: 'interrupted' })
          }
          if (phase.contextMode === 'freshPhase') await driver.closeSession(sessionKey)
          state.phases.push({
            groupId: group.id,
            phaseId: phase.id,
            iteration,
            attempt,
            title: phase.title,
            targetId: phase.targetId,
            contextMode: phase.contextMode,
            status: 'partial',
            durationMs: Date.now() - phaseStarted,
          })
          await persist(store, state)
          break workflowLoop
        }
        phaseFailure = error
        if (mutation && state.mutations.some((event) => event.mutationId === mutation.mutationId)) {
          recordMutation(state, {
            ...mutation,
            status: isWorkflowPreActionError(error) && !mutationMayHaveOccurred ? 'retry_ready' : 'failed',
            error: safeError(error, secrets),
          })
        }
        if (phase.contextMode === 'freshPhase') {
          try {
            await driver.closeSession(sessionKey)
          } catch {
            // The original phase error remains authoritative.
          }
        }
        state.phases.push({
          groupId: group.id,
          phaseId: phase.id,
          iteration,
          attempt,
          title: phase.title,
          targetId: phase.targetId,
          contextMode: phase.contextMode,
          status: 'failed',
          durationMs: Date.now() - phaseStarted,
          error: safeError(error, secrets),
        })
        await persist(store, state)
        if (options.autoRecover) {
          try {
            const recoveryResumeTarget = await recoverOutstandingMutations({
              plan,
              group,
              sourceIterationIndex,
              iteration,
              values,
              entities,
              state,
              driver,
              executionOptions: options,
              secrets,
              store,
            })
            if (recoveryResumeTarget) {
              state.recoveryResumeTarget = recoveryResumeTarget
              await persist(store, state)
            }
          } catch (recoveryError) {
            phaseFailure = new Error(`${safeError(error, secrets)}; automatic recovery failed: ${safeError(recoveryError, secrets)}`)
          }
        }
      }
      if (phaseFailure) throw phaseFailure
    }
  } catch (error) {
    failure = error
    state.status = 'interrupted'
    state.error = safeError(error, secrets)
    await persist(store, state)
  }

  try {
    await driver.closeAll()
  } catch (error) {
    if (!failure) {
      failure = error
      state.status = 'interrupted'
      state.error = safeError(error, secrets)
      await persist(store, state)
    }
  }

  if (failure) return resultFromState(plan, state, 'failed')
  await store?.clear()
  if (partialStop) return resultFromState(plan, state, 'partial')
  const unresolved = unresolvedPhaseFailures(state.phases)
  if (unresolved.length > 0) {
    state.error = `Workflow completed with unresolved failed phases: ${unresolved
      .map((event) => `${event.groupId}/${event.phaseId}[${event.iteration ?? 'single'}]`)
      .join(', ')}`
    return resultFromState(plan, state, 'failed')
  }
  return resultFromState(plan, state, 'passed')
}
