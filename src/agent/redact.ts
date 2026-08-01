export function secretValues(input: Record<string, string | string[]>): string[] {
  return [...new Set(Object.values(input).flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
}

export function redactAgentValue(value: string, secrets: string[]): string {
  let output = value
  for (const secret of secrets) output = output.replaceAll(secret, '<redacted-secret>')
  return output
}
