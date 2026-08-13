import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_FANOUT_POLICY,
  fanoutPolicyProblems,
} from '../src/agent/fanout-policy.js'

describe('bounded fan-out policy', () => {
  it('ships a read-only, serialized default', () => {
    expect(DEFAULT_AGENT_FANOUT_POLICY).toMatchObject({
      version: '1.0',
      maxConcurrency: 1,
      writeFanout: false,
    })
    expect(fanoutPolicyProblems(DEFAULT_AGENT_FANOUT_POLICY)).toEqual([])
  })

  it('rejects invalid policies', () => {
    expect(fanoutPolicyProblems(null)).toContain('fanout policy must be a JSON object')
    expect(fanoutPolicyProblems({ ...DEFAULT_AGENT_FANOUT_POLICY, maxConcurrency: 0 }))
      .toContain('fanout policy maxConcurrency must be a positive integer')
    expect(fanoutPolicyProblems({ ...DEFAULT_AGENT_FANOUT_POLICY, scopes: ['bogus'] }))
      .toContain('fanout policy contains an unknown scope: bogus')
  })
})
