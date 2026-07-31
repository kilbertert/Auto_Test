import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import type { LocatorIR } from '../core/types.js'
import { redactSensitiveContent } from '../input/text.js'
import type { WorkflowRuntimeTarget } from './runtime-types.js'

export interface EnvironmentLoginAdapter {
  loginUrl: string
  successPathname?: string
  successUrlContains?: string
  usernameSecretRef: string
  passwordSecretRef: string
  usernameLocator: LocatorIR
  passwordLocator: LocatorIR
  submitLocator: LocatorIR
  preSubmitChecks?: Array<{
    checkboxLocator: LocatorIR
    controlLocator: LocatorIR
  }>
}

export interface EnvironmentAuthAdapter {
  origin: string
  storageStatePath?: string
  sessionStoragePath?: string
  login?: EnvironmentLoginAdapter
}

export interface EnvironmentProfile {
  id: string
  origins: string[]
  auth: EnvironmentAuthAdapter[]
  secretVaultPath?: string
  plannerContextPath?: string
  policy: {
    allowWrite: boolean
    allowDestructive: boolean
    maxRefinements?: number
    maxEnvironmentRetries?: number
  }
}

export interface EnvironmentProfileRegistry {
  version: '1.0'
  profiles: EnvironmentProfile[]
}

export interface ResolvedEnvironmentProfile {
  profile: EnvironmentProfile
  storageStateByTarget: Record<string, string>
  sessionStorageByTarget: Record<string, string>
}

export function defaultEnvironmentProfileRegistryPath(environment: NodeJS.ProcessEnv = process.env): string {
  const configHome = environment.XDG_CONFIG_HOME || resolve(homedir(), '.config')
  return resolve(configHome, 'auto-test', 'environment-profiles.json')
}

function normalizedOrigin(value: string, label: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
    return url.origin
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) origin`)
  }
}

function privatePath(path: string, registryPath: string): string {
  return isAbsolute(path) ? path : resolve(dirname(registryPath), path)
}

function requireLocator(locator: LocatorIR, label: string): void {
  if (!locator || !['role', 'testId', 'label', 'placeholder', 'text', 'css', 'xpath'].includes(locator.strategy)) throw new Error(`${label} has an invalid strategy`)
  if (!locator.value?.trim() || !['manual', 'playwrightCli'].includes(locator.source)) throw new Error(`${label} must be a verified locator`)
}

async function requirePrivateFile(path: string, label: string): Promise<void> {
  const details = await stat(path)
  if (!details.isFile()) throw new Error(`${label} is not a file: ${path}`)
  if ((details.mode & 0o077) !== 0) throw new Error(`${label} must not grant group or other permissions: ${path}`)
}

export async function loadEnvironmentProfileRegistry(path = defaultEnvironmentProfileRegistryPath()): Promise<EnvironmentProfileRegistry> {
  const input = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Environment profile registry must be an object')
  const registry = input as EnvironmentProfileRegistry
  if (registry.version !== '1.0' || !Array.isArray(registry.profiles)) throw new Error('Environment profile registry has an unsupported shape')
  const ids = new Set<string>()
  for (const profile of registry.profiles) {
    if (!profile.id || ids.has(profile.id)) throw new Error(`Environment profile has an invalid or duplicate id: ${profile.id}`)
    ids.add(profile.id)
    if (!Array.isArray(profile.origins) || profile.origins.length === 0) throw new Error(`Environment profile ${profile.id} has no origins`)
    profile.origins = [...new Set(profile.origins.map((origin) => normalizedOrigin(origin, `Profile ${profile.id} origin`)))]
    if (profile.secretVaultPath) {
      profile.secretVaultPath = privatePath(profile.secretVaultPath, path)
      await requirePrivateFile(profile.secretVaultPath, 'secretVault')
    }
    if (profile.plannerContextPath) {
      profile.plannerContextPath = privatePath(profile.plannerContextPath, path)
      await requirePrivateFile(profile.plannerContextPath, 'plannerContext')
    }
    if (!Array.isArray(profile.auth)) throw new Error(`Environment profile ${profile.id} auth must be an array`)
    profile.auth = profile.auth.map((adapter) => ({
      ...adapter,
      origin: normalizedOrigin(adapter.origin, `Profile ${profile.id} auth origin`),
      ...(adapter.storageStatePath ? { storageStatePath: privatePath(adapter.storageStatePath, path) } : {}),
      ...(adapter.sessionStoragePath ? { sessionStoragePath: privatePath(adapter.sessionStoragePath, path) } : {}),
      ...(adapter.login ? { login: { ...adapter.login, loginUrl: new URL(adapter.login.loginUrl).toString() } } : {}),
    }))
    if (!profile.policy || typeof profile.policy.allowWrite !== 'boolean' || typeof profile.policy.allowDestructive !== 'boolean') {
      throw new Error(`Environment profile ${profile.id} policy is invalid`)
    }
    if (profile.policy.allowDestructive && !profile.policy.allowWrite) throw new Error(`Environment profile ${profile.id} cannot allow destructive actions while write actions are disabled`)
    if (profile.policy.maxRefinements !== undefined && (!Number.isInteger(profile.policy.maxRefinements) || profile.policy.maxRefinements < 1)) {
      throw new Error(`Environment profile ${profile.id} maxRefinements must be a positive integer`)
    }
    if (profile.policy.maxEnvironmentRetries !== undefined && (!Number.isInteger(profile.policy.maxEnvironmentRetries) || profile.policy.maxEnvironmentRetries < 0)) {
      throw new Error(`Environment profile ${profile.id} maxEnvironmentRetries must be a non-negative integer`)
    }
    for (const adapter of profile.auth) {
      if (!profile.origins.includes(adapter.origin)) throw new Error(`Environment profile ${profile.id} auth origin is outside profile origins: ${adapter.origin}`)
      if (adapter.storageStatePath) await requirePrivateFile(adapter.storageStatePath, 'storageState')
      if (adapter.sessionStoragePath) await requirePrivateFile(adapter.sessionStoragePath, 'sessionStorage')
      if (adapter.login) {
        if (!adapter.storageStatePath) throw new Error(`Environment profile ${profile.id} login adapter requires storageStatePath`)
        if (normalizedOrigin(adapter.login.loginUrl, `Profile ${profile.id} loginUrl`) !== adapter.origin) throw new Error(`Environment profile ${profile.id} loginUrl is outside the auth origin`)
        if ((!adapter.login.successPathname && !adapter.login.successUrlContains) || !adapter.login.usernameSecretRef || !adapter.login.passwordSecretRef) throw new Error(`Environment profile ${profile.id} login adapter is incomplete`)
        requireLocator(adapter.login.usernameLocator, `Profile ${profile.id} usernameLocator`)
        requireLocator(adapter.login.passwordLocator, `Profile ${profile.id} passwordLocator`)
        requireLocator(adapter.login.submitLocator, `Profile ${profile.id} submitLocator`)
        for (const [index, check] of (adapter.login.preSubmitChecks ?? []).entries()) {
          requireLocator(check.checkboxLocator, `Profile ${profile.id} preSubmitChecks[${index}].checkboxLocator`)
          requireLocator(check.controlLocator, `Profile ${profile.id} preSubmitChecks[${index}].controlLocator`)
        }
      }
    }
  }
  return registry
}

export async function loadEnvironmentProfileSecrets(
  profile: EnvironmentProfile,
): Promise<Record<string, string | string[]>> {
  if (!profile.secretVaultPath) return {}
  const input = JSON.parse(await readFile(profile.secretVaultPath, 'utf8')) as unknown
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error(`Secret vault for profile ${profile.id} must be an object`)
  const values = input as Record<string, unknown>
  if (Object.entries(values).some(([key, value]) => !key.trim() || !(typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'))))) {
    throw new Error(`Secret vault for profile ${profile.id} contains an invalid entry`)
  }
  return values as Record<string, string | string[]>
}

export async function loadEnvironmentProfileContext(profile: EnvironmentProfile): Promise<string> {
  if (!profile.plannerContextPath) return ''
  const content = await readFile(profile.plannerContextPath, 'utf8')
  if (Buffer.byteLength(content, 'utf8') > 256 * 1024) throw new Error(`Planner context for profile ${profile.id} exceeds 256 KiB`)
  if (redactSensitiveContent(content) !== content) {
    throw new Error(`Planner context for profile ${profile.id} contains plaintext sensitive data`)
  }
  return content
}

export function selectEnvironmentProfile(
  registry: EnvironmentProfileRegistry,
  targetUrls: string[],
  requestedId?: string,
): EnvironmentProfile {
  const origins = [...new Set(targetUrls.map((url) => normalizedOrigin(url, 'Target URL')))]
  const candidates = registry.profiles.filter((profile) => origins.every((origin) => profile.origins.includes(origin)))
  if (requestedId) {
    const selected = registry.profiles.find((profile) => profile.id === requestedId)
    if (!selected) throw new Error(`Unknown environment profile: ${requestedId}`)
    if (!origins.every((origin) => selected.origins.includes(origin))) throw new Error(`Environment profile ${requestedId} does not cover all target origins`)
    return selected
  }
  if (candidates.length !== 1) throw new Error(`Expected exactly one environment profile for target origins; found ${candidates.length}`)
  return candidates[0]!
}

export function resolveEnvironmentProfileTargets(
  profile: EnvironmentProfile,
  targets: WorkflowRuntimeTarget[],
): ResolvedEnvironmentProfile {
  const auth = new Map(profile.auth.map((adapter) => [adapter.origin, adapter]))
  const storageStateByTarget: Record<string, string> = {}
  const sessionStorageByTarget: Record<string, string> = {}
  for (const target of targets) {
    const origin = normalizedOrigin(target.baseUrl, `Target ${target.id} baseUrl`)
    if (!profile.origins.includes(origin)) throw new Error(`Environment profile ${profile.id} does not cover target ${target.id}`)
    const adapter = auth.get(origin)
    if (adapter?.storageStatePath) storageStateByTarget[target.id] = adapter.storageStatePath
    if (adapter?.sessionStoragePath) sessionStorageByTarget[target.id] = adapter.sessionStoragePath
  }
  return { profile, storageStateByTarget, sessionStorageByTarget }
}
