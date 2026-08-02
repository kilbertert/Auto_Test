import { describe, expect, it } from 'vitest'
import { getRunScopedTestValue, parseAgentSecretValues } from '../src/agent/test-data-access.js'

describe('run-scoped test-data access', () => {
  it('parses the private alias file without changing values', () => {
    expect(parseAgentSecretValues('AUTO_TEST_VALUE_001="A value"\nAUTO_TEST_VALUE_002="line\\nvalue"\n')).toEqual({
      AUTO_TEST_VALUE_001: 'A value',
      AUTO_TEST_VALUE_002: 'line\nvalue',
    })
  })

  it('returns only explicitly requested values in direct mode', () => {
    const values = { AUTO_TEST_VALUE_001: 'run-value', AUTO_TEST_VALUE_002: 'other-value' }
    expect(getRunScopedTestValue('direct', values, 'AUTO_TEST_VALUE_001')).toBe('run-value')
    expect(() => getRunScopedTestValue('direct', values, 'AUTO_TEST_VALUE_999')).toThrow(/Unknown run-scoped/)
  })

  it('refuses value disclosure in opaque mode', () => {
    expect(() => getRunScopedTestValue('opaque', { AUTO_TEST_VALUE_001: 'run-value' }, 'AUTO_TEST_VALUE_001')).toThrow(/disabled/)
  })
})
