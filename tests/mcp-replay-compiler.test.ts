import { describe, expect, it } from 'vitest'
import { compileMcpReplay } from '../src/compiler/mcp-replay.js'

function event(id: string, server: string, tool: string, args: object, text = ''): object {
  return { type: 'item.completed', item: { id, type: 'mcp_tool_call', server, tool, arguments: args, result: { content: [{ type: 'text', text }] }, status: 'completed' } }
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

  it('fails closed for unsafe code and missing passed-case events', () => {
    const result = compileMcpReplay([
      event('1', 'auto-test-control', 'case_execution_begin', { caseId: 'case-1' }),
      event('2', 'playwright', 'browser_run_code_unsafe', { code: 'async page => page.url()' }, '### Ran Playwright code\n```js\nawait page.url();\n```'),
      event('3', 'auto-test-control', 'case_execution_end', { caseId: 'case-1' }),
    ], new Set(['case-1', 'case-2']))

    expect(result.source).toBe('')
    expect(result.diagnostics.map((item) => item.code)).toEqual(['unsafe_tool', 'replayable_attempt_missing', 'case_events_missing'])
  })

  it('rejects action-only passed cases', () => {
    const result = compileMcpReplay([
      event('1', 'auto-test-control', 'case_execution_begin', { caseId: 'case-1' }),
      event('2', 'playwright', 'browser_click', { target: 'e1' }, "### Ran Playwright code\n```js\nawait page.getByRole('button', { name: 'Save' }).click();\n```"),
      event('3', 'auto-test-control', 'case_execution_end', { caseId: 'case-1' }),
    ], new Set(['case-1']))

    expect(result.source).toBe('')
    expect(result.diagnostics[0]?.code).toBe('replayable_attempt_missing')
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

  it('attributes an older single-case run without explicit case boundaries', () => {
    const result = compileMcpReplay([
      event('1', 'playwright', 'browser_navigate', { url: 'https://example.test' }, "### Ran Playwright code\n```js\nawait page.goto('https://example.test');\n```"),
      event('2', 'playwright', 'browser_verify_text_visible', { text: 'Home' }, "### Ran Playwright code\n```js\nawait expect(page.getByText('Home')).toBeVisible();\n```"),
    ], new Set(['case-1']))

    expect(result.caseIds).toEqual(['case-1'])
    expect(result.source).toContain('page.getByText')
  })
})
