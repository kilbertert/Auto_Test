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

const sensitiveArtifactKeys = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'xapikey',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'jwttoken',
  'jwt',
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'sessiontoken',
  'token',
  '用户名',
  '账号',
  '密码',
  '验证码',
  '口令',
  '令牌',
  '密钥',
  '访问令牌',
  '刷新令牌',
  '会话令牌',
])

const sensitiveArtifactKeyPattern = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api[_-]?key',
  'access[_-]?token',
  'refresh[_-]?token',
  'id[_-]?token',
  'auth[_-]?token',
  'jwt[_-]?token',
  'jwt',
  'password',
  'passwd',
  'pwd',
  'secret',
  'client[_-]?secret',
  'session[_-]?token',
  'token',
  '用户名',
  '账号',
  '密码',
  '验证码',
  '口令',
  '令牌',
  '密钥',
  '访问令牌',
  '刷新令牌',
  '会话令牌',
].join('|')

function isSensitiveArtifactKey(key: string): boolean {
  return sensitiveArtifactKeys.has(key.normalize('NFKC').replace(/[\s_.:/\\-]/g, '').toLowerCase())
}

function redactDynamicCredentials(value: string): string {
  const keyedPrefix = `((?<![A-Za-z0-9_])(?:\\\\?["'])?(?:${sensitiveArtifactKeyPattern})(?:\\\\?["'])?\\s*[:：=]\\s*)`
  return value
    .replace(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{5,}){2,4}\b/g, '<redacted-jwt>')
    .replace(new RegExp(`${keyedPrefix}"(?:\\\\.|[^"\\\\])*"`, 'gi'), '$1"<redacted>"')
    .replace(new RegExp(`${keyedPrefix}'(?:\\\\.|[^'\\\\])*'`, 'gi'), "$1'<redacted>'")
    .replace(new RegExp(`${keyedPrefix}[^\\s,;&}\\]]+`, 'gi'), '$1<redacted>')
}

function mapStringLeaves(
  value: unknown,
  transform: (text: string) => string,
  seen = new WeakSet<object>(),
  depth = 0,
  sensitiveContext = false,
): unknown {
  if (typeof value === 'string') {
    const transformed = transform(value)
    if (!sensitiveContext) return transformed
    return transformed === '<redacted-secret>' ? transformed : '<redacted>'
  }
  if (sensitiveContext && typeof value === 'number') return 0
  if (!value || typeof value !== 'object') return value
  if (depth >= 64) return '[redacted-structure-depth-limit]'
  if (seen.has(value)) return '[redacted-circular-reference]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => mapStringLeaves(item, transform, seen, depth + 1, sensitiveContext))
    const record = value as Record<string, unknown>
    const namedSensitiveValue = Object.entries(record).some(([key, item]) =>
      /^(?:name|key|header)$/i.test(key) && typeof item === 'string' && isSensitiveArtifactKey(item))
    return Object.fromEntries(
      Object.entries(record)
        .map(([key, item]) => [
          transform(key),
          mapStringLeaves(
            item,
            transform,
            seen,
            depth + 1,
            sensitiveContext || isSensitiveArtifactKey(key) || (namedSensitiveValue && /^value$/i.test(key)),
          ),
        ]),
    )
  } finally {
    seen.delete(value)
  }
}

/** Redact runtime secrets and credential-shaped values without generic PII rewriting. */
export function redactAgentJsonValue(value: unknown, secrets: string[]): unknown {
  return mapStringLeaves(value, (text) => redactDynamicCredentials(redactAgentValue(text, secrets)))
}

export function redactAgentArtifactText(value: string, secrets: string[]): string {
  return redactDynamicCredentials(redactSensitiveContent(redactAgentValue(value, secrets)))
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
