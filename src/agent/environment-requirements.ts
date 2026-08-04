import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writePrivateJson } from './state.js'
import type { CodexTestCaseResult, CodexTestEnvironmentRequirement, CodexTestEnvironmentRequirementKind } from './types.js'

export interface EnvironmentAccessResult {
  status: 'allowed' | 'blocked'
  origin: string
  requirementId?: string
  reason?: string
  evidence?: string[]
  requestedAt?: string
  nextAction?: string
}

export interface EnvironmentRequirementInput {
  caseIds: string[]
  kind: CodexTestEnvironmentRequirementKind
  origin?: string
  condition: string
  evidence: string[]
}

export function normalizeEnvironmentOrigin(value: string): string {
  const parsed = new URL(value)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Origin must use http or https')
  return parsed.origin
}

function stableRequirementId(input: Pick<EnvironmentRequirementInput, 'kind' | 'origin' | 'condition'>): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([input.kind, input.origin ?? '', input.condition.trim()]))
    .digest('hex')
    .slice(0, 16)
  return `environment-${input.kind}-${fingerprint}`
}

function normalizeRequirement(input: unknown): CodexTestEnvironmentRequirement {
  const item = input as Partial<CodexTestEnvironmentRequirement> & { reason?: unknown }
  const kind = item.kind === 'permission' || item.kind === 'authentication' || item.kind === 'test_data' || item.kind === 'physical'
    ? item.kind
    : 'origin'
  const origin = typeof item.origin === 'string' && item.origin.trim()
    ? normalizeEnvironmentOrigin(item.origin)
    : undefined
  const condition = typeof item.condition === 'string' && item.condition.trim()
    ? item.condition.trim()
    : typeof item.reason === 'string' && item.reason.trim()
      ? item.reason.trim()
      : 'An environment prerequisite was recorded without a condition.'
  const normalized: CodexTestEnvironmentRequirement = {
    id: typeof item.id === 'string' && item.id.trim()
      ? item.id.trim()
      : stableRequirementId({ kind, ...(origin ? { origin } : {}), condition }),
    caseIds: Array.isArray(item.caseIds)
      ? [...new Set(item.caseIds.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())))]
      : [],
    kind,
    ...(origin ? { origin } : {}),
    condition,
    evidence: Array.isArray(item.evidence)
      ? [...new Set(item.evidence.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())))]
      : [],
    status: item.status === 'satisfied' || item.status === 'superseded' ? item.status : 'pending',
    requestedAt: typeof item.requestedAt === 'string' && item.requestedAt.trim()
      ? item.requestedAt
      : new Date(0).toISOString(),
  }
  return normalized
}

async function readRequirements(path: string): Promise<CodexTestEnvironmentRequirement[]> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!Array.isArray(raw)) throw new Error('Environment requirements must be an array')
    return raw.map(normalizeRequirement)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function recordEnvironmentRequirement(options: {
  requirementsPath: string
  requirement: EnvironmentRequirementInput
}): Promise<CodexTestEnvironmentRequirement> {
  const caseIds = [...new Set(options.requirement.caseIds.map((value) => value.trim()).filter(Boolean))]
  if (caseIds.length === 0) throw new Error('Environment requirement must apply to at least one test case')
  const condition = options.requirement.condition.trim()
  if (!condition) throw new Error('Environment requirement must state the observed missing condition')
  const evidence = [...new Set(options.requirement.evidence.map((value) => value.trim()).filter(Boolean))]
  if (evidence.length === 0) throw new Error('Environment requirement must include saved evidence')
  const origin = options.requirement.origin ? normalizeEnvironmentOrigin(options.requirement.origin) : undefined
  if (options.requirement.kind === 'origin' && !origin) throw new Error('Origin requirements must include an origin')
  const id = stableRequirementId({ kind: options.requirement.kind, ...(origin ? { origin } : {}), condition })
  const requirements = await readRequirements(options.requirementsPath)
  const existingIndex = requirements.findIndex((item) => item.id === id)
  const requirement: CodexTestEnvironmentRequirement = existingIndex >= 0
    ? {
        ...requirements[existingIndex]!,
        caseIds: [...new Set([...requirements[existingIndex]!.caseIds, ...caseIds])],
        evidence: [...new Set([...requirements[existingIndex]!.evidence, ...evidence])],
        status: 'pending',
        requestedAt: new Date().toISOString(),
      }
    : {
        id,
        caseIds,
        kind: options.requirement.kind,
        ...(origin ? { origin } : {}),
        condition,
        evidence,
        status: 'pending',
        requestedAt: new Date().toISOString(),
      }
  if (existingIndex >= 0) requirements[existingIndex] = requirement
  else requirements.push(requirement)
  await writePrivateJson(options.requirementsPath, requirements)
  return requirement
}

export async function satisfyEnvironmentRequirement(options: {
  requirementsPath: string
  id: string
  evidence: string[]
}): Promise<CodexTestEnvironmentRequirement> {
  const evidence = [...new Set(options.evidence.map((value) => value.trim()).filter(Boolean))]
  if (evidence.length === 0) throw new Error('Satisfied environment requirements must include saved evidence')
  const requirements = await readRequirements(options.requirementsPath)
  const index = requirements.findIndex((item) => item.id === options.id)
  if (index < 0) throw new Error(`Unknown environment requirement: ${options.id}`)
  const requirement: CodexTestEnvironmentRequirement = {
    ...requirements[index]!,
    status: 'satisfied',
    evidence: [...new Set([...requirements[index]!.evidence, ...evidence])],
  }
  requirements[index] = requirement
  await writePrivateJson(options.requirementsPath, requirements)
  return requirement
}

export async function requestEnvironmentAccess(options: {
  allowedOrigins: string[]
  requirementsPath: string
  origin: string
  reason: string
  evidence: string[]
  caseIds: string[]
}): Promise<EnvironmentAccessResult> {
  const origin = normalizeEnvironmentOrigin(options.origin)
  if (options.allowedOrigins.includes(origin)) return { status: 'allowed', origin }
  if (options.caseIds.length === 0) throw new Error('Environment access requests must apply to at least one test case')
  if (options.evidence.length === 0) throw new Error('Environment access requests must include saved evidence')
  const requirements = await readRequirements(options.requirementsPath)
  const existing = requirements.find((item) => item.kind === 'origin' && item.origin === origin)
  if (existing) {
    const updated = await recordEnvironmentRequirement({
      requirementsPath: options.requirementsPath,
      requirement: {
        caseIds: options.caseIds,
        kind: 'origin',
        origin,
        condition: existing.condition,
        evidence: options.evidence,
      },
    })
    return {
      status: 'blocked',
      origin: updated.origin!,
      requirementId: updated.id,
      reason: updated.condition,
      evidence: updated.evidence,
      requestedAt: updated.requestedAt,
      nextAction: 'Register this origin in the Environment Profile, then resume the same run.',
    }
  }
  const requirement = await recordEnvironmentRequirement({
    requirementsPath: options.requirementsPath,
    requirement: {
      caseIds: options.caseIds,
      kind: 'origin',
      origin,
      condition: options.reason,
      evidence: options.evidence,
    },
  })
  return {
    status: 'blocked',
    origin: requirement.origin!,
    requirementId: requirement.id,
    reason: requirement.condition,
    evidence: requirement.evidence,
    requestedAt: requirement.requestedAt,
    nextAction: 'Register this origin in the Environment Profile, then resume the same run.',
  }
}

export async function readEnvironmentRequirements(path: string): Promise<CodexTestEnvironmentRequirement[]> {
  return readRequirements(path)
}

export async function reconcileEnvironmentRequirements(
  path: string,
  allowedOrigins: string[],
): Promise<CodexTestEnvironmentRequirement[]> {
  const requirements = await readRequirements(path)
  let changed = false
  const reconciled = requirements.map((item) => {
    if (item.kind === 'origin' && item.origin && item.status === 'pending' && allowedOrigins.includes(item.origin)) {
      changed = true
      return { ...item, status: 'satisfied' as const }
    }
    return item
  })
  if (changed) await writePrivateJson(path, reconciled)
  return reconciled
}

export async function reconcileEnvironmentRequirementCaseLinks(
  path: string,
  cases: Array<Pick<CodexTestCaseResult, 'caseId' | 'failureSource' | 'environmentRequirementIds'>>,
): Promise<CodexTestEnvironmentRequirement[]> {
  const requirements = await readRequirements(path)
  const resultByCaseId = new Map(cases.map((item) => [item.caseId, item]))
  let changed = false
  const reconciled = requirements.map((requirement) => {
    if (requirement.status !== 'pending') return requirement
    const caseIds = requirement.caseIds.filter((caseId) => {
      const result = resultByCaseId.get(caseId)
      if (!result) return true
      if (result.failureSource !== 'environment') return false
      if (result.environmentRequirementIds?.includes(requirement.id)) return true
      return !result.environmentRequirementIds?.length
    })
    if (caseIds.length === requirement.caseIds.length) return requirement
    changed = true
    return caseIds.length > 0
      ? { ...requirement, caseIds }
      : { ...requirement, status: 'superseded' as const }
  })
  if (changed) await writePrivateJson(path, reconciled)
  return reconciled
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
