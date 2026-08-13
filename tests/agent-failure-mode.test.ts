import { describe, expect, it } from 'vitest'
import {
  AGENT_TEST_FAILURE_MODES,
  failureModeCounts,
  failureModeFor,
  isAgentTestFailureMode,
} from '../src/agent/failure-mode.js'
import type { AgentTestFailureKind, AgentTestFailureMode, AgentTestFailureSource } from '../src/agent/types.js'

describe('agent failure-mode taxonomy', () => {
  it('exposes exactly the eight standardized failure modes', () => {
    expect(AGENT_TEST_FAILURE_MODES).toEqual([
      'input',
      'authentication',
      'environment',
      'locator_navigation',
      'business_assertion',
      'mutation_cleanup',
      'agent_execution',
      'infrastructure',
    ])
  })

  it('accepts only the canonical mode names', () => {
    expect(isAgentTestFailureMode('locator_navigation')).toBe(true)
    expect(isAgentTestFailureMode('unknown-mode')).toBe(false)
  })

  // One probe per failure mode: each mode must be expressible and map
  // deterministically from a concrete (failureSource, failureKind) pair so the
  // eval report can slice results beyond a single pass rate.
  const probes: Array<{ mode: AgentTestFailureMode; source: AgentTestFailureSource; kind: AgentTestFailureKind }> = [
    { mode: 'input', source: 'input', kind: 'validation' },
    { mode: 'authentication', source: 'environment', kind: 'authentication' },
    { mode: 'environment', source: 'environment', kind: 'environment' },
    { mode: 'locator_navigation', source: 'agent_execution', kind: 'locator' },
    { mode: 'business_assertion', source: 'product', kind: 'assertion' },
    { mode: 'mutation_cleanup', source: 'agent_execution', kind: 'mutation' },
    { mode: 'agent_execution', source: 'agent_execution', kind: 'execution' },
    { mode: 'infrastructure', source: 'infrastructure', kind: 'execution' },
  ]

  it('maps every failure mode from a concrete classification', () => {
    for (const probe of probes) {
      expect(failureModeFor(probe.source, probe.kind)).toBe(probe.mode)
    }
  })

  it('can fail: an unknown classification collapses to agent_execution, never silently to passed', () => {
    expect(failureModeFor('agent_execution', undefined)).toBe('agent_execution')
    expect(failureModeFor(undefined, undefined)).toBe('agent_execution')
  })

  it('counts non-passed cases into the eight buckets', () => {
    const counts = failureModeCounts([
      { failureSource: 'product', failureKind: 'assertion' },
      { failureSource: 'product', failureKind: 'data' },
      { failureSource: 'input', failureKind: 'validation' },
      { failureSource: 'agent_execution', failureKind: 'mutation' },
    ])
    expect(counts).toEqual({
      business_assertion: 2,
      input: 1,
      mutation_cleanup: 1,
    })
  })

  it('excludes passed cases with no failure classification from the distribution', () => {
    const counts = failureModeCounts([
      {},
      {},
      { failureSource: 'product', failureKind: 'assertion' },
    ])
    expect(counts).toEqual({ business_assertion: 1 })
  })
})
