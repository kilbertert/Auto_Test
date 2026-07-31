import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { chromium, type BrowserContext } from '@playwright/test'
import {
  defaultEnvironmentProfileRegistryPath,
  loadEnvironmentProfileRegistry,
  type EnvironmentAuthAdapter,
  type EnvironmentProfile,
  type EnvironmentProfileRegistry,
} from '../workflow/environment-profile.js'

export type EasyRiskLevel = 'read' | 'write' | 'destructive'

export interface EnvironmentRegistrationOptions {
  profileId: string
  urls: string[]
  risk: EasyRiskLevel
  captureLogin: boolean
  registryPath?: string
  waitForLogin?: (origins: string[]) => Promise<void>
}

export interface EnvironmentRegistrationResult {
  profile: EnvironmentProfile
  registryPath: string
  capturedOrigins: string[]
}

function jsonWithoutBom(input: string): unknown {
  return JSON.parse(input.replace(/^\uFEFF/, '')) as unknown
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function privateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
    await chmod(path, 0o600)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function validatedRegistryJson(path: string, value: EnvironmentProfileRegistry): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(temporary, 0o600)
    await loadEnvironmentProfileRegistry(temporary)
    await rename(temporary, path)
    await chmod(path, 0o600)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

function registryRelative(path: string, registryPath: string): string {
  const value = relative(dirname(registryPath), path).split(sep).join('/')
  return value.startsWith('.') ? value : `./${value}`
}

function originFileStem(origin: string): string {
  return new URL(origin).host.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '')
}

export function normalizeTargetUrls(values: string[]): string[] {
  const urls = values.map((value) => {
    try {
      const parsed = new URL(value.trim())
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol')
      return parsed.toString()
    } catch {
      throw new Error(`网站地址无效或不是 HTTP(S)：${value}`)
    }
  })
  return [...new Set(urls)]
}

export function targetOrigins(values: string[]): string[] {
  return [...new Set(normalizeTargetUrls(values).map((value) => new URL(value).origin))]
}

export function safeProfileId(value: string, urls: string[] = []): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  if (normalized) return normalized
  const host = urls[0] ? new URL(urls[0]).hostname.replace(/[^a-z0-9]+/gi, '-').toLowerCase() : 'environment'
  return `${host || 'environment'}-${Date.now().toString(36)}`.slice(0, 64)
}

export function policyForRisk(risk: EasyRiskLevel): EnvironmentProfile['policy'] {
  return {
    allowWrite: risk !== 'read',
    allowDestructive: risk === 'destructive',
    maxRefinements: 3,
    maxEnvironmentRetries: 2,
  }
}

async function readRegistryForUpdate(path: string): Promise<EnvironmentProfileRegistry> {
  if (!await pathExists(path)) return { version: '1.0', profiles: [] }
  await loadEnvironmentProfileRegistry(path)
  const input = jsonWithoutBom(await readFile(path, 'utf8'))
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('环境注册表格式无效')
  const registry = input as EnvironmentProfileRegistry
  if (registry.version !== '1.0' || !Array.isArray(registry.profiles)) throw new Error('环境注册表版本不受支持')
  return registry
}

export async function upsertEnvironmentProfile(
  profile: EnvironmentProfile,
  registryPath = defaultEnvironmentProfileRegistryPath(),
): Promise<void> {
  const registry = await readRegistryForUpdate(registryPath)
  const index = registry.profiles.findIndex((candidate) => candidate.id === profile.id)
  if (index >= 0) registry.profiles[index] = profile
  else registry.profiles.push(profile)
  await validatedRegistryJson(registryPath, registry)
}

async function captureSessionStorage(
  context: BrowserContext,
  urls: string[],
  profileDirectory: string,
  registryPath: string,
): Promise<{ adapters: EnvironmentAuthAdapter[]; createdFiles: string[]; hasSessionData: boolean }> {
  const adapters: EnvironmentAuthAdapter[] = []
  const createdFiles: string[] = []
  try {
    const captureId = randomUUID()
    const storageStatePath = resolve(profileDirectory, `browser-state-${captureId}.json`)
    const storageState = await context.storageState({ path: storageStatePath, indexedDB: true })
    createdFiles.push(storageStatePath)
    await chmod(storageStatePath, 0o600)

    const origins = targetOrigins(urls)
    let hasSessionStorage = false
    for (const origin of origins) {
      const page = context.pages().find((candidate) => {
        try {
          return new URL(candidate.url()).origin === origin
        } catch {
          return false
        }
      })
      const entries = page ? await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage))) : {}
      let sessionStoragePath: string | undefined
      if (Object.keys(entries).length > 0) {
        hasSessionStorage = true
        const absolute = resolve(profileDirectory, `session-${originFileStem(origin)}-${captureId}.json`)
        await privateJson(absolute, { origin, entries })
        createdFiles.push(absolute)
        sessionStoragePath = registryRelative(absolute, registryPath)
      }
      adapters.push({
        origin,
        storageStatePath: registryRelative(storageStatePath, registryPath),
        ...(sessionStoragePath ? { sessionStoragePath } : {}),
      })
    }
    const hasIndexedDb = storageState.origins.some((entry) => {
      const indexedDB = (entry as typeof entry & { indexedDB?: unknown[] }).indexedDB
      return (indexedDB?.length ?? 0) > 0
    })
    const hasPersistentState = storageState.cookies.length > 0 || hasIndexedDb ||
      storageState.origins.some((entry) => entry.localStorage.length > 0)
    return { adapters, createdFiles, hasSessionData: hasPersistentState || hasSessionStorage }
  } catch (error) {
    await Promise.all(createdFiles.map((path) => unlink(path).catch(() => undefined)))
    throw error
  }
}

export async function registerEnvironment(options: EnvironmentRegistrationOptions): Promise<EnvironmentRegistrationResult> {
  const registryPath = resolve(options.registryPath ?? defaultEnvironmentProfileRegistryPath())
  const urls = normalizeTargetUrls(options.urls)
  const origins = targetOrigins(urls)
  const profileId = safeProfileId(options.profileId, urls)
  const registry = await readRegistryForUpdate(registryPath)
  const existing = registry.profiles.find((profile) => profile.id === profileId)
  const profileDirectory = resolve(dirname(registryPath), 'profiles', profileId)
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 })

  let auth: EnvironmentAuthAdapter[] = existing?.auth ?? []
  let capturedFiles: string[] = []
  if (options.captureLogin) {
    const browser = await chromium.launch({ headless: false })
    const context = await browser.newContext()
    try {
      const firstUrlByOrigin = new Map(urls.map((url) => [new URL(url).origin, url]))
      for (const url of firstUrlByOrigin.values()) {
        const page = await context.newPage()
        await page.goto(url, { waitUntil: 'domcontentloaded' })
      }
      await options.waitForLogin?.(origins)
      const missingOrigins = origins.filter((origin) => !context.pages().some((page) => {
        try {
          return new URL(page.url()).origin === origin
        } catch {
          return false
        }
      }))
      if (missingOrigins.length > 0) throw new Error(`以下网站尚未返回目标页面：${missingOrigins.join('、')}`)
      const captured = await captureSessionStorage(context, urls, profileDirectory, registryPath)
      capturedFiles = captured.createdFiles
      if (!captured.hasSessionData) {
        await Promise.all(captured.createdFiles.map((path) => unlink(path).catch(() => undefined)))
        capturedFiles = []
        throw new Error('没有检测到登录会话。请确认已经登录并进入业务页面后再按回车。')
      }
      const existingByOrigin = new Map((existing?.auth ?? []).map((adapter) => [adapter.origin, adapter]))
      for (const adapter of captured.adapters) {
        existingByOrigin.set(adapter.origin, { ...existingByOrigin.get(adapter.origin), ...adapter })
      }
      auth = [...existingByOrigin.values()]
    } finally {
      await context.close()
      await browser.close()
    }
  }

  const profile: EnvironmentProfile = {
    id: profileId,
    origins: [...new Set([...(existing?.origins ?? []), ...origins])],
    auth,
    ...(existing?.secretVaultPath ? { secretVaultPath: existing.secretVaultPath } : {}),
    ...(existing?.plannerContextPath ? { plannerContextPath: existing.plannerContextPath } : {}),
    policy: policyForRisk(options.risk),
  }
  try {
    await upsertEnvironmentProfile(profile, registryPath)
  } catch (error) {
    await Promise.all(capturedFiles.map((path) => unlink(path).catch(() => undefined)))
    throw error
  }
  return { profile, registryPath, capturedOrigins: options.captureLogin ? origins : [] }
}

export async function matchingEnvironmentProfiles(
  urls: string[],
  registryPath = defaultEnvironmentProfileRegistryPath(),
): Promise<EnvironmentProfile[]> {
  try {
    const registry = await loadEnvironmentProfileRegistry(registryPath)
    const origins = targetOrigins(urls)
    return registry.profiles.filter((profile) => origins.every((origin) => profile.origins.includes(origin)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
