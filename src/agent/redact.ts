import { redactSensitiveContent } from '../input/text.js'

export function secretValues(input: Record<string, string | string[]>): string[] {
  return [...new Set(Object.values(input).flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
}

export function redactAgentValue(value: string, secrets: string[]): string {
  let output = value
  for (const secret of secrets) output = output.replaceAll(secret, '<redacted-secret>')
  return output
}

function mapStringLeaves(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === 'string') return transform(value)
  if (Array.isArray(value)) return value.map((item) => mapStringLeaves(item, transform))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, mapStringLeaves(item, transform)]),
  )
}

/** Redact exact runtime secrets only from string leaves of a structured value. */
export function redactAgentJsonValue(value: unknown, secrets: string[]): unknown {
  return mapStringLeaves(value, (text) => redactAgentValue(text, secrets))
}

export function redactAgentArtifactText(value: string, secrets: string[]): string {
  return redactSensitiveContent(redactAgentValue(value, secrets))
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>')
    .replace(
      /(\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\b\s*["']?\s*[:=]\s*["']?)[^"',\r\n}]+/gi,
      '$1<redacted>',
    )
}

/** Redact only string leaves so JSON numbers, booleans, and structure remain valid. */
export function redactAgentArtifactValue(value: unknown, secrets: string[]): unknown {
  return mapStringLeaves(value, (text) => redactAgentArtifactText(text, secrets))
}

export function transientAgentEventValues(event: unknown): string[] {
  const candidate = event as {
    type?: unknown
    item?: { type?: unknown; tool?: unknown; arguments?: unknown }
  }
  if (candidate.type !== 'item.started' && candidate.type !== 'item.updated' && candidate.type !== 'item.completed') return []
  if (candidate.item?.type !== 'mcp_tool_call' || candidate.item.tool !== 'field_composition_check') return []
  const input = candidate.item.arguments as { rendered?: unknown } | undefined
  if (!Array.isArray(input?.rendered)) return []
  return [...new Set(input.rendered.flatMap((component) => {
    if (!component || typeof component !== 'object') return []
    const value = (component as { literalValue?: unknown }).literalValue
    return typeof value === 'string' && value.length > 0 ? [value] : []
  }))].sort((left, right) => right.length - left.length)
}
