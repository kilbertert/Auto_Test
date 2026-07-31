import { secretEnvironmentName } from '../runtime/data.js'

export function workflowSecretEnvironment(
  secretMaterial: Record<string, string | string[]>,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base }
  const refsByVariable = new Map<string, string>()
  for (const [secretRef, value] of Object.entries(secretMaterial)) {
    const variableName = secretEnvironmentName(secretRef)
    const previousRef = refsByVariable.get(variableName)
    if (previousRef && previousRef !== secretRef) {
      throw new Error(`Secret references collide after environment normalization: ${previousRef}, ${secretRef}`)
    }
    refsByVariable.set(variableName, secretRef)
    environment[variableName] = Array.isArray(value) ? JSON.stringify(value) : value
  }
  return environment
}
