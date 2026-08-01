import { randomUUID } from 'node:crypto'
import type { DataBindingIR } from '../core/types.js'

export type RuntimeValue = string | number | boolean

export function secretEnvironmentName(secretRef: string): string {
  if (!secretRef.trim()) throw new Error('secretRef must not be empty')
  return `AUTO_TEST_SECRET_${secretRef.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`
}

export function resolveDataBindings(
  bindings: DataBindingIR[],
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, RuntimeValue> {
  const values: Record<string, RuntimeValue> = {}
  for (const binding of bindings) {
    if (binding.source === 'secret') {
      if (!binding.secretRef) throw new Error(`Data binding "${binding.name}" is missing secretRef`)
      const variableName = secretEnvironmentName(binding.secretRef)
      const value = environment[variableName]
      if (!value) throw new Error(`Missing required secret environment variable: ${variableName}`)
      values[binding.name] = value
    } else if (binding.source === 'generated' && binding.generator === 'uuid') {
      values[binding.name] = randomUUID()
    } else if (binding.source === 'generated' && binding.generator === 'timestamp') {
      values[binding.name] = Date.now()
    } else if (binding.source === 'literal' && binding.value !== undefined) {
      values[binding.name] = binding.value
    } else {
      throw new Error(`Cannot resolve data binding: ${binding.name}`)
    }
  }
  return values
}
