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
