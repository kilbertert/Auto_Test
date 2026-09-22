import {
  normalizeEnvironmentOrigin,
  openRunArtifactStoreForRun,
  runRootForJournalArtifact,
  type EnvironmentAccessResult,
  type EnvironmentRequirementInput,
  type RunArtifactStore,
} from './run-artifact-store.js'
import type { CodexTestCaseResult, CodexTestEnvironmentRequirement } from './types.js'

/**
 * This module is a set of compatibility delegates over the RunArtifactStore,
 * plus the event-inference helper that has no journal artifact of its own. The
 * store owns where the prerequisite journal lives, how one entry is recorded
 * and transitioned, and which stored entries may be read back; the signatures
 * here remain for callers that still pass an artifact path, and go away with
 * the last of them.
 */
export type { EnvironmentAccessResult, EnvironmentRequirementInput } from './run-artifact-store.js'
export { normalizeEnvironmentOrigin } from './run-artifact-store.js'

function storeFor(artifactPath: string): Promise<RunArtifactStore> {
  return openRunArtifactStoreForRun(runRootForJournalArtifact(artifactPath))
}

export async function recordEnvironmentRequirement(options: {
  requirementsPath: string
  requirement: EnvironmentRequirementInput
}): Promise<CodexTestEnvironmentRequirement> {
  return (await storeFor(options.requirementsPath)).recordEnvironmentRequirement(options.requirement)
}

export async function satisfyEnvironmentRequirement(options: {
  requirementsPath: string
  id: string
  evidence: string[]
}): Promise<CodexTestEnvironmentRequirement> {
  return (await storeFor(options.requirementsPath)).satisfyEnvironmentRequirement({
    id: options.id,
    evidence: options.evidence,
  })
}

export async function requestEnvironmentAccess(options: {
  allowedOrigins: string[]
  requirementsPath: string
  origin: string
  reason: string
  evidence: string[]
  caseIds: string[]
}): Promise<EnvironmentAccessResult> {
  return (await storeFor(options.requirementsPath)).requestEnvironmentAccess({
    allowedOrigins: options.allowedOrigins,
    origin: options.origin,
    reason: options.reason,
    evidence: options.evidence,
    caseIds: options.caseIds,
  })
}

export async function readEnvironmentRequirements(path: string): Promise<CodexTestEnvironmentRequirement[]> {
  const requirements = await (await storeFor(path)).readEnvironmentRequirements()
  if (requirements.problems.length > 0) throw new Error(requirements.problems.join('; '))
  return requirements.entries
}

export async function reconcileEnvironmentRequirements(
  path: string,
  allowedOrigins: string[],
): Promise<CodexTestEnvironmentRequirement[]> {
  return (await storeFor(path)).reconcileEnvironmentRequirements(allowedOrigins)
}

export async function reconcileEnvironmentRequirementCaseLinks(
  path: string,
  cases: Array<Pick<CodexTestCaseResult, 'caseId' | 'failureSource' | 'environmentRequirementIds'>>,
): Promise<CodexTestEnvironmentRequirement[]> {
  return (await storeFor(path)).reconcileEnvironmentRequirementCaseLinks(cases)
}

export function blockedNavigationOriginsFromEvents(events: string, allowedOrigins: string[]): string[] {
  const found = new Set<string>()
  for (const line of events.split(/\r?\n/)) {
    if (!line) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const item = (event as { item?: { type?: string; tool?: string; result?: unknown } }).item
    if (item?.type !== 'mcp_tool_call' || item.tool !== 'browser_navigate') continue
    const serialized = JSON.stringify(item.result ?? '')
    if (!/ERR_BLOCKED_BY_CLIENT/i.test(serialized)) continue
    for (const match of serialized.matchAll(/https?:\/\/[^\s"'\\]+/g)) {
      try {
        const origin = normalizeEnvironmentOrigin(match[0])
        if (!allowedOrigins.includes(origin)) found.add(origin)
      } catch {
        // Ignore URLs that are only fragments of an error message.
      }
    }
  }
  return [...found]
}
