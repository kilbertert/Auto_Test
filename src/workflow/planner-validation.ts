import { createHash } from 'node:crypto'
import type { LocatorIR } from '../core/types.js'
import { redactSensitiveContent } from '../input/text.js'
import type {
  WorkflowExecutionPlan,
  WorkflowRuntimeAssertion,
  WorkflowRuntimeStep,
} from './runtime-types.js'
import { validateWorkflowExecutionPlan } from './runtime-validation.js'
import type {
  WorkflowDraftAssertion,
  WorkflowDraftLocatorTarget,
  WorkflowDraftStep,
  WorkflowPlanDraft,
  WorkflowPlanDraftBody,
} from './planner-types.js'

const draftLocatorPrefix = '__auto_test_draft_locator__:'
const draftTablePrefix = '__auto_test_draft_table__:'

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid workflow plan draft: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireSourceRefs(value: unknown, path: string): asserts value is string[] {
  requireCondition(Array.isArray(value) && value.length > 0, `${path} must contain source references`)
  requireCondition(value.every((item) => typeof item === 'string' && item.trim()), `${path} contains an invalid source reference`)
}

function placeholderLocator(id: string): LocatorIR {
  return { strategy: 'text', value: `${draftLocatorPrefix}${id}`, exact: true, source: 'aiSuggested' }
}

function placeholderTable(id: string) {
  return { headerLabels: [`${draftTablePrefix}${id}`], bodyOffset: 0 }
}

function authenticatedEntryUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    const redirect = url.searchParams.get('redirect')
    if (!redirect?.startsWith('/')) return value
    const destination = new URL(redirect, url.origin)
    return destination.origin === url.origin ? destination.toString() : value
  } catch {
    return value
  }
}

function phaseLooksLikeAuthentication(phase: Record<string, unknown>, secretBindings: ReadonlySet<string>): boolean {
  const identity = `${String(phase.id ?? '')} ${String(phase.title ?? '')}`
  if (/(?:^|[^a-z])(?:login|sign[ -]?in|auth(?:entication)?)(?:[^a-z]|$)|登录|认证/i.test(identity)) return true
  if (!Array.isArray(phase.steps)) return false
  const hasCaptcha = phase.steps.some((step) => isRecord(step) && step.kind === 'solveCaptcha')
  const secretFills = phase.steps.filter((step) => {
    if (!isRecord(step) || step.kind !== 'fill' || !isRecord(step.value)) return false
    return typeof step.value.valueRef === 'string' && secretBindings.has(step.value.valueRef)
  }).length
  return hasCaptcha && secretFills > 0
}

function validateAuthenticatedContextContinuity(input: Record<string, unknown>): void {
  if (!Array.isArray(input.groups)) return
  const secretBindings = new Set(
    Array.isArray(input.dataBindings)
      ? input.dataBindings.filter(isRecord).flatMap((binding) => (
          binding.source === 'secret' && typeof binding.name === 'string' ? [binding.name] : []
        ))
      : [],
  )
  for (const group of input.groups) {
    if (!isRecord(group) || !Array.isArray(group.phases)) continue
    for (const [index, phase] of group.phases.entries()) {
      if (!isRecord(phase) || phase.contextMode !== 'freshPhase' || typeof phase.targetId !== 'string') continue
      if (!phaseLooksLikeAuthentication(phase, secretBindings)) continue
      const dependent = group.phases.slice(index + 1).find((candidate) => (
        isRecord(candidate) && candidate.targetId === phase.targetId && candidate.contextMode === 'shared'
      ))
      if (isRecord(dependent)) {
        throw new Error(
          `Invalid workflow plan draft: authentication phase ${String(phase.id)} uses freshPhase but later phase ${String(dependent.id)} expects a shared session on target ${phase.targetId}`,
        )
      }
    }
  }
}

function validateDraftTarget(target: WorkflowDraftLocatorTarget, path: string): void {
  requireCondition(isRecord(target), `${path} must be an object`)
  requireCondition(typeof target.description === 'string' && target.description.trim(), `${path}.description is required`)
  requireCondition(Array.isArray(target.candidates), `${path}.candidates must be an array`)
  requireSourceRefs(target.sourceRefs, `${path}.sourceRefs`)
  for (const [index, locator] of target.candidates.entries()) {
    requireCondition(isRecord(locator), `${path}.candidates[${index}] must be an object`)
    requireCondition(['role', 'testId', 'label', 'placeholder', 'text', 'css', 'xpath'].includes(String(locator.strategy)), `${path}.candidates[${index}].strategy is invalid`)
    requireCondition(typeof locator.value === 'string' && locator.value.trim(), `${path}.candidates[${index}].value is required`)
    requireCondition(locator.source === 'aiSuggested', `${path}.candidates[${index}].source must be aiSuggested before exploration`)
  }
}

function projectRefresh(refresh: Extract<WorkflowDraftStep, { kind: 'captureTableRow' }>['refresh'], id: string) {
  if (!refresh || refresh.kind !== 'click') return refresh
  validateDraftTarget(refresh.target, `${id}.refresh.target`)
  return { kind: 'click' as const, locator: placeholderLocator(`${id}:refresh`) }
}

function projectStep(step: WorkflowDraftStep): WorkflowRuntimeStep {
  requireSourceRefs(step.sourceRefs, `${step.id}.sourceRefs`)
  if (step.kind === 'click') {
    validateDraftTarget(step.target, `${step.id}.target`)
    return { id: step.id, kind: step.kind, locator: placeholderLocator(step.id) }
  }
  if (step.kind === 'fill' || step.kind === 'select') {
    validateDraftTarget(step.target, `${step.id}.target`)
    return { id: step.id, kind: step.kind, locator: placeholderLocator(step.id), value: step.value }
  }
  if (step.kind === 'press') {
    validateDraftTarget(step.target, `${step.id}.target`)
    return { id: step.id, kind: step.kind, locator: placeholderLocator(step.id), key: step.key }
  }
  if (step.kind === 'check') {
    validateDraftTarget(step.target, `${step.id}.target`)
    return { id: step.id, kind: step.kind, locator: placeholderLocator(step.id) }
  }
  if (step.kind === 'ensureChecked') {
    validateDraftTarget(step.target, `${step.id}.target`)
    return { id: step.id, kind: step.kind, locator: placeholderLocator(step.id), expected: step.expected }
  }
  if (step.kind === 'solveCaptcha') {
    validateDraftTarget(step.imageTarget, `${step.id}.imageTarget`)
    validateDraftTarget(step.inputTarget, `${step.id}.inputTarget`)
    return {
      id: step.id,
      kind: step.kind,
      imageLocator: placeholderLocator(`${step.id}:image`),
      inputLocator: placeholderLocator(`${step.id}:input`),
    }
  }
  if (step.kind === 'captureTableRow') {
    const refresh = projectRefresh(step.refresh, step.id)
    const { sourceRefs: _sourceRefs, refresh: _draftRefresh, ...runtimeStep } = step
    return refresh ? { ...runtimeStep, refresh } : runtimeStep
  }
  const { sourceRefs: _sourceRefs, ...runtimeStep } = step
  return runtimeStep
}

function projectAssertion(assertion: WorkflowDraftAssertion): WorkflowRuntimeAssertion {
  requireSourceRefs(assertion.sourceRefs, `${assertion.id}.sourceRefs`)
  if (assertion.kind === 'locatorText') {
    validateDraftTarget(assertion.target, `${assertion.id}.target`)
    return {
      id: assertion.id,
      kind: assertion.kind,
      locator: placeholderLocator(assertion.id),
      operator: assertion.operator,
      expected: assertion.expected,
    }
  }
  if (assertion.kind === 'locatorState') {
    validateDraftTarget(assertion.target, `${assertion.id}.target`)
    return { id: assertion.id, kind: assertion.kind, locator: placeholderLocator(assertion.id), expected: assertion.expected }
  }
  if (assertion.kind === 'locatorCount') {
    validateDraftTarget(assertion.target, `${assertion.id}.target`)
    return { id: assertion.id, kind: assertion.kind, locator: placeholderLocator(assertion.id), expected: assertion.expected }
  }
  return { ...assertion }
}

export function draftBodyFromUnknown(input: unknown): WorkflowPlanDraftBody {
  requireCondition(isRecord(input), 'root must be an object')
  requireCondition(input.version === '1.0', 'version must be 1.0')
  requireCondition(input.kind === 'workflow-plan-draft', 'kind must be workflow-plan-draft')
  requireCondition(isRecord(input.review), 'review is required')
  if (!isRecord(input.policy)) input.policy = {}
  const policy = input.policy as Record<string, unknown>
  if (!Number.isInteger(policy.phaseTimeoutMs) || Number(policy.phaseTimeoutMs) <= 0) {
    policy.phaseTimeoutMs = 10 * 60_000
  }
  if (!Number.isInteger(policy.actionTimeoutMs) || Number(policy.actionTimeoutMs) <= 0) {
    policy.actionTimeoutMs = Math.min(30_000, Number(policy.phaseTimeoutMs))
  } else if (Number(policy.actionTimeoutMs) > Number(policy.phaseTimeoutMs)) {
    policy.actionTimeoutMs = Number(policy.phaseTimeoutMs)
  }
  policy.destructiveActions = 'requireApproval'
  input.review.status = 'draft'
  const targetEntries = Array.isArray(input.targets)
    ? input.targets.filter(isRecord).map((target) => {
        const original = typeof target.baseUrl === 'string' ? target.baseUrl : undefined
        const entry = authenticatedEntryUrl(original)
        if (entry) target.baseUrl = entry
        return [target.id, { original, entry }] as const
      })
    : []
  const targetUrls = new Map(targetEntries.filter((entry): entry is readonly [string, { original: string | undefined; entry: string | undefined }] => typeof entry[0] === 'string'))
  if (Array.isArray(input.groups)) {
    const bindingNames = new Set(
      Array.isArray(input.dataBindings)
        ? input.dataBindings.filter(isRecord).flatMap((binding) => typeof binding.name === 'string' ? [binding.name] : [])
        : [],
    )
    const exactEntityValues: string[] = []
    for (const group of input.groups) {
      if (!isRecord(group) || !Array.isArray(group.phases)) continue
      for (const phase of group.phases) {
        if (!isRecord(phase) || !Array.isArray(phase.assertions)) continue
        for (const assertion of phase.assertions) {
          if (!isRecord(assertion) || assertion.kind !== 'entityText' || assertion.operator !== 'equals') continue
          const literal = typeof assertion.expected === 'string'
            ? assertion.expected
            : isRecord(assertion.expected) && typeof assertion.expected.literal === 'string'
              ? assertion.expected.literal
              : undefined
          if (literal) exactEntityValues.push(literal)
        }
      }
    }
    const addDerivedExclusions = (entry: Record<string, unknown>): void => {
      if (!Array.isArray(entry.match)) return
      const derived = entry.match.flatMap((operand) => {
        if (!isRecord(operand) || typeof operand.literal !== 'string') return []
        const matchLiteral = operand.literal
        return exactEntityValues
          .filter((value) => value !== matchLiteral && value.includes(matchLiteral))
          .map((value) => ({ literal: value }))
      })
      if (derived.length === 0) return
      const existing = Array.isArray(entry.exclude) ? entry.exclude.filter(isRecord) : []
      const keys = new Set(existing.map((operand) => JSON.stringify(operand)))
      entry.exclude = [...existing, ...derived.filter((operand) => !keys.has(JSON.stringify(operand)))]
    }
    for (const group of input.groups) {
      if (!isRecord(group) || !Array.isArray(group.phases)) continue
      const entityNames = new Set(group.phases.flatMap((phase) => {
        if (!isRecord(phase) || !Array.isArray(phase.steps)) return []
        return phase.steps.filter(isRecord).flatMap((step) => (
          step.kind === 'captureTableRow' && typeof step.entityName === 'string' ? [step.entityName] : []
        ))
      }))
      const normalizeEntityOperand = (operand: unknown): void => {
        if (!isRecord(operand) || typeof operand.valueRef !== 'string' || bindingNames.has(operand.valueRef)) return
        const shorthand = operand.valueRef.match(/^([A-Za-z0-9_-]+)\.id$/)
        if (shorthand && entityNames.has(shorthand[1]!)) operand.valueRef = `entities.${shorthand[1]}.id`
      }
      for (const [phaseIndex, phase] of group.phases.entries()) {
        if (!isRecord(phase)) continue
        if (
          isRecord(phase.recovery) && phase.recovery.strategy === undefined &&
          (phase.recovery.kind === 'retry' || phase.recovery.kind === 'compensate')
        ) {
          phase.recovery.strategy = phase.recovery.kind
          delete phase.recovery.kind
        }
        const targetUrl = typeof phase.targetId === 'string' ? targetUrls.get(phase.targetId) : undefined
        const hasDurableLaterVerification = group.phases.slice(phaseIndex + 1).some((candidate) => {
          if (!isRecord(candidate) || candidate.targetId !== phase.targetId) return false
          const capturesEntity = Array.isArray(candidate.steps) && candidate.steps.some((step) => isRecord(step) && step.kind === 'captureTableRow')
          const assertsDurableState = Array.isArray(candidate.assertions) && candidate.assertions.some((assertion) => (
            isRecord(assertion) && (assertion.kind === 'entityText' || assertion.kind === 'tableRowCount')
          ))
          return capturesEntity && assertsDurableState
        })
        if (hasDurableLaterVerification && Array.isArray(phase.assertions) && (phase.risk === 'write' || phase.risk === 'destructive')) {
          phase.assertions = phase.assertions.map((assertion) => {
            if (!isRecord(assertion) || (assertion.kind !== 'locatorText' && assertion.kind !== 'locatorState')) return assertion
            const target = isRecord(assertion.target) ? assertion.target : undefined
            const description = typeof target?.description === 'string' ? target.description : ''
            const candidates = Array.isArray(target?.candidates) ? target.candidates.filter(isRecord) : []
            const candidateText = candidates.map((candidate) => `${String(candidate.value ?? '')} ${String(candidate.name ?? '')}`).join(' ')
            const transientSuccess = /(?:成功|success).*(?:提示|toast|message)|(?:提示|toast|message).*(?:成功|success)/i.test(description) ||
              /\.el-message--success|(?:添加|创建|操作)成功|success(?:ful)?/i.test(candidateText)
            const baseUrl = targetUrl?.entry ?? targetUrl?.original
            if (!transientSuccess || !baseUrl) return assertion
            return {
              id: assertion.id,
              kind: 'url',
              operator: 'contains',
              expected: { literal: new URL(baseUrl).origin },
              sourceRefs: Array.isArray(assertion.sourceRefs) ? assertion.sourceRefs : [],
            }
          })
        }
        if (Array.isArray(phase.steps)) {
          for (const step of phase.steps) {
            if (!isRecord(step)) continue
            if (step.kind === 'select' && step.value === undefined && step.option !== undefined) {
              step.value = step.option
              delete step.option
            }
            if (step.kind === 'navigate' && typeof step.url === 'string') step.url = { literal: step.url }
            if (step.kind === 'navigate') normalizeEntityOperand(step.url)
            if (
              step.kind === 'navigate' && isRecord(step.url) &&
              typeof step.url.literal === 'string' && targetUrl?.original && targetUrl.entry &&
              step.url.literal === targetUrl.original
            ) step.url.literal = targetUrl.entry
            if ((step.kind === 'fill' || step.kind === 'select') && typeof step.value === 'string') step.value = { literal: step.value }
            if (step.kind === 'fill' || step.kind === 'select') normalizeEntityOperand(step.value)
            if (step.kind === 'captureTableRow') {
              if (Array.isArray(step.match)) step.match.forEach(normalizeEntityOperand)
              if (Array.isArray(step.exclude)) step.exclude.forEach(normalizeEntityOperand)
              addDerivedExclusions(step)
            }
            if (isRecord(step.refresh) && step.refresh.kind === 'navigate' && typeof step.refresh.url === 'string') {
              step.refresh.url = { literal: step.refresh.url }
            }
            if (isRecord(step.refresh) && step.refresh.kind === 'navigate') normalizeEntityOperand(step.refresh.url)
          }
        }
        if (Array.isArray(phase.assertions)) {
          for (const assertion of phase.assertions) {
            if (!isRecord(assertion)) continue
            if (['url', 'locatorText', 'entityText'].includes(String(assertion.kind)) && typeof assertion.expected === 'string') {
              assertion.expected = { literal: assertion.expected }
            }
            if (['url', 'locatorText', 'entityText'].includes(String(assertion.kind))) normalizeEntityOperand(assertion.expected)
            if ((assertion.kind === 'tableRowCount' || assertion.kind === 'locatorCount') && isRecord(assertion.expected)) {
              const literal = assertion.expected.literal
              if (typeof literal === 'string' && /^\d+$/.test(literal)) assertion.expected = Number(literal)
            }
            if (assertion.kind === 'tableRowCount') {
              if (Array.isArray(assertion.match)) assertion.match.forEach(normalizeEntityOperand)
              if (Array.isArray(assertion.exclude)) assertion.exclude.forEach(normalizeEntityOperand)
              addDerivedExclusions(assertion)
            }
          }
        }
      }
    }
  }
  return input as unknown as WorkflowPlanDraftBody
}

export function projectDraftToExecutionPlan(
  draft: WorkflowPlanDraftBody,
  locators: ReadonlyMap<string, LocatorIR> = new Map(),
  review: WorkflowExecutionPlan['review'] = {
    status: 'approved',
    reviewedBy: 'draft-validation-projection',
    reviewedAt: new Date(0).toISOString(),
    sourceRefs: ['internal:draft-validation'],
    unresolvedAmbiguities: [],
  },
  tables: ReadonlyMap<string, import('./runtime-types.js').WorkflowTableSpec> = new Map(),
): WorkflowExecutionPlan {
  const groups = draft.groups.map((group) => ({
    ...group,
    phases: group.phases.map((phase) => {
      requireSourceRefs(phase.sourceRefs, `${phase.id}.sourceRefs`)
      const steps = phase.steps.map((step) => {
        const projected = projectStep(step)
        if ('locator' in projected) projected.locator = locators.get(step.id) ?? projected.locator
        if (projected.kind === 'solveCaptcha') {
          projected.imageLocator = locators.get(`${step.id}:image`) ?? projected.imageLocator
          projected.inputLocator = locators.get(`${step.id}:input`) ?? projected.inputLocator
        }
        if (projected.kind === 'captureTableRow' && projected.refresh?.kind === 'click') {
          projected.refresh.locator = locators.get(`${step.id}:refresh`) ?? projected.refresh.locator
        }
        if (projected.kind === 'captureTableRow') projected.table = tables.get(`${step.id}:table`) ?? placeholderTable(`${step.id}:table`)
        if (projected.kind === 'clickAlignedTableAction') {
          projected.dataTable = tables.get(`${step.id}:dataTable`) ?? placeholderTable(`${step.id}:dataTable`)
          projected.actionTable = tables.get(`${step.id}:actionTable`) ?? placeholderTable(`${step.id}:actionTable`)
        }
        return projected
      })
      const assertions = phase.assertions.map((assertion) => {
        const projected = projectAssertion(assertion)
        if ('locator' in projected) projected.locator = locators.get(assertion.id) ?? projected.locator
        if (projected.kind === 'tableRowCount') projected.table = tables.get(`${assertion.id}:table`) ?? placeholderTable(`${assertion.id}:table`)
        return projected
      })
      return { ...phase, steps, assertions }
    }),
  }))
  return {
    version: '1.0',
    kind: 'workflow-execution-plan',
    workflowId: draft.workflowId,
    sourceSha256: draft.sourceSha256,
    targets: draft.targets,
    dataBindings: draft.dataBindings,
    groups,
    policy: draft.policy,
    review,
  }
}

export function validateWorkflowPlanDraft(input: unknown): WorkflowPlanDraft {
  requireCondition(isRecord(input), 'root must be an object')
  requireCondition(isRecord(input.planner), 'planner metadata is required')
  const draft = input as unknown as WorkflowPlanDraft
  const body = draftBodyFromUnknown(input)
  requireCondition(draft.review.status === 'draft', 'review.status must be draft')
  requireSourceRefs(draft.review.sourceRefs, 'review.sourceRefs')
  requireCondition(Array.isArray(draft.review.unresolvedAmbiguities), 'review.unresolvedAmbiguities must be an array')
  requireCondition(typeof draft.planner.provider === 'string' && draft.planner.provider.trim(), 'planner.provider is required')
  requireCondition(draft.planner.model === null || typeof draft.planner.model === 'string', 'planner.model is invalid')
  requireCondition(typeof draft.planner.generatedAt === 'string' && !Number.isNaN(Date.parse(draft.planner.generatedAt)), 'planner.generatedAt is invalid')
  requireCondition(typeof draft.planner.inputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(draft.planner.inputSha256), 'planner.inputSha256 is invalid')
  requireCondition(Array.isArray(draft.planner.imageSha256s) && draft.planner.imageSha256s.every((value) => /^[a-f0-9]{64}$/i.test(value)), 'planner.imageSha256s is invalid')
  requireCondition(Array.isArray(draft.planner.summary) && draft.planner.summary.every((value) => typeof value === 'string'), 'planner.summary is invalid')
  const serialized = JSON.stringify(draft)
  requireCondition(redactSensitiveContent(serialized) === serialized, 'draft contains plaintext sensitive data')
  validateAuthenticatedContextContinuity(input)
  validateWorkflowExecutionPlan(projectDraftToExecutionPlan(body))
  return draft
}

export function workflowDraftSha256(draft: WorkflowPlanDraft): string {
  return createHash('sha256').update(JSON.stringify(draft)).digest('hex')
}

export function isDraftLocator(locator: LocatorIR): string | undefined {
  return locator.strategy === 'text' && locator.value.startsWith(draftLocatorPrefix)
    ? locator.value.slice(draftLocatorPrefix.length)
    : undefined
}

export function isDraftTable(table: import('./runtime-types.js').WorkflowTableSpec): string | undefined {
  const label = table.headerLabels.length === 1 ? table.headerLabels[0] : undefined
  return label?.startsWith(draftTablePrefix) ? label.slice(draftTablePrefix.length) : undefined
}
