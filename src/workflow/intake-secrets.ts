const secretEnvironmentSymbolPattern = /[^A-Z0-9]+/g

export function secretEnvironmentName(secretRef: string): string {
  if (!secretRef.trim()) throw new Error('secretRef must not be empty')
  return `AUTO_TEST_SECRET_${secretRef.toUpperCase().replace(secretEnvironmentSymbolPattern, '_').replace(/^_+|_+$/g, '')}`
}

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
