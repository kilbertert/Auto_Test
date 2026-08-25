export function secretEnvironmentName(secretRef: string): string {
  if (!secretRef.trim()) throw new Error('secretRef must not be empty')
  return `AUTO_TEST_SECRET_${secretRef.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`
}
