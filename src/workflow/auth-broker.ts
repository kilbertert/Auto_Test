import { randomUUID } from 'node:crypto'
import { chmod, rename, writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { createLocator } from '../runtime/locator.js'
import { secretEnvironmentName } from '../runtime/data.js'
import type { EnvironmentProfile } from './environment-profile.js'

export interface EnvironmentAuthenticationResult {
  profileId: string
  checkedOrigins: string[]
  refreshedOrigins: string[]
}

export interface EnvironmentAuthenticationOptions {
  headless?: boolean
  slowMo?: number
}

async function privateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
  await chmod(path, 0o600)
}

function secret(environment: NodeJS.ProcessEnv, ref: string): string {
  const name = secretEnvironmentName(ref)
  const value = environment[name]
  if (!value) throw new Error(`Missing required auth secret environment variable: ${name}`)
  return value
}

function authenticatedUrl(value: string, login: NonNullable<EnvironmentProfile['auth'][number]['login']>): boolean {
  const url = new URL(value)
  if (login.successPathname && url.pathname !== login.successPathname) return false
  if (login.successUrlContains && !url.toString().includes(login.successUrlContains)) return false
  return Boolean(login.successPathname || login.successUrlContains)
}

export async function ensureEnvironmentAuthentication(
  profile: EnvironmentProfile,
  environment: NodeJS.ProcessEnv = process.env,
  options: EnvironmentAuthenticationOptions = {},
): Promise<EnvironmentAuthenticationResult> {
  const adapters = profile.auth.filter((adapter) => adapter.login)
  if (adapters.length === 0) return { profileId: profile.id, checkedOrigins: [], refreshedOrigins: [] }
  for (const adapter of adapters) {
    const login = adapter.login!
    if (!login.successPathname && !login.successUrlContains) {
      throw new Error(`Auth adapter for ${adapter.origin} must configure successPathname or successUrlContains`)
    }
  }
  const browser = await chromium.launch({
    headless: options.headless ?? true,
    ...(options.slowMo !== undefined ? { slowMo: options.slowMo } : {}),
  })
  const checkedOrigins: string[] = []
  const refreshedOrigins: string[] = []
  try {
    for (const adapter of adapters) {
      const login = adapter.login!
      const storageStatePath = adapter.storageStatePath!
      const context = await browser.newContext({ storageState: storageStatePath })
      const page = await context.newPage()
      try {
        await page.goto(login.loginUrl, { waitUntil: 'domcontentloaded' })
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)
        checkedOrigins.push(adapter.origin)
        if (!authenticatedUrl(page.url(), login)) {
          await createLocator(page, login.usernameLocator).fill(secret(environment, login.usernameSecretRef))
          await createLocator(page, login.passwordLocator).fill(secret(environment, login.passwordSecretRef))
          for (const check of login.preSubmitChecks ?? []) {
            const checkbox = createLocator(page, check.checkboxLocator)
            if (!await checkbox.isChecked()) await createLocator(page, check.controlLocator).click()
            if (!await checkbox.isChecked()) throw new Error('Auth Broker pre-submit checkbox did not become checked')
          }
          await createLocator(page, login.submitLocator).click()
          await page.waitForURL((url) => url.origin === adapter.origin && authenticatedUrl(url.toString(), login), { timeout: 30_000 })
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)
          refreshedOrigins.push(adapter.origin)
        }
        if (new URL(page.url()).origin !== adapter.origin) throw new Error(`Auth Broker left configured origin: ${adapter.origin}`)
        const storageTemporary = `${storageStatePath}.${randomUUID()}.tmp`
        await context.storageState({ path: storageTemporary })
        await chmod(storageTemporary, 0o600)
        await rename(storageTemporary, storageStatePath)
        await chmod(storageStatePath, 0o600)
        if (adapter.sessionStoragePath) {
          const entries = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)))
          await privateJson(adapter.sessionStoragePath, { origin: adapter.origin, entries })
        }
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }
  return { profileId: profile.id, checkedOrigins, refreshedOrigins }
}
