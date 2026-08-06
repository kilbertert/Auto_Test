import { describe, expect, it } from 'vitest'
import { redactAgentArtifactText, redactAgentArtifactValue, redactAgentJsonValue, transientAgentEventValues } from '../src/agent/redact.js'

describe('agent event redaction', () => {
  it('extracts transient composite-field values without treating unrelated tool arguments as secrets', () => {
    expect(transientAgentEventValues({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        tool: 'field_composition_check',
        arguments: {
          rendered: [
            { componentId: 'selector', valueKind: 'derived', literalValue: 'segment-a' },
            { componentId: 'input', valueKind: 'derived', literalValue: 'segment-b' },
          ],
        },
      },
    })).toEqual(['segment-a', 'segment-b'])

    expect(transientAgentEventValues({
      type: 'item.completed',
      item: { type: 'mcp_tool_call', tool: 'browser_fill_form', arguments: { value: 'visible-to-existing-redaction' } },
    })).toEqual([])
  })

  it('redacts exact run secrets before applying generic artifact rules', () => {
    const redacted = redactAgentArtifactText(
      'user=fixture-user password=fixture-password Authorization: Bearer abcdefghijklmnop',
      ['fixture-password', 'fixture-user'],
    )
    expect(redacted).not.toContain('fixture-user')
    expect(redacted).not.toContain('fixture-password')
    expect(redacted).not.toContain('abcdefghijklmnop')
  })

  it('preserves JSON scalar types while redacting string leaves', () => {
    const value = redactAgentArtifactValue({
      cost: 0.09356,
      ok: true,
      message: 'password=fixture-password',
    }, ['fixture-password'])
    const serialized = JSON.stringify(value)
    expect(JSON.parse(serialized)).toEqual({ cost: 0.09356, ok: true, message: 'password=<redacted>' })
  })

  it('redacts dynamically observed credentials without requiring prior secret registration', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJlMTIzNDU2'
    const jwe = 'eyJlbmMiOiJBMjU2R0NNIn0.Zml4dHVyZUtleQ.aXYxMjM0NTY.Y2lwaGVydGV4dA.dGFnMTIzNDU2'
    const opaque = 'opaque-refresh-value-abcdef123456'
    const redactedText = redactAgentArtifactText(
      `payload={"access_token":"${jwt}","refreshToken":"${opaque}"} escaped={\\"refresh_token\\":\\"${opaque}\\"} compact=${jwe} redirect?access_token=query-token-value&next=/home`,
      [],
    )
    expect(redactedText).not.toContain(jwt)
    expect(redactedText).not.toContain(opaque)
    expect(redactedText).not.toContain(jwe)
    expect(redactedText).not.toContain('query-token-value')

    expect(redactAgentArtifactValue({
      response: { access_token: jwt, refreshToken: opaque },
      localized: { 密码: opaque },
      storageEntry: { name: 'access_token', value: opaque },
      numericCredential: { password: 123456, attempts: 3 },
      nested: `Authorization: Bearer ${jwt}`,
      count: 3,
    }, [])).toEqual({
      response: { access_token: '<redacted>', refreshToken: '<redacted>' },
      localized: { 密码: '<redacted>' },
      storageEntry: { name: 'access_token', value: '<redacted>' },
      numericCredential: { password: 0, attempts: 3 },
      nested: 'Authorization: <redacted>',
      count: 3,
    })

    expect(redactAgentJsonValue({
      evidencePath: 'evidence/order-1234567890123456.png',
      accessToken: opaque,
      summary: `Observed JWT ${jwt}`,
    }, [])).toEqual({
      evidencePath: 'evidence/order-1234567890123456.png',
      accessToken: '<redacted>',
      summary: 'Observed JWT <redacted-jwt>',
    })
  })

  it('does not replace numeric fields when an exact runtime secret is numeric text', () => {
    expect(redactAgentJsonValue({ password: '123', count: 123, ok: true }, ['123'])).toEqual({
      password: '<redacted-secret>',
      count: 123,
      ok: true,
    })
  })
})
