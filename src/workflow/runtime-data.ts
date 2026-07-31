import { randomUUID } from 'node:crypto'
import { secretEnvironmentName } from '../runtime/data.js'
import type {
  WorkflowRuntimeBinding,
  WorkflowRuntimeCapturedEntity,
  WorkflowRuntimeValue,
  WorkflowValueOperand,
} from './runtime-types.js'

function parseStringList(value: string, variableName: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`Secret list is empty: ${variableName}`)
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new Error(`Secret list must be a JSON string array: ${variableName}`)
    }
    return parsed.map((item) => item.trim())
  }
  return trimmed.split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean)
}

export function resolveWorkflowBindings(
  bindings: WorkflowRuntimeBinding[],
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, WorkflowRuntimeValue> {
  const values: Record<string, WorkflowRuntimeValue> = {}
  for (const binding of bindings) {
    if (binding.source === 'secret') {
      const variableName = secretEnvironmentName(binding.secretRef ?? '')
      const value = environment[variableName]
      if (!value) throw new Error(`Missing required secret environment variable: ${variableName}`)
      values[binding.name] = binding.valueType === 'stringList' ? parseStringList(value, variableName) : value
    } else if (binding.source === 'generated' && binding.generator === 'uuid') {
      values[binding.name] = randomUUID()
    } else if (binding.source === 'generated' && binding.generator === 'timestamp') {
      values[binding.name] = Date.now()
    } else if (binding.source === 'literal' && binding.value !== undefined) {
      if (binding.valueType === 'stringList' && !Array.isArray(binding.value)) throw new Error(`Literal list must be an array: ${binding.name}`)
      if (binding.valueType === 'scalar' && Array.isArray(binding.value)) throw new Error(`Literal scalar cannot be an array: ${binding.name}`)
      values[binding.name] = binding.value
    } else {
      throw new Error(`Cannot resolve workflow binding: ${binding.name}`)
    }
  }
  return values
}

export function resolveOperand(
  operand: WorkflowValueOperand,
  values: Record<string, WorkflowRuntimeValue>,
  entities: Record<string, WorkflowRuntimeCapturedEntity> = {},
): string {
  const hasLiteral = operand.literal !== undefined
  const hasReference = operand.valueRef !== undefined
  if (hasLiteral === hasReference) throw new Error('Workflow operand must contain exactly one of literal or valueRef')
  if (operand.literal !== undefined) return operand.literal
  const entityMatch = operand.valueRef!.match(/^entities\.([A-Za-z0-9_-]+)\.id$/)
  if (entityMatch) {
    const entityName = entityMatch[1]!
    const entity = entities[entityName]
    if (!entity) throw new Error(`Unknown workflow entity reference: ${operand.valueRef}`)
    return entity.id
  }
  const value = values[operand.valueRef!]
  if (value === undefined) throw new Error(`Unknown workflow valueRef: ${operand.valueRef}`)
  if (Array.isArray(value)) throw new Error(`Workflow valueRef is a list, not a scalar: ${operand.valueRef}`)
  return String(value)
}
