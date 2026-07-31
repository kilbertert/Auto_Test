import type { WorkflowExecutionPlan, WorkflowRuntimeBinding, WorkflowValueOperand } from './runtime-types.js'

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid workflow execution plan: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireId(value: unknown, path: string): asserts value is string {
  requireCondition(typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u.test(value), `${path} must be a stable ID`)
}

function requireOperand(
  operand: WorkflowValueOperand,
  path: string,
  bindings: Set<string>,
  entities: Set<string>,
): void {
  requireCondition(isRecord(operand), `${path} must be an object`)
  const hasLiteral = typeof operand.literal === 'string'
  const hasRef = typeof operand.valueRef === 'string'
  requireCondition(hasLiteral !== hasRef, `${path} must contain exactly one of literal or valueRef`)
  const valueRef = operand.valueRef
  if (!hasRef || typeof valueRef !== 'string') return
  const entityMatch = valueRef.match(/^entities\.([A-Za-z0-9_-]+)\.id$/)
  if (entityMatch) {
    requireCondition(entities.has(entityMatch[1]!), `${path} references an entity before it is captured: ${valueRef}`)
    return
  }
  requireCondition(bindings.has(valueRef), `${path} references an unknown binding: ${valueRef}`)
}

function requireTable(table: unknown, path: string): void {
  requireCondition(isRecord(table), `${path} must be an object`)
  requireCondition(Array.isArray(table.headerLabels) && table.headerLabels.length > 0, `${path}.headerLabels must not be empty`)
  requireCondition(table.headerLabels.every((label) => typeof label === 'string' && label.trim()), `${path}.headerLabels must contain text`)
  requireCondition(Number.isInteger(table.bodyOffset) && Number(table.bodyOffset) >= 0, `${path}.bodyOffset must be a non-negative integer`)
  if (table.region !== undefined) requireCondition(table.region === 'main' || table.region === 'fixedRight', `${path}.region is invalid`)
}

function requireLocator(locator: unknown, path: string): void {
  requireCondition(isRecord(locator), `${path} must be an object`)
  requireCondition(['role', 'testId', 'label', 'placeholder', 'text', 'css', 'xpath'].includes(String(locator.strategy)), `${path}.strategy is invalid`)
  requireCondition(typeof locator.value === 'string' && locator.value.trim(), `${path}.value is required`)
  requireCondition(['manual', 'playwrightCli', 'aiSuggested'].includes(String(locator.source)), `${path}.source is invalid`)
  if (locator.name !== undefined) requireCondition(typeof locator.name === 'string' && locator.name.trim(), `${path}.name must contain text`)
  if (locator.exact !== undefined) requireCondition(typeof locator.exact === 'boolean', `${path}.exact must be boolean`)
}

function bindingNames(bindings: WorkflowRuntimeBinding[]): Set<string> {
  const names = new Set<string>()
  for (const [index, binding] of bindings.entries()) {
    requireId(binding.name, `dataBindings[${index}].name`)
    requireCondition(!names.has(binding.name), `duplicate data binding: ${binding.name}`)
    names.add(binding.name)
    requireCondition(['literal', 'secret', 'generated'].includes(binding.source), `invalid source for binding ${binding.name}`)
    requireCondition(['scalar', 'stringList'].includes(binding.valueType), `invalid valueType for binding ${binding.name}`)
    if (binding.source === 'secret') requireCondition(typeof binding.secretRef === 'string' && binding.secretRef.trim(), `secret binding ${binding.name} requires secretRef`)
    if (binding.source === 'literal') requireCondition(binding.value !== undefined, `literal binding ${binding.name} requires value`)
    if (binding.source === 'generated') requireCondition(binding.generator === 'uuid' || binding.generator === 'timestamp', `generated binding ${binding.name} requires a supported generator`)
  }
  return names
}

export function validateWorkflowExecutionPlan(input: unknown): WorkflowExecutionPlan {
  requireCondition(isRecord(input), 'root must be an object')
  requireCondition(input.version === '1.0', 'version must be 1.0')
  requireCondition(input.kind === 'workflow-execution-plan', 'kind must be workflow-execution-plan')
  requireId(input.workflowId, 'workflowId')
  requireCondition(typeof input.sourceSha256 === 'string' && /^[a-f0-9]{64}$/i.test(input.sourceSha256), 'sourceSha256 must be a SHA-256 hex string')
  requireCondition(Array.isArray(input.targets) && input.targets.length > 0, 'targets must not be empty')
  requireCondition(Array.isArray(input.dataBindings), 'dataBindings must be an array')
  requireCondition(Array.isArray(input.groups) && input.groups.length > 0, 'groups must not be empty')
  requireCondition(isRecord(input.policy), 'policy is required')
  requireCondition(Number.isInteger(input.policy.phaseTimeoutMs) && Number(input.policy.phaseTimeoutMs) > 0, 'policy.phaseTimeoutMs must be positive')
  if (input.policy.actionTimeoutMs !== undefined) {
    requireCondition(Number.isInteger(input.policy.actionTimeoutMs) && Number(input.policy.actionTimeoutMs) > 0, 'policy.actionTimeoutMs must be positive')
    requireCondition(Number(input.policy.actionTimeoutMs) <= Number(input.policy.phaseTimeoutMs), 'policy.actionTimeoutMs must not exceed phaseTimeoutMs')
  }
  requireCondition(['blocked', 'requireApproval'].includes(String(input.policy.destructiveActions)), 'policy.destructiveActions is invalid')
  requireCondition(isRecord(input.review) && input.review.status === 'approved', 'review.status must be approved')
  requireCondition(typeof input.review.reviewedBy === 'string' && input.review.reviewedBy.trim(), 'review.reviewedBy is required')
  requireCondition(typeof input.review.reviewedAt === 'string' && !Number.isNaN(Date.parse(input.review.reviewedAt)), 'review.reviewedAt must be an ISO date')
  requireCondition(Array.isArray(input.review.sourceRefs) && input.review.sourceRefs.length > 0, 'review.sourceRefs must not be empty')
  requireCondition(Array.isArray(input.review.unresolvedAmbiguities) && input.review.unresolvedAmbiguities.length === 0, 'review has unresolved ambiguities')
  requireCondition(Array.isArray(input.targets), 'targets must be an array')
  requireCondition(Array.isArray(input.dataBindings), 'dataBindings must be an array')
  requireCondition(Array.isArray(input.groups), 'groups must be an array')

  const plan = input as unknown as WorkflowExecutionPlan
  const targets = new Map<string, WorkflowExecutionPlan['targets'][number]>()
  for (const [index, target] of plan.targets.entries()) {
    requireId(target.id, `targets[${index}].id`)
    requireCondition(!targets.has(target.id), `duplicate target: ${target.id}`)
    let baseUrl: URL
    try {
      baseUrl = new URL(target.baseUrl)
    } catch {
      throw new Error(`Invalid workflow execution plan: target ${target.id} has an invalid baseUrl`)
    }
    requireCondition(['http:', 'https:'].includes(baseUrl.protocol), `target ${target.id} must use HTTP(S)`)
    requireCondition(Array.isArray(target.allowedOrigins) && target.allowedOrigins.length > 0, `target ${target.id} requires allowedOrigins`)
    const origins = target.allowedOrigins.map((origin) => {
      try {
        return new URL(origin).origin
      } catch {
        throw new Error(`Invalid workflow execution plan: target ${target.id} has an invalid allowed origin`)
      }
    })
    requireCondition(origins.includes(baseUrl.origin), `target ${target.id} baseUrl is outside allowedOrigins`)
    targets.set(target.id, target)
  }

  const bindings = bindingNames(plan.dataBindings)
  const bindingByName = new Map(plan.dataBindings.map((binding) => [binding.name, binding]))
  const groupIds = new Set<string>()
  const phaseIds = new Set<string>()
  const targetIds = new Set<string>()
  for (const [groupIndex, group] of plan.groups.entries()) {
    requireId(group.id, `groups[${groupIndex}].id`)
    requireCondition(!groupIds.has(group.id), `duplicate group: ${group.id}`)
    groupIds.add(group.id)
    requireCondition(Array.isArray(group.phases) && group.phases.length > 0, `group ${group.id} has no phases`)
    const groupBindings = new Set(bindings)
    if (group.forEach) {
      requireId(group.forEach.itemName, `group ${group.id} forEach.itemName`)
      const source = bindingByName.get(group.forEach.valuesRef)
      requireCondition(source?.valueType === 'stringList', `group ${group.id} forEach.valuesRef must reference a stringList binding`)
      requireCondition(!groupBindings.has(group.forEach.itemName), `group ${group.id} itemName collides with a binding`)
      groupBindings.add(group.forEach.itemName)
    }
    const entities = new Set<string>()
    const groupPhaseIds = new Set(group.phases.map((phase) => phase.id))
    for (const phase of group.phases) {
      requireId(phase.id, `group ${group.id} phase.id`)
      requireCondition(!phaseIds.has(phase.id), `duplicate phase: ${phase.id}`)
      phaseIds.add(phase.id)
      requireCondition(targets.has(phase.targetId), `phase ${phase.id} references unknown target ${phase.targetId}`)
      requireCondition(['read', 'write', 'destructive'].includes(phase.risk), `phase ${phase.id} has invalid risk`)
      requireCondition(['shared', 'freshPhase', 'freshPerIteration'].includes(phase.contextMode), `phase ${phase.id} has invalid contextMode`)
      requireCondition(Array.isArray(phase.steps) && phase.steps.length > 0, `phase ${phase.id} must contain steps`)
      requireCondition(Array.isArray(phase.assertions) && phase.assertions.length > 0, `phase ${phase.id} must contain assertions`)
      if (phase.recovery) {
        requireCondition(phase.risk !== 'read', `read phase ${phase.id} must not declare a recovery contract`)
        requireCondition(phase.recovery.strategy === 'retry' || phase.recovery.strategy === 'compensate', `phase ${phase.id} recovery.strategy is invalid`)
        requireCondition(Number.isInteger(phase.recovery.maxAttempts) && phase.recovery.maxAttempts > 0 && phase.recovery.maxAttempts <= 3, `phase ${phase.id} recovery.maxAttempts must be from 1 to 3`)
        requireCondition(Array.isArray(phase.recovery.sourceRefs) && phase.recovery.sourceRefs.length > 0, `phase ${phase.id} recovery.sourceRefs must not be empty`)
        requireCondition(phase.recovery.sourceRefs.every((value) => typeof value === 'string' && value.trim()), `phase ${phase.id} recovery.sourceRefs contains invalid evidence`)
        if (phase.recovery.strategy === 'compensate') {
          requireCondition(Array.isArray(phase.recovery.phaseIds) && phase.recovery.phaseIds.length > 0, `phase ${phase.id} compensation phaseIds must not be empty`)
          requireCondition(new Set(phase.recovery.phaseIds).size === phase.recovery.phaseIds.length, `phase ${phase.id} compensation phaseIds must be unique`)
          for (const recoveryPhaseId of phase.recovery.phaseIds) {
            requireCondition(groupPhaseIds.has(recoveryPhaseId), `phase ${phase.id} recovery references unknown phase ${recoveryPhaseId}`)
            requireCondition(recoveryPhaseId !== phase.id, `phase ${phase.id} cannot compensate itself`)
            requireCondition(group.phases.findIndex((candidate) => candidate.id === recoveryPhaseId) > group.phases.findIndex((candidate) => candidate.id === phase.id), `phase ${phase.id} compensation phase ${recoveryPhaseId} must appear later in the same group`)
          }
        }
      }
      for (const step of phase.steps) {
        requireId(step.id, `phase ${phase.id} step.id`)
        requireCondition(!targetIds.has(step.id), `duplicate runtime target ID: ${step.id}`)
        targetIds.add(step.id)
        requireCondition([
          'navigate',
          'click',
          'fill',
          'press',
          'check',
          'ensureChecked',
          'select',
          'solveCaptcha',
          'reload',
          'wait',
          'captureTableRow',
          'clickAlignedTableAction',
        ].includes(step.kind), `step ${step.id} has an invalid kind`)
        if (step.kind === 'navigate' && step.url) requireOperand(step.url, `${step.id}.url`, groupBindings, entities)
        if (step.kind === 'click' || step.kind === 'fill' || step.kind === 'press' || step.kind === 'check' || step.kind === 'ensureChecked' || step.kind === 'select') {
          requireLocator(step.locator, `${step.id}.locator`)
        }
        if (step.kind === 'solveCaptcha') {
          requireLocator(step.imageLocator, `${step.id}.imageLocator`)
          requireLocator(step.inputLocator, `${step.id}.inputLocator`)
        }
        if (step.kind === 'press') requireCondition(typeof step.key === 'string' && step.key.trim(), `${step.id}.key must contain text`)
        if (step.kind === 'ensureChecked') requireCondition(typeof step.expected === 'boolean', `${step.id}.expected must be boolean`)
        if (step.kind === 'fill' || step.kind === 'select') requireOperand(step.value, `${step.id}.value`, groupBindings, entities)
        if (step.kind === 'wait') requireCondition(Number.isInteger(step.timeoutMs) && step.timeoutMs >= 0, `${step.id}.timeoutMs must be non-negative`)
        if (step.kind === 'captureTableRow') {
          requireId(step.entityName, `${step.id}.entityName`)
          requireTable(step.table, `${step.id}.table`)
          requireCondition(Array.isArray(step.match), `${step.id}.match must be an array`)
          step.match.forEach((operand, index) => requireOperand(operand, `${step.id}.match[${index}]`, groupBindings, entities))
          step.exclude?.forEach((operand, index) => requireOperand(operand, `${step.id}.exclude[${index}]`, groupBindings, entities))
          try {
            const captureProbe = new RegExp(`(?:${step.idPattern})|`)
            requireCondition(captureProbe.exec('')!.length > 1, `${step.id}.idPattern must contain a capture group`)
          } catch {
            throw new Error(`Invalid workflow execution plan: ${step.id}.idPattern is not a valid regular expression`)
          }
          requireCondition(Number.isInteger(step.timeoutMs) && step.timeoutMs > 0, `${step.id}.timeoutMs must be positive`)
          requireCondition(Number.isInteger(step.pollIntervalMs) && step.pollIntervalMs > 0, `${step.id}.pollIntervalMs must be positive`)
          if (step.refresh) {
            requireCondition(['reload', 'navigate', 'click'].includes(step.refresh.kind), `${step.id}.refresh.kind is invalid`)
            if (step.refresh.kind === 'navigate') requireOperand(step.refresh.url, `${step.id}.refresh.url`, groupBindings, entities)
            if (step.refresh.kind === 'click') requireLocator(step.refresh.locator, `${step.id}.refresh.locator`)
          }
          entities.add(step.entityName)
        }
        if (step.kind === 'clickAlignedTableAction') {
          requireCondition(entities.has(step.entityName), `${step.id} references entity before capture: ${step.entityName}`)
          requireTable(step.dataTable, `${step.id}.dataTable`)
          requireTable(step.actionTable, `${step.id}.actionTable`)
          requireCondition(Array.isArray(step.actionNames) && step.actionNames.length > 0 && step.actionNames.every((name) => typeof name === 'string' && name.trim()), `${step.id}.actionNames must not be empty`)
        }
      }
      for (const assertion of phase.assertions) {
        requireId(assertion.id, `phase ${phase.id} assertion.id`)
        requireCondition(!targetIds.has(assertion.id), `duplicate runtime target ID: ${assertion.id}`)
        targetIds.add(assertion.id)
        requireCondition(['url', 'locatorText', 'locatorState', 'locatorCount', 'entityText', 'tableRowCount'].includes(assertion.kind), `assertion ${assertion.id} has an invalid kind`)
        if (assertion.kind === 'url' || assertion.kind === 'locatorText') requireOperand(assertion.expected, `${assertion.id}.expected`, groupBindings, entities)
        if (assertion.kind === 'url' || assertion.kind === 'locatorText' || assertion.kind === 'entityText') {
          requireCondition(assertion.operator === 'equals' || assertion.operator === 'contains', `${assertion.id}.operator is invalid`)
        }
        if (assertion.kind === 'locatorText' || assertion.kind === 'locatorState' || assertion.kind === 'locatorCount') {
          requireLocator(assertion.locator, `${assertion.id}.locator`)
        }
        if (assertion.kind === 'locatorState') requireCondition(['visible', 'hidden', 'enabled', 'checked'].includes(assertion.expected), `${assertion.id}.expected state is invalid`)
        if (assertion.kind === 'entityText') {
          requireCondition(entities.has(assertion.entityName), `${assertion.id} references entity before capture: ${assertion.entityName}`)
          requireCondition(assertion.field === undefined || (typeof assertion.field === 'string' && assertion.field.trim()), `${assertion.id}.field must be a non-empty string`)
          requireOperand(assertion.expected, `${assertion.id}.expected`, groupBindings, entities)
        }
        if (assertion.kind === 'tableRowCount') {
          requireTable(assertion.table, `${assertion.id}.table`)
          requireCondition(Array.isArray(assertion.match), `${assertion.id}.match must be an array`)
          assertion.match.forEach((operand, index) => requireOperand(operand, `${assertion.id}.match[${index}]`, groupBindings, entities))
          assertion.exclude?.forEach((operand, index) => requireOperand(operand, `${assertion.id}.exclude[${index}]`, groupBindings, entities))
          requireCondition(assertion.operator === undefined || ['equals', 'gt', 'gte', 'lt', 'lte'].includes(assertion.operator), `${assertion.id}.operator is invalid`)
          requireCondition(Number.isInteger(assertion.expected) && assertion.expected >= 0, `${assertion.id}.expected must be non-negative`)
        }
        if (assertion.kind === 'locatorCount') requireCondition(Number.isInteger(assertion.expected) && assertion.expected >= 0, `${assertion.id}.expected must be non-negative`)
      }
    }
  }
  return plan
}
