import { homedir } from 'node:os'
import { posix, resolve, win32 } from 'node:path'
import { readFile } from 'node:fs/promises'

export type CodexWireApi = 'responses' | 'chat'
export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface ModelProfile {
  id: string
  /** Model name passed to Codex (e.g. "glm-4.6"). */
  model: string
  /** The [model_providers.<id>] section name written into config.toml. */
  providerId: string
  /** Provider base URL. */
  baseUrl: string
  /** Codex wire API protocol. */
  wireApi: CodexWireApi
  /** Environment variable that holds the API key for this provider. */
  envKey: string
  /** Optional model_reasoning_effort override. */
  reasoningEffort?: CodexReasoningEffort
  /** Optional service_tier override. */
  serviceTier?: string
  /** Optional capacity hints used by the adaptive Codex epoch scheduler. */
  contextWindowTokens?: number
  maxOutputTokens?: number
  caseOutputTokens?: number
  targetContextRatio?: number
  targetOutputRatio?: number
}

export interface ModelProfileRegistry {
  version: '1.0'
  /** Profile used when --model-profile is omitted. */
  defaultProfileId?: string
  profiles: ModelProfile[]
}

export function defaultModelProfileRegistryPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  const pathApi = platform === 'win32' ? win32 : posix
  const configHome = environment.XDG_CONFIG_HOME || (
    platform === 'win32'
      ? environment.APPDATA || pathApi.resolve(homeDirectory, 'AppData', 'Roaming')
      : pathApi.resolve(homeDirectory, '.config')
  )
  return pathApi.resolve(configHome, 'auto-test', 'model-profiles.json')
}

function parseJson(content: string): unknown {
  return JSON.parse(content.replace(/^\uFEFF/, '')) as unknown
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value
}

function validateProfile(raw: unknown): ModelProfile {
  if (!raw || typeof raw !== 'object') throw new Error('model profile must be an object')
  const record = raw as Record<string, unknown>
  const profile: ModelProfile = {
    id: requireString(record.id, 'model profile id'),
    model: requireString(record.model, 'model profile model'),
    providerId: requireString(record.providerId, 'model profile providerId'),
    baseUrl: requireString(record.baseUrl, 'model profile baseUrl'),
    wireApi: requireString(record.wireApi, 'model profile wireApi') as CodexWireApi,
    envKey: requireString(record.envKey, 'model profile envKey'),
  }
  if (profile.wireApi !== 'responses' && profile.wireApi !== 'chat') {
    throw new Error(`model profile ${profile.id} wireApi must be "responses" or "chat"`)
  }
  try {
    if (new URL(profile.baseUrl).protocol !== 'https:' && new URL(profile.baseUrl).protocol !== 'http:') {
      throw new Error('unsupported protocol')
    }
  } catch {
    throw new Error(`model profile ${profile.id} baseUrl must be a valid HTTP(S) URL`)
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.envKey)) {
    throw new Error(`model profile ${profile.id} envKey must be a valid environment variable name`)
  }
  if (record.reasoningEffort !== undefined) {
    const effort = requireString(record.reasoningEffort, `model profile ${profile.id} reasoningEffort`)
    if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) {
      throw new Error(`model profile ${profile.id} reasoningEffort must be minimal|low|medium|high|xhigh`)
    }
    profile.reasoningEffort = effort as CodexReasoningEffort
  }
  if (record.serviceTier !== undefined) {
    profile.serviceTier = requireString(record.serviceTier, `model profile ${profile.id} serviceTier`)
  }
  for (const [key, minimum] of [
    ['contextWindowTokens', 1],
    ['maxOutputTokens', 1],
    ['caseOutputTokens', 1],
  ] as const) {
    const value = record[key]
    if (value !== undefined) {
      if (!Number.isInteger(value) || (value as number) < minimum) throw new Error(`model profile ${profile.id} ${key} must be a positive integer`)
      profile[key] = value as never
    }
  }
  for (const key of ['targetContextRatio', 'targetOutputRatio'] as const) {
    const value = record[key]
    if (value !== undefined) {
      if (typeof value !== 'number' || value <= 0 || value >= 1) throw new Error(`model profile ${profile.id} ${key} must be between 0 and 1`)
      profile[key] = value
    }
  }
  return profile
}

export async function loadModelProfileRegistry(path: string): Promise<ModelProfileRegistry> {
  const raw = parseJson(await readFile(path, 'utf8'))
  if (!raw || typeof raw !== 'object') throw new Error('model profile registry must be an object')
  const record = raw as Record<string, unknown>
  if (record.version !== '1.0') throw new Error('model profile registry version must be "1.0"')
  const profilesRaw = record.profiles
  if (!Array.isArray(profilesRaw)) throw new Error('model profile registry profiles must be an array')
  const profiles = profilesRaw.map(validateProfile)
  const ids = new Set<string>()
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new Error(`duplicate model profile id: ${profile.id}`)
    ids.add(profile.id)
  }
  const rawDefault = record.defaultProfileId
  let defaultProfileId: string | undefined
  if (rawDefault !== undefined && rawDefault !== null) {
    defaultProfileId = requireString(rawDefault, 'defaultProfileId')
    if (!ids.has(defaultProfileId)) {
      throw new Error(`defaultProfileId ${defaultProfileId} does not match any registered model profile`)
    }
  }
  return { version: '1.0', ...(defaultProfileId !== undefined ? { defaultProfileId } : {}), profiles }
}

export interface ModelProfileSelection {
  profile: ModelProfile
  /** True when the profile was chosen by an explicit --model-profile request. */
  explicit: boolean
}

/**
 * Resolve the model profile for a run. When `requestedId` is provided it must
 * exist. Otherwise the registry default is used; failing that, a single
 * registered profile is used. An empty registry returns undefined so callers
 * can fall back to the source Codex config.
 */
export function selectModelProfile(
  registry: ModelProfileRegistry | undefined,
  requestedId?: string,
): ModelProfileSelection | undefined {
  if (!registry || registry.profiles.length === 0) return undefined
  if (requestedId) {
    const profile = registry.profiles.find((candidate) => candidate.id === requestedId)
    if (!profile) throw new Error(`未找到模型 Profile：${requestedId}`)
    return { profile, explicit: true }
  }
  if (registry.defaultProfileId) {
    const profile = registry.profiles.find((candidate) => candidate.id === registry.defaultProfileId)
    if (!profile) throw new Error(`defaultProfileId ${registry.defaultProfileId} does not match any registered model profile`)
    return { profile, explicit: false }
  }
  if (registry.profiles.length === 1) return { profile: registry.profiles[0]!, explicit: false }
  throw new Error(
    `找到多个模型 Profile（${registry.profiles.map((profile) => profile.id).join('、')}），请使用 --model-profile 指定，或在注册表中设置 defaultProfileId。`,
  )
}
