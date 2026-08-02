import { readFile } from 'node:fs/promises'
import { writePrivateJson } from './state.js'
import type { CodexTestEnvironmentRequirement } from './types.js'

export interface EnvironmentAccessResult {
  status: 'allowed' | 'blocked'
  origin: string
  reason?: string
  evidence?: string[]
  requestedAt?: string
  nextAction?: string
}

export function normalizeEnvironmentOrigin(value: string): string {
  const parsed = new URL(value)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Origin must use http or https')
  return parsed.origin
}

async function readRequirements(path: string): Promise<CodexTestEnvironmentRequirement[]> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as CodexTestEnvironmentRequirement[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function requestEnvironmentAccess(options: {
  allowedOrigins: string[]
  requirementsPath: string
  origin: string
  reason: string
  evidence: string[]
}): Promise<EnvironmentAccessResult> {
  const origin = normalizeEnvironmentOrigin(options.origin)
  if (options.allowedOrigins.includes(origin)) return { status: 'allowed', origin }
  const requirements = await readRequirements(options.requirementsPath)
  const existing = requirements.find((item) => item.origin === origin)
  if (existing) {
    return {
      status: 'blocked',
      origin: existing.origin,
      reason: existing.reason,
      evidence: existing.evidence,
      requestedAt: existing.requestedAt,
      nextAction: 'Register this origin in the Environment Profile, then resume the same run.',
    }
  }
  const requirement: CodexTestEnvironmentRequirement = {
    origin,
    reason: options.reason,
    evidence: [...new Set(options.evidence)],
    status: 'pending',
    requestedAt: new Date().toISOString(),
  }
  requirements.push(requirement)
  await writePrivateJson(options.requirementsPath, requirements)
  return {
    status: 'blocked',
    origin: requirement.origin,
    reason: requirement.reason,
    evidence: requirement.evidence,
    requestedAt: requirement.requestedAt,
    nextAction: 'Register this origin in the Environment Profile, then resume the same run.',
  }
}

export async function readEnvironmentRequirements(path: string): Promise<CodexTestEnvironmentRequirement[]> {
  return readRequirements(path)
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
