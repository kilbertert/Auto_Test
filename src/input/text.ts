import he from 'he'

export function decodeEntities(value: string): string {
  let current = value
  for (let attempt = 0; attempt < 3; attempt++) {
    const decoded = he.decode(current)
    if (decoded === current) break
    current = decoded
  }
  return current
}

export function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return ''
  const raw = value instanceof Date ? value.toISOString() : String(value)
  return decodeEntities(raw)
    .replace(/_x000D_/gi, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
}

export function normalizeHeaderKey(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\s_\-:：()（）\[\]【】]/g, '')
}

export function splitNumberedItems(value: string): string[] {
  const normalized = normalizeText(value)
  if (!normalized) return []

  const prepared = normalized
    .replace(/([；;。])\s*(?=\d{1,2}\s*[.、．)）]\s*[\p{L}])/gu, '$1\n')
    .replace(/(?<!^)(?<!\n)(?<!\d)(?=\d{1,2}\s*[.、．)）]\s*[\p{L}])/gu, '\n')

  const lines = prepared
    .split(/\n+/)
    .flatMap((line) => {
      const withoutMarker = line.replace(/^\s*\d{1,3}\s*[.、．)）]\s*/, '').trim()
      if (!withoutMarker) return []
      if (/^\d{1,3}\s*[.、．)）]/.test(line)) return [withoutMarker.replace(/[；;]+$/, '').trim()]
      return withoutMarker.split(/[；;]+/).map((part) => part.trim()).filter(Boolean)
    })

  return lines.filter(Boolean)
}

export function splitList(value: string): string[] {
  return normalizeText(value)
    .split(/[\n,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function slugify(value: string): string {
  const slug = normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'item'
}

export function redactSensitiveContent(value: string): string {
  return value
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|ak_[A-Za-z0-9_-]{12,})\b/g, '<redacted-key>')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '<redacted-email>')
    .replace(/\+?65[\s-]?\d{8}\b/g, '<redacted-phone>')
    .replace(/\b1[3-9]\d{9}\b/g, '<redacted-phone>')
    .replace(/\b\d{17}[\dXx]\b/g, '<redacted-id>')
    .replace(/\b\d{16,19}\b/g, '<redacted-number>')
    .replace(
      /((?<!\$\{)(?:用户名|账号|密码|验证码|password|passwd|pwd|token|secret|api[ _-]?key)\s*[:：=]\s*)(?!\$\{secret:)[^,，;；\n]+/gi,
      '$1<redacted>',
    )
}

export function redactSensitiveText(value: string): string {
  return redactSensitiveContent(normalizeText(value))
}

const sensitiveStructuredKeys = [
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

const keyedCredentialPattern = `((?<![A-Za-z0-9_])(?:\\\\?["'])?(?:${sensitiveStructuredKeys})(?:\\\\?["'])?\\s*[:：=]\\s*)`

/**
 * Suppress credential-shaped values that carry no known secret to match exactly: JWTs, keyed
 * credentials, and authorization headers. Artifact and report scrubbers both apply this, so the same
 * run cannot leak from a report a value its own Evidence suppressed.
 */
export function redactCredentialValues(value: string): string {
  return value
    .replace(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{5,}){2,4}\b/g, '<redacted-jwt>')
    .replace(new RegExp(`${keyedCredentialPattern}"(?:\\\\.|[^"\\\\])*"`, 'gi'), '$1"<redacted>"')
    .replace(new RegExp(`${keyedCredentialPattern}'(?:\\\\.|[^'\\\\])*'`, 'gi'), "$1'<redacted>'")
    .replace(new RegExp(`${keyedCredentialPattern}[^\\s,;&}\\]]+`, 'gi'), '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>')
    .replace(
      // Deliberate asymmetry, chosen in the safe direction: stop only at the report's spaced ` | `
      // evidence separator, and treat every other `|` as credential content. That over-redacts an
      // *unspaced* `|` separator in the free-form artifacts this also serves (CSV/log/Markdown via
      // redactAgentArtifactText), costing recall, but it never under-redacts a credential that
      // contains a pipe — the leak direction this backstop exists to prevent. The two cases are
      // indistinguishable without the caller's structure, so the real fix is a per-surface split
      // policy in the RedactionPolicy module tracked by #165, not a wider regex here.
      /(\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\b\s*["']?\s*[:=]\s*["']?)(?:(?!\s\|\s)[^"',\r\n}])+/gi,
      '$1<redacted>',
    )
}
