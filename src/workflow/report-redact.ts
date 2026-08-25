import { redactSensitiveContent } from '../input/text.js'

function redactString(value: string, secretValues: string[]): string {
  const withoutKnownSecrets = secretValues.reduce(
    (current, secret) => current.replaceAll(secret, '[REDACTED]'),
    value,
  )
  return redactSensitiveContent(withoutKnownSecrets)
}

export function redactReportValue<T>(value: T, environment: NodeJS.ProcessEnv = process.env): T {
  const secretValues = Object.entries(environment)
    .filter(([name, secret]) => name.startsWith('AUTO_TEST_SECRET_') && Boolean(secret))
    .map(([, secret]) => secret!)
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return redactString(item, secretValues)
    if (Array.isArray(item)) return item.map(visit)
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, visit(nested)]))
    }
    return item
  }
  return visit(value) as T
}
