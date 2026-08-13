import type { AgentTestFailureKind, AgentTestFailureMode, AgentTestFailureSource } from './types.js'

/**
 * The canonical eight failure modes used to slice an eval report. This module
 * is deliberately a pure, deterministic mapping over the two result fields the
 * AgentHost already emits (failureSource + failureKind); it does not introduce
 * a second classifier or let the model grade itself.
 */
export const AGENT_TEST_FAILURE_MODES: readonly AgentTestFailureMode[] = [
  'input',
  'authentication',
  'environment',
  'locator_navigation',
  'business_assertion',
  'mutation_cleanup',
  'agent_execution',
  'infrastructure',
] as const

export function isAgentTestFailureMode(value: unknown): value is AgentTestFailureMode {
  return typeof value === 'string' && (AGENT_TEST_FAILURE_MODES as readonly string[]).includes(value)
}

/**
 * Map a result's two classification dimensions into one standardized mode.
 * The precedence is chosen so that the most specific, actionable bucket wins:
 *
 * - input source is always an input problem;
 * - authentication kind is always an authentication problem (whether it
 *   surfaced as an environment prerequisite or an execution failure);
 * - a product-sourced mismatch is a business assertion failure;
 * - locator/mutation kinds are the new explicit navigation and cleanup modes;
 * - everything else falls back to environment / agent_execution /
 *   infrastructure by source.
 */
export function failureModeFor(
  source: AgentTestFailureSource | undefined,
  kind: AgentTestFailureKind | undefined,
): AgentTestFailureMode {
  if (source === 'input') return 'input'
  if (kind === 'authentication') return 'authentication'
  if (source === 'infrastructure') return 'infrastructure'
  if (source === 'product') return 'business_assertion'
  if (kind === 'locator') return 'locator_navigation'
  if (kind === 'mutation') return 'mutation_cleanup'
  if (source === 'environment') return 'environment'
  if (source === 'agent_execution') return 'agent_execution'
  return 'agent_execution'
}

/**
 * Counts non-passed cases into the eight standardized failure modes. Passed
 * cases have no failure classification and are intentionally absent from the
 * result so an empty mode map means "no failures", not "unclassified".
 */
export function failureModeCounts(
  cases: Array<{ failureSource?: AgentTestFailureSource; failureKind?: AgentTestFailureKind }>,
): Partial<Record<AgentTestFailureMode, number>> {
  const counts: Partial<Record<AgentTestFailureMode, number>> = {}
  for (const item of cases) {
    // Passed cases carry no failure classification; skip them so the fallback
    // mode never turns a passed case into a phantom `agent_execution` failure.
    if (item.failureSource === undefined && item.failureKind === undefined) continue
    const mode = failureModeFor(item.failureSource, item.failureKind)
    counts[mode] = (counts[mode] ?? 0) + 1
  }
  return counts
}
