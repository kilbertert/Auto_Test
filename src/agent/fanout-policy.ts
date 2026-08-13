/**
 * Bounded fan-out is a read-only analysis affordance, never a default write
 * fan-out. This policy is owned by Core (declared in the immutable control
 * contract), so the AgentHost sees one authoritative limit rather than a
 * prompt-only convention.
 *
 * The policy is declarative, not a per-task gate: Core validates it and
 * exposes it through the Control MCP `test_contract`, but does not intercept
 * the AgentHost's internal sub-agent calls, so honoring it is the agent's
 * responsibility rather than a deterministic enforcement point.
 */

export type AgentFanoutScope = 'readonly-analysis' | 'offline-evidence'

export interface AgentFanoutPolicy {
  version: '1.0'
  /** Maximum concurrent fan-out tasks. 1 means serialized (effectively disabled). */
  maxConcurrency: number
  /** When false (the shipped default), fan-out may only perform read-only analysis. */
  writeFanout: boolean
  /** Scopes where bounded fan-out is permitted. */
  scopes: AgentFanoutScope[]
}

export const DEFAULT_AGENT_FANOUT_POLICY: AgentFanoutPolicy = {
  version: '1.0',
  maxConcurrency: 1,
  writeFanout: false,
  scopes: ['readonly-analysis', 'offline-evidence'],
}

const FANOUT_SCOPES: readonly AgentFanoutScope[] = ['readonly-analysis', 'offline-evidence']

export function fanoutPolicyProblems(policy: unknown): string[] {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return ['fanout policy must be a JSON object']
  }
  const value = policy as Record<string, unknown>
  const problems: string[] = []
  if (value.version !== '1.0') problems.push('fanout policy version must be "1.0"')
  if (!Number.isInteger(value.maxConcurrency) || (value.maxConcurrency as number) < 1) {
    problems.push('fanout policy maxConcurrency must be a positive integer')
  }
  if (typeof value.writeFanout !== 'boolean') problems.push('fanout policy writeFanout must be a boolean')
  if (!Array.isArray(value.scopes) || value.scopes.length === 0) {
    problems.push('fanout policy scopes must be a non-empty array')
  } else {
    const seen = new Set<string>()
    for (const scope of value.scopes) {
      if (!FANOUT_SCOPES.includes(scope as AgentFanoutScope)) {
        problems.push(`fanout policy contains an unknown scope: ${String(scope)}`)
      }
      if (seen.has(String(scope))) problems.push(`fanout policy repeats scope: ${String(scope)}`)
      seen.add(String(scope))
    }
  }
  return problems
}
