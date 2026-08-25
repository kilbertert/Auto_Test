const secretEnvironmentSymbolPattern = /[^A-Z0-9]+/g

export function secretEnvironmentName(secretRef: string): string {
  if (!secretRef.trim()) throw new Error('secretRef must not be empty')
  return `AUTO_TEST_SECRET_${secretRef.toUpperCase().replace(secretEnvironmentSymbolPattern, '_').replace(/^_+|_+$/g, '')}`
}
