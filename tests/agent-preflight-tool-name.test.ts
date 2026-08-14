import { describe, expect, it } from 'vitest'
import { controlContractToolName } from '../src/agent/runner.js'

describe('Control MCP preflight tool name', () => {
  it('uses the Codex namespace for codex and custom hosts', () => {
    expect(controlContractToolName('codex')).toBe('auto-test-control.test_contract')
    expect(controlContractToolName('custom-host')).toBe('auto-test-control.test_contract')
  })

  it('uses the OMP mcp__<server>_<tool> convention for omp', () => {
    expect(controlContractToolName('omp')).toBe('mcp__auto_test_control_test_contract')
  })
})
