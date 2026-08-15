import { describe, expect, it } from 'vitest'
import { compileMcpReplay } from '../src/compiler/mcp-replay.js'

function event(id: string, server: string, tool: string, args: object, text = '', status = 'completed'): object {
  return { type: 'item.completed', item: { id, type: 'mcp_tool_call', server, tool, arguments: args, result: { content: [{ type: 'text', text }] }, status } }
}

describe('MCP replay compiler', () => {
  it('compiles passed-case MCP output with stable locators and environment-backed secrets', () => {
    const result = compileMcpReplay([
      event('1', 'auto-test-control', 'case_execution_begin', { caseId: 'login-1' }),
      event('2', 'playwright', 'browser_navigate', { url: 'https://example.test' }, "### Ran Playwright code\n```js\nawait page.goto('https://example.test');\n```"),
      event('3', 'playwright', 'browser_type', { target: 'e40', text: '<redacted-secret>' }, "### Ran Playwright code\n```js\nawait page.getByRole('textbox', { name: 'Username' }).fill('<secret>AUTO_TEST_VALUE_002</secret>');\n```"),
      event('4', 'playwright', 'browser_click', { target: 'e67' }, "### Ran Playwright code\n```js\nawait page.getByRole('button', { name: 'Log in' }).click();\n```"),
      event('5', 'playwright', 'browser_verify_text_visible', { text: 'Home' }, "### Ran Playwright code\n```js\nawait expect(page.getByText('Home')).toBeVisible();\n```"),
      event('6', 'auto-test-control', 'case_execution_end', { caseId: 'login-1' }),
    ], new Set(['login-1']))

    expect(result.diagnostics).toEqual([])
    expect(result.source).toContain("page.getByRole('button', { name: 'Log in' })")
    expect(result.source).toContain('process.env.AUTO_TEST_VALUE_002')
    expect(result.source).not.toContain('<secret>')
    expect(result.source).not.toContain('e67')
  })

  it('preserves indexed aliases for list-valued secrets', () => {
    const result = compileMcpReplay([
      event('1', 'auto-test-control', 'case_execution_begin', { caseId: 'case-1' }),
      event('2', 'playwright', 'browser_navigate', {}, "### Ran Playwright code\n```js\nawait page.goto('https://example.test');\n```"),
      event('3', 'playwright', 'browser_type', {}, "### Ran Playwright code\n```js\nawait page.getByRole('textbox').fill('<secret>AUTO_TEST_VALUE_001_02</secret>');\n```"),
      event('4', 'playwright', 'browser_verify_value', {}, "### Ran Playwright code\n```js\nawait expect(page.getByRole('textbox')).toHaveValue('<secret>AUTO_TEST_VALUE_001_02</secret>');\n```"),
      event('5', 'auto-test-control', 'case_execution_end', { caseId: 'case-1' }),
    ], new Set(['case-1']))

    expect(result.diagnostics).toEqual([])
    expect(result.source).toContain('process.env.AUTO_TEST_VALUE_001_02')
    expect(result.source).not.toContain('<secret>')
  })

  it('fails closed for unsafe code and missing passed-case events', () => {
    const result = compileMcpReplay([
      event('1', 'auto-test-control', 'case_execution_begin', { caseId: 'case-1' }),
      event('2', 'playwright', 'browser_run_code_unsafe', { code: 'async page => page.url()' }, '### Ran Playwright code\n```js\nawait page.url();\n```'),
      event('3', 'auto-test-control', 'case_execution_end', { caseId: 'case-1' }),
    ], new Set(['case-1', 'case-2']))

    expect(result.source).toBe('')
    expect(result.diagnostics.map((item) => item.code)).toEqual(['unsafe_tool', 'replayable_attempt_missing', 'case_events_missing'])
  })

  it('rejects an attempt containing a failed Playwright action', () => {
    const result = compileMcpReplay([
      event('1', 'auto-test-control', 'case_execution_begin', { caseId: 'case-1' }),
      event('2', 'playwright', 'browser_navigate', {}, "### Ran Playwright code\n```js\nawait page.goto('https://example.test');\n```"),
      event('3', 'playwright', 'browser_click', {}, '', 'failed'),
      event('4', 'playwright', 'browser_verify_text_visible', {}, "### Ran Playwright code\n```js\nawait expect(page.getByText('Ready')).toBeVisible();\n```"),
      event('5', 'auto-test-control', 'case_execution_end', { caseId: 'case-1' }),
    ], new Set(['case-1']))

    expect(result.source).toBe('')
    expect(result.diagnostics.map((item) => item.code)).toEqual(['tool_failed', 'replayable_attempt_missing'])
  })

  it('rejects action-only passed cases', () => {
    const result = compileMcpReplay([
      event('1', 'auto-test-control', 'case_execution_begin', { caseId: 'case-1' }),
      event('2', 'playwright', 'browser_click', { target: 'e1' }, "### Ran Playwright code\n```js\nawait page.getByRole('button', { name: 'Save' }).click();\n```"),
      event('3', 'auto-test-control', 'case_execution_end', { caseId: 'case-1' }),
    ], new Set(['case-1']))

    expect(result.source).toBe('')
    expect(result.diagnostics.map((item) => item.code)).toEqual(['navigation_missing', 'replayable_attempt_missing'])
  })

  it('rejects assertions that depend on an ambient page without navigation', () => {
    const result = compileMcpReplay([
      event('1', 'auto-test-control', 'case_execution_begin', { caseId: 'case-1' }),
      event('2', 'playwright', 'browser_verify_text_visible', {}, "### Ran Playwright code\n```js\nawait expect(page.getByText('Ready')).toBeVisible();\n```"),
      event('3', 'auto-test-control', 'case_execution_end', { caseId: 'case-1' }),
    ], new Set(['case-1']))

    expect(result.source).toBe('')
    expect(result.diagnostics.map((item) => item.code)).toEqual(['navigation_missing', 'replayable_attempt_missing'])
  })

  it('rejects business actions before the deterministic navigation', () => {
    const result = compileMcpReplay([
      event('1', 'auto-test-control', 'case_execution_begin', { caseId: 'case-1' }),
      event('2', 'playwright', 'browser_click', {}, "### Ran Playwright code\n```js\nawait page.getByRole('button', { name: 'Save' }).click();\n```"),
      event('3', 'playwright', 'browser_navigate', {}, "### Ran Playwright code\n```js\nawait page.goto('https://example.test');\n```"),
      event('4', 'playwright', 'browser_verify_text_visible', {}, "### Ran Playwright code\n```js\nawait expect(page.getByText('Ready')).toBeVisible();\n```"),
      event('5', 'auto-test-control', 'case_execution_end', { caseId: 'case-1' }),
    ], new Set(['case-1']))

    expect(result.source).toBe('')
    expect(result.diagnostics.map((item) => item.code)).toEqual(['action_before_navigation', 'replayable_attempt_missing'])
  })

  it('rejects redacted runtime values instead of inventing replay secrets', () => {
    const result = compileMcpReplay([
      event('1', 'auto-test-control', 'case_execution_begin', { caseId: 'case-1' }),
      event('2', 'playwright', 'browser_navigate', {}, "### Ran Playwright code\n```js\nawait page.goto('https://example.test/orders/<redacted-number>');\n```"),
      event('3', 'playwright', 'browser_verify_text_visible', {}, "### Ran Playwright code\n```js\nawait expect(page.getByText('Ready')).toBeVisible();\n```"),
      event('4', 'auto-test-control', 'case_execution_end', { caseId: 'case-1' }),
    ], new Set(['case-1']))

    expect(result.source).toBe('')
    expect(result.diagnostics.map((item) => item.code)).toEqual(['redacted_runtime_value', 'replayable_attempt_missing'])
  })

  it('does not invent a generic environment variable for redacted secrets', () => {
    const result = compileMcpReplay([
      event('1', 'auto-test-control', 'case_execution_begin', { caseId: 'case-1' }),
      event('2', 'playwright', 'browser_navigate', {}, "### Ran Playwright code\n```js\nawait page.goto('https://example.test');\n```"),
      event('3', 'playwright', 'browser_type', {}, "### Ran Playwright code\n```js\nawait page.getByRole('textbox').fill('<redacted-secret>');\n```"),
      event('4', 'playwright', 'browser_verify_text_visible', {}, "### Ran Playwright code\n```js\nawait expect(page.getByText('Ready')).toBeVisible();\n```"),
      event('5', 'auto-test-control', 'case_execution_end', { caseId: 'case-1' }),
    ], new Set(['case-1']))

    expect(result.source).toBe('')
    expect(result.diagnostics.map((item) => item.code)).toEqual(['redacted_runtime_value', 'replayable_attempt_missing'])
  })

  it('ignores browser_find and network inspection in a replay episode', () => {
    const result = compileMcpReplay([
      event('1', 'auto-test-control', 'case_execution_begin', { caseId: 'case-1' }),
      event('2', 'playwright', 'browser_find', { query: 'Save button' }),
      event('3', 'playwright', 'browser_network_request', { url: '/api/data' }),
      event('4', 'playwright', 'browser_navigate', {}, "### Ran Playwright code\n```js\nawait page.goto('https://example.test');\n```"),
      event('5', 'playwright', 'browser_verify_text_visible', {}, "### Ran Playwright code\n```js\nawait expect(page.getByText('Ready')).toBeVisible();\n```"),
      event('6', 'auto-test-control', 'case_execution_end', { caseId: 'case-1' }),
    ], new Set(['case-1']))

    expect(result.diagnostics).toEqual([])
    expect(result.source).not.toContain('browser_find')
    expect(result.source).not.toContain('browser_network_request')
    expect(result.source).toContain("getByText('Ready')")
  })

  it('ignores replay storage setup outside the compiled case actions', () => {
    const result = compileMcpReplay([
      event('1', 'playwright', 'browser_storage_state', { filename: 'replay-storage-state.json' }, "### Ran Playwright code\n```js\nawait page.context().storageState({ path: 'replay-storage-state.json' });\n```"),
      event('2', 'auto-test-control', 'case_execution_begin', { caseId: 'case-1' }),
      event('3', 'playwright', 'browser_navigate', {}, "### Ran Playwright code\n```js\nawait page.goto('https://example.test');\n```"),
      event('4', 'playwright', 'browser_verify_text_visible', {}, "### Ran Playwright code\n```js\nawait expect(page.getByText('Ready')).toBeVisible();\n```"),
      event('5', 'auto-test-control', 'case_execution_end', { caseId: 'case-1' }),
    ], new Set(['case-1']))

    expect(result.diagnostics).toEqual([])
    expect(result.source).not.toContain('storageState')
  })

  it('selects the last complete replayable attempt after exploratory failure', () => {
    const result = compileMcpReplay([
      event('1', 'auto-test-control', 'case_execution_begin', { caseId: 'case-1' }),
      event('2', 'playwright', 'browser_run_code_unsafe', {}, '### Ran Playwright code\n```js\nawait page.url();\n```'),
      event('3', 'auto-test-control', 'case_execution_end', { caseId: 'case-1' }),
      event('4', 'auto-test-control', 'case_execution_begin', { caseId: 'case-1' }),
      event('5', 'playwright', 'browser_navigate', {}, "### Ran Playwright code\n```js\nawait page.goto('https://example.test');\n```"),
      event('6', 'playwright', 'browser_verify_text_visible', {}, "### Ran Playwright code\n```js\nawait expect(page.getByText('Ready')).toBeVisible();\n```"),
      event('7', 'auto-test-control', 'case_execution_end', { caseId: 'case-1' }),
    ], new Set(['case-1']))

    expect(result.diagnostics).toEqual([])
    expect(result.source).toContain("getByText('Ready')")
    expect(result.source).not.toContain('page.url')
  })

  it('drops ambient assertions before the first deterministic navigation', () => {
    const result = compileMcpReplay([
      event('1', 'auto-test-control', 'case_execution_begin', { caseId: 'case-1' }),
      event('2', 'playwright', 'browser_verify_text_visible', {}, "### Ran Playwright code\n```js\nawait expect(page.getByText('Old page')).toBeVisible();\n```"),
      event('3', 'playwright', 'browser_navigate', {}, "### Ran Playwright code\n```js\nawait page.goto('https://example.test');\n```"),
      event('4', 'playwright', 'browser_verify_text_visible', {}, "### Ran Playwright code\n```js\nawait expect(page.getByText('Ready')).toBeVisible();\n```"),
      event('5', 'auto-test-control', 'case_execution_end', { caseId: 'case-1' }),
    ], new Set(['case-1']))

    expect(result.diagnostics).toEqual([])
    expect(result.source).not.toContain('Old page')
    expect(result.source).toContain("page.goto('https://example.test')")
    expect(result.source).toContain("getByText('Ready')")
  })

  it('attributes an older single-case run without explicit case boundaries', () => {
    const result = compileMcpReplay([
      event('1', 'playwright', 'browser_navigate', { url: 'https://example.test' }, "### Ran Playwright code\n```js\nawait page.goto('https://example.test');\n```"),
      event('2', 'playwright', 'browser_verify_text_visible', { text: 'Home' }, "### Ran Playwright code\n```js\nawait expect(page.getByText('Home')).toBeVisible();\n```"),
    ], new Set(['case-1']))

    expect(result.caseIds).toEqual(['case-1'])
    expect(result.source).toContain('page.getByText')
  })
})
