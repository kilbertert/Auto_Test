export function parseAgentSecretValues(content: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue
    const separator = line.indexOf('=')
    if (separator < 1) throw new Error('Secret alias file contains an invalid line')
    const alias = line.slice(0, separator)
    const value = JSON.parse(line.slice(separator + 1)) as unknown
    if (typeof value !== 'string') throw new Error(`Secret alias ${alias} is not a string`)
    values[alias] = value
  }
  return values
}

export function getRunScopedTestValue(
  access: 'direct' | 'opaque',
  values: Record<string, string>,
  alias: string,
): string {
  if (access !== 'direct') throw new Error('Direct test-data access is disabled for this run')
  const value = values[alias]
  if (value === undefined) throw new Error(`Unknown run-scoped test value alias: ${alias}`)
  return value
}
