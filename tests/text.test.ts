import { describe, expect, it } from 'vitest'
import { normalizeText, redactSensitiveContent, redactSensitiveText, splitNumberedItems } from '../src/input/text.js'

describe('text normalization', () => {
  it('decodes numeric HTML entities and encoded line breaks', () => {
    expect(normalizeText('&#29992;&#20363;ID&#10;&#27979;&#35797;')).toBe('用例ID\n测试')
  })

  it('splits compact numbered Chinese steps', () => {
    expect(splitNumberedItems('1.打开登录页面；2.输入用户名；3.点击【登录】按钮')).toEqual([
      '打开登录页面',
      '输入用户名',
      '点击【登录】按钮',
    ])
  })

  it('keeps two-digit step numbers intact', () => {
    expect(splitNumberedItems('9.点击确定；10.进入详情页；11、点击启动设备')).toEqual([
      '点击确定',
      '进入详情页',
      '点击启动设备',
    ])
  })

  it('redacts credentials and common personal identifiers', () => {
    const redacted = redactSensitiveText('账号：admin，密码：secret123，手机号：+6590000001，key=sk-example987654321')
    expect(redacted).not.toContain('secret123')
    expect(redacted).not.toContain('+6590000001')
    expect(redacted).toContain('<redacted-phone>')
    expect(redacted).not.toContain('sk-example987654321')
  })

  it('can redact snapshots without changing indentation', () => {
    expect(redactSensitiveContent('  - text: 账号：admin\n    - button: 登录')).toBe(
      '  - text: 账号：<redacted>\n    - button: 登录',
    )
  })

  it('preserves secretRef placeholders during redaction', () => {
    expect(redactSensitiveContent('账号=${secret:admin.username}，密码=${secret:admin.password}')).toBe(
      '账号=${secret:admin.username}，密码=${secret:admin.password}',
    )
  })
})
