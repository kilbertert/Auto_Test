import { secretEnvironmentName } from '../runtime/data.js'

export function workflowSecretEnvironment(
  secretMaterial: Record<string, string | string[]>,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base }
  for (const [secretRef, value] of Object.entries(secretMaterial)) {
    environment[secretEnvironmentName(secretRef)] = Array.isArray(value) ? JSON.stringify(value) : value
  }
  return environment
}
