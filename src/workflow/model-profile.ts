import { homedir } from 'node:os'
import { posix, resolve, win32 } from 'node:path'
import { readFile } from 'node:fs/promises'
import { AGENT_MODEL_APIS } from '../agent/host.js'
import type {
  AgentModelApi,
  AgentModelInputModality,
  AgentModelProviderDescriptor,
  AgentModelReasoningEffort,
} from '../agent/host.js'

/** @deprecated Registry readers still accept wireApi, but normalized profiles use api. */
export type CodexWireApi = 'responses' | 'chat'
export type ModelReasoningEffort = AgentModelReasoningEffort
/** @deprecated Use ModelReasoningEffort. */
export type CodexReasoningEffort = ModelReasoningEffort

export const DEFAULT_MODEL_PROFILE_ID = 'deepseek'

export const RUNTIME_MODEL_PROFILE_ENV = {
  profileId: 'AUTO_TEST_MODEL_PROFILE_ID',
  providerId: 'AUTO_TEST_MODEL_PROVIDER_ID',
  model: 'AUTO_TEST_MODEL_ID',
  baseUrl: 'AUTO_TEST_MODEL_BASE_URL',
  api: 'AUTO_TEST_MODEL_API',
  envKey: 'AUTO_TEST_MODEL_ENV_KEY',
} as const

export interface ModelProfile {
  id: string
  /** Model identifier interpreted by the selected AgentHost adapter. */
  model: string
  /** Stable provider identifier used by host-native configuration. */
  providerId: string
  /** Provider base URL. */
  baseUrl: string
  /** Host-neutral model API protocol. */
  api: AgentModelApi
  /** Environment variable that holds the API key for this provider. */
  envKey: string
  /** Optional aliases accepted when a provider uses a different house convention. */
  envKeyAliases?: string[]
  /** Optional short names accepted by --model-profile. */
  aliases?: string[]
  /** Optional display label used by interactive diagnostics. */
  displayName?: string
  /** Optional reasoning effort translated by the selected host. */
  reasoningEffort?: ModelReasoningEffort
  /** Reasoning efforts the endpoint accepts. */
  reasoningEfforts?: ModelReasoningEffort[]
  /** Input modalities accepted by the selected model endpoint. */
  inputModalities?: AgentModelInputModality[]
  /** Whether the endpoint can execute independent tool calls concurrently. */
  supportsParallelToolCalls?: boolean
  /** Whether the endpoint exposes a provider-side search tool to the host. */
  supportsSearchTool?: boolean
  /** Optional service tier translated by hosts that support it. */
  serviceTier?: string
  /** Whether the selected provider can accept a WebSocket model transport. */
  supportsWebsockets?: boolean
  /** Optional capacity hints used by the adaptive AgentHost epoch scheduler. */
  contextWindowTokens?: number
  maxOutputTokens?: number
  caseOutputTokens?: number
  targetContextRatio?: number
  targetOutputRatio?: number
}

export function isValidModelProfileProviderId(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)
}

/**
 * Provider presets are deliberately metadata-only. API keys are resolved from
 * the process environment and never belong in this source-controlled catalog.
 * Both endpoints expose an OpenAI-compatible Responses surface. Each
 * AgentHost translates that protocol into its own native configuration.
 */
export const BUILT_IN_MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: 'deepseek',
    aliases: ['deepseek-v4-flash'],
    displayName: 'DeepSeek V4 Flash',
    model: 'deepseek-v4-flash',
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    api: 'openai-responses',
    envKey: 'DEEPSEEK_API_KEY',
    reasoningEffort: 'high',
    reasoningEfforts: ['low', 'high', 'xhigh'],
    inputModalities: ['text'],
    supportsParallelToolCalls: true,
    supportsSearchTool: true,
    supportsWebsockets: false,
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 393_216,
  },
  {
    id: 'volcengine',
    aliases: ['glm-5.2', 'volcengine-glm-5.2'],
    displayName: '火山方舟 Coding Plan (GLM-5.2)',
    model: 'glm-5.2',
    providerId: 'volcengine_coding',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    api: 'openai-responses',
    envKey: 'ARK_API_KEY',
    envKeyAliases: ['VOLCENGINE_API_KEY', 'VOLCENGINE_ARK_API_KEY'],
    reasoningEffort: 'high',
    reasoningEfforts: ['low', 'medium', 'high'],
    inputModalities: ['text'],
    supportsWebsockets: false,
    contextWindowTokens: 1_024_000,
    maxOutputTokens: 65_536,
  },
] as const

export function builtInModelProfileRegistry(): ModelProfileRegistry {
  return {
    version: '1.0',
    defaultProfileId: DEFAULT_MODEL_PROFILE_ID,
    profiles: BUILT_IN_MODEL_PROFILES.map((profile) => ({
      ...profile,
      ...(profile.aliases ? { aliases: [...profile.aliases] } : {}),
      ...(profile.envKeyAliases ? { envKeyAliases: [...profile.envKeyAliases] } : {}),
      ...(profile.reasoningEfforts ? { reasoningEfforts: [...profile.reasoningEfforts] } : {}),
      ...(profile.inputModalities ? { inputModalities: [...profile.inputModalities] } : {}),
    })),
  }
}

/**
 * Read a secret-free, process-scoped default provider descriptor. Portable
 * launchers use this for a private package whose endpoint is not one of the
 * built-ins. The credential value remains in the separately named env var.
 */
export function runtimeModelProfileFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ModelProfile | undefined {
  const values = Object.fromEntries(
    Object.entries(RUNTIME_MODEL_PROFILE_ENV).map(([field, name]) => [field, environment[name]?.trim()]),
  ) as Record<keyof typeof RUNTIME_MODEL_PROFILE_ENV, string | undefined>
  // Base URL and model are also accepted as private-package build inputs. They
  // do not activate a runtime Profile unless one of the runtime-only identity
  // fields is present.
  const runtimeIdentityConfigured = [values.profileId, values.providerId, values.api, values.envKey]
    .some((value) => value !== undefined && value !== '')
  if (!runtimeIdentityConfigured) return undefined
  const missing = Object.entries(values).filter(([, value]) => !value).map(([field]) => field)
  if (missing.length > 0) {
    throw new Error(`runtime model profile environment is incomplete: missing ${missing.join(', ')}`)
  }
  return validateProfile({
    id: values.profileId,
    providerId: values.providerId,
    model: values.model,
    baseUrl: values.baseUrl,
    api: values.api,
    envKey: values.envKey,
    inputModalities: ['text'],
  })
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

function optionalStringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`)
  const values = value.map((item, index) => requireString(item, `${label}[${index}]`))
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`)
  return values
}

const MODEL_APIS = new Set<AgentModelApi>(AGENT_MODEL_APIS)

function apiFromLegacyWireApi(value: unknown, label: string): AgentModelApi | undefined {
  if (value === undefined) return undefined
  const wireApi = requireString(value, label)
  if (wireApi === 'responses') return 'openai-responses'
  if (wireApi === 'chat') return 'openai-completions'
  throw new Error(`${label} must be "responses" or "chat"`)
}

function normalizedModelApi(record: Record<string, unknown>, profileId: string): AgentModelApi {
  const legacyApi = apiFromLegacyWireApi(record.wireApi, `model profile ${profileId} wireApi`)
  if (record.api === undefined) {
    if (legacyApi) return legacyApi
    throw new Error(`model profile ${profileId} api must be a supported model API`)
  }
  const api = requireString(record.api, `model profile ${profileId} api`) as AgentModelApi
  if (!MODEL_APIS.has(api)) {
    throw new Error(`model profile ${profileId} api is not supported: ${api}`)
  }
  if (legacyApi && legacyApi !== api) {
    throw new Error(`model profile ${profileId} api conflicts with legacy wireApi`)
  }
  return api
}

function validateProfile(raw: unknown): ModelProfile {
  if (!raw || typeof raw !== 'object') throw new Error('model profile must be an object')
  const record = raw as Record<string, unknown>
  const id = requireString(record.id, 'model profile id')
  const profile: ModelProfile = {
    id,
    model: requireString(record.model, 'model profile model'),
    providerId: requireString(record.providerId, 'model profile providerId'),
    baseUrl: requireString(record.baseUrl, 'model profile baseUrl'),
    api: normalizedModelApi(record, id),
    envKey: requireString(record.envKey, 'model profile envKey'),
  }
  if (!isValidModelProfileProviderId(profile.providerId)) {
    throw new Error(`model profile ${profile.id} providerId must contain only letters, digits, underscores, or hyphens`)
  }
  try {
    const url = new URL(profile.baseUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('unsupported protocol')
    }
    if (url.username || url.password) throw new Error('embedded credentials')
  } catch {
    throw new Error(`model profile ${profile.id} baseUrl must be a valid HTTP(S) URL without embedded credentials`)
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.envKey)) {
    throw new Error(`model profile ${profile.id} envKey must be a valid environment variable name`)
  }
  const envKeyAliases = optionalStringList(record.envKeyAliases, `model profile ${profile.id} envKeyAliases`)
  if (envKeyAliases?.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error(`model profile ${profile.id} envKeyAliases must contain valid environment variable names`)
  }
  if (envKeyAliases?.includes(profile.envKey)) {
    throw new Error(`model profile ${profile.id} envKeyAliases must not repeat envKey`)
  }
  if (envKeyAliases?.length) profile.envKeyAliases = envKeyAliases
  const aliases = optionalStringList(record.aliases, `model profile ${profile.id} aliases`)
  if (aliases?.includes(profile.id)) throw new Error(`model profile ${profile.id} aliases must not repeat id`)
  if (aliases?.length) profile.aliases = aliases
  if (record.displayName !== undefined) profile.displayName = requireString(record.displayName, `model profile ${profile.id} displayName`)
  if (record.reasoningEffort !== undefined) {
    const effort = requireString(record.reasoningEffort, `model profile ${profile.id} reasoningEffort`)
    if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) {
      throw new Error(`model profile ${profile.id} reasoningEffort must be minimal|low|medium|high|xhigh`)
    }
    profile.reasoningEffort = effort as ModelReasoningEffort
  }
  const reasoningEfforts = optionalStringList(record.reasoningEfforts, `model profile ${profile.id} reasoningEfforts`)
  if (reasoningEfforts?.some((effort) => !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort))) {
    throw new Error(`model profile ${profile.id} reasoningEfforts contains an unsupported effort`)
  }
  if (profile.reasoningEffort && reasoningEfforts && !reasoningEfforts.includes(profile.reasoningEffort)) {
    throw new Error(`model profile ${profile.id} reasoningEfforts must include reasoningEffort`)
  }
  if (reasoningEfforts?.length) profile.reasoningEfforts = reasoningEfforts as ModelReasoningEffort[]
  const inputModalities = optionalStringList(record.inputModalities, `model profile ${profile.id} inputModalities`)
  if (inputModalities?.some((modality) => modality !== 'text' && modality !== 'image')) {
    throw new Error(`model profile ${profile.id} inputModalities must contain only text or image`)
  }
  if (inputModalities && !inputModalities.includes('text')) {
    throw new Error(`model profile ${profile.id} inputModalities must include text`)
  }
  if (inputModalities?.length) profile.inputModalities = inputModalities as AgentModelInputModality[]
  if (record.supportsParallelToolCalls !== undefined) {
    if (typeof record.supportsParallelToolCalls !== 'boolean') {
      throw new Error(`model profile ${profile.id} supportsParallelToolCalls must be a boolean`)
    }
    profile.supportsParallelToolCalls = record.supportsParallelToolCalls
  }
  if (record.supportsSearchTool !== undefined) {
    if (typeof record.supportsSearchTool !== 'boolean') {
      throw new Error(`model profile ${profile.id} supportsSearchTool must be a boolean`)
    }
    profile.supportsSearchTool = record.supportsSearchTool
  }
  if (record.serviceTier !== undefined) {
    profile.serviceTier = requireString(record.serviceTier, `model profile ${profile.id} serviceTier`)
  }
  if (record.supportsWebsockets !== undefined) {
    if (typeof record.supportsWebsockets !== 'boolean') throw new Error(`model profile ${profile.id} supportsWebsockets must be a boolean`)
    profile.supportsWebsockets = record.supportsWebsockets
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

/** Validate one secret-free profile snapshot, including legacy wireApi input. */
export function parseModelProfile(raw: unknown): ModelProfile {
  return validateProfile(raw)
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
  const profileIds = new Set<string>()
  for (const profile of profiles) {
    profileIds.add(profile.id)
    for (const id of [profile.id, ...(profile.aliases ?? [])]) {
      if (ids.has(id)) throw new Error(`duplicate model profile id or alias: ${id}`)
      ids.add(id)
    }
  }
  const rawDefault = record.defaultProfileId
  let defaultProfileId: string | undefined
  if (rawDefault !== undefined && rawDefault !== null) {
    defaultProfileId = requireString(rawDefault, 'defaultProfileId')
    if (!profileIds.has(defaultProfileId)) {
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

export interface ModelProfileRequest {
  profileId?: string
  model?: string
}

export function resolveModelProfileRequest(
  requestedProfileId: string | undefined,
  requestedModel: string | undefined,
  recorded?: { id?: string; model?: string },
): ModelProfileRequest {
  const profileId = requestedProfileId ?? recorded?.id
  const model = requestedModel ?? (requestedProfileId ? undefined : recorded?.model)
  return {
    ...(profileId ? { profileId } : {}),
    ...(model ? { model } : {}),
  }
}

export function shouldPreserveSourceModelProviderOnResume(
  resume: boolean | undefined,
  requestedProfileId: string | undefined,
  requestedModel: string | undefined,
  recordedSelectionFound: boolean,
): boolean {
  return Boolean(resume && !requestedProfileId && !requestedModel && !recordedSelectionFound)
}

export function modelProfileEnvironmentNames(profile: ModelProfile): string[] {
  return [...new Set([profile.envKey, ...(profile.envKeyAliases ?? [])])]
}

export function hasModelProfileEnvironment(
  profile: ModelProfile,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return modelProfileEnvironmentNames(profile).some((name) => {
    const value = environment[name]
    return value !== undefined && value !== ''
  })
}

/**
 * Select the first configured key name without copying or returning its value.
 * This lets a profile accept provider-specific aliases such as ARK_API_KEY and
 * VOLCENGINE_API_KEY while keeping every AgentHost binding deterministic.
 */
export function resolveModelProfileEnvironment(
  profile: ModelProfile,
  environment: NodeJS.ProcessEnv = process.env,
): ModelProfile {
  const selected = modelProfileEnvironmentNames(profile).find((name) => {
    const value = environment[name]
    return value !== undefined && value !== ''
  })
  if (!selected || selected === profile.envKey) return profile
  return {
    ...profile,
    envKey: selected,
    envKeyAliases: modelProfileEnvironmentNames(profile).filter((name) => name !== selected),
  }
}

/**
 * Convert the persisted control-plane profile into the host-neutral runtime
 * descriptor. No credential value crosses this boundary; hosts resolve only
 * the selected environment variable inside their own child process.
 */
export function toAgentModelProviderDescriptor(profile: ModelProfile): AgentModelProviderDescriptor {
  return {
    profileId: profile.id,
    providerId: profile.providerId,
    model: profile.model,
    baseUrl: profile.baseUrl,
    api: profile.api,
    credential: { type: 'environment', name: profile.envKey },
    ...(profile.displayName !== undefined ? { displayName: profile.displayName } : {}),
    ...(profile.reasoningEffort !== undefined ? { reasoningEffort: profile.reasoningEffort } : {}),
    ...(profile.reasoningEfforts !== undefined ? { reasoningEfforts: [...profile.reasoningEfforts] } : {}),
    ...(profile.inputModalities !== undefined ? { inputModalities: [...profile.inputModalities] } : {}),
    ...(profile.supportsParallelToolCalls !== undefined ? { supportsParallelToolCalls: profile.supportsParallelToolCalls } : {}),
    ...(profile.supportsSearchTool !== undefined ? { supportsSearchTool: profile.supportsSearchTool } : {}),
    ...(profile.serviceTier !== undefined ? { serviceTier: profile.serviceTier } : {}),
    ...(profile.supportsWebsockets !== undefined ? { supportsWebsockets: profile.supportsWebsockets } : {}),
    ...(profile.contextWindowTokens !== undefined ? { contextWindowTokens: profile.contextWindowTokens } : {}),
    ...(profile.maxOutputTokens !== undefined ? { maxOutputTokens: profile.maxOutputTokens } : {}),
  }
}

function profileMatchesId(profile: ModelProfile, requestedId: string): boolean {
  return profile.id === requestedId || (profile.aliases ?? []).includes(requestedId)
}

/**
 * Resolve explicit requests from the user registry first, then the built-in
 * catalog. Without an explicit request, a user default wins; otherwise a
 * user-defined DeepSeek profile overrides the built-in default.
 */
export function selectConfiguredModelProfile(
  registry: ModelProfileRegistry | undefined,
  requestedId?: string,
  environment: NodeJS.ProcessEnv = process.env,
): ModelProfileSelection | undefined {
  const runtimeProfile = runtimeModelProfileFromEnvironment(environment)
  if (requestedId) {
    const configured = registry?.profiles.find((profile) => profileMatchesId(profile, requestedId))
    const runtime = runtimeProfile && profileMatchesId(runtimeProfile, requestedId) ? runtimeProfile : undefined
    const builtIn = builtInModelProfileRegistry().profiles.find((profile) => profileMatchesId(profile, requestedId))
    const profile = configured ?? runtime ?? builtIn
    if (!profile) throw new Error(`未找到模型 Profile：${requestedId}`)
    return { explicit: true, profile: resolveModelProfileEnvironment(profile, environment) }
  }

  let profile: ModelProfile | undefined
  if (registry?.defaultProfileId) {
    profile = registry.profiles.find((candidate) => candidate.id === registry.defaultProfileId)
    if (!profile) {
      throw new Error(`defaultProfileId ${registry.defaultProfileId} does not match any registered model profile`)
    }
  } else {
    profile = runtimeProfile
      ?? registry?.profiles.find((candidate) => profileMatchesId(candidate, DEFAULT_MODEL_PROFILE_ID))
      ?? builtInModelProfileRegistry().profiles.find((candidate) => candidate.id === DEFAULT_MODEL_PROFILE_ID)
  }
  if (!profile) return undefined
  return { explicit: false, profile: resolveModelProfileEnvironment(profile, environment) }
}

/**
 * Resolve the model profile for a run. When `requestedId` is provided it must
 * exist. Otherwise the registry default is used; failing that, a single
 * registered profile is used. An empty registry returns undefined so callers
 * can fall back to the selected AgentHost's native configuration.
 */
export function selectModelProfile(
  registry: ModelProfileRegistry | undefined,
  requestedId?: string,
): ModelProfileSelection | undefined {
  if (!registry || registry.profiles.length === 0) return undefined
  if (requestedId) {
    const profile = registry.profiles.find((candidate) => profileMatchesId(candidate, requestedId))
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
