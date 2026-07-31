import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  matchingEnvironmentProfiles,
  normalizeTargetUrls,
  policyForRisk,
  safeProfileId,
  upsertEnvironmentProfile,
} from '../src/usability/environment-registration.js'
import { loadEnvironmentProfileRegistry } from '../src/workflow/environment-profile.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('easy environment registration', () => {
  it('normalizes user-facing URLs and profile names', () => {
    expect(normalizeTargetUrls([' https://example.test/login ', 'https://example.test/login'])).toEqual([
      'https://example.test/login',
    ])
    expect(safeProfileId(' 测试 95 / Admin ', ['https://example.test/'])).toBe('95-admin')
    expect(safeProfileId('', ['https://admin.example.test/'])).toMatch(/^admin-example-test-/)
  })

  it('maps the three friendly risk levels without weakening safety', () => {
    expect(policyForRisk('read')).toMatchObject({ allowWrite: false, allowDestructive: false })
    expect(policyForRisk('write')).toMatchObject({ allowWrite: true, allowDestructive: false })
    expect(policyForRisk('destructive')).toMatchObject({ allowWrite: true, allowDestructive: true })
  })

  it('creates and updates a private profile registry without hand-written JSON', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-profile-'))
    temporaryDirectories.push(directory)
    const registryPath = resolve(directory, 'environment-profiles.json')
    const profile = {
      id: 'easy-staging',
      origins: ['https://app.example.test'],
      auth: [],
      policy: policyForRisk('read'),
    }

    await upsertEnvironmentProfile(profile, registryPath)
    await upsertEnvironmentProfile({ ...profile, policy: policyForRisk('write') }, registryPath)

    const registry = await loadEnvironmentProfileRegistry(registryPath)
    expect(registry.profiles).toHaveLength(1)
    expect(registry.profiles[0]?.policy).toMatchObject({ allowWrite: true, allowDestructive: false })
    expect(await matchingEnvironmentProfiles(['https://app.example.test/orders'], registryPath)).toHaveLength(1)
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toMatchObject({ version: '1.0' })
    if (process.platform !== 'win32') await expect(chmod(registryPath, 0o600)).resolves.toBeUndefined()
  })

  it('preserves existing authentication when the friendly wizard only changes policy', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-preserve-'))
    temporaryDirectories.push(directory)
    const registryPath = resolve(directory, 'environment-profiles.json')
    const storagePath = resolve(directory, 'state.json')
    await writeFile(storagePath, '{}', { mode: 0o600 })
    const profile = {
      id: 'preserve-auth',
      origins: ['https://admin.example.test'],
      auth: [{ origin: 'https://admin.example.test', storageStatePath: './state.json' }],
      policy: policyForRisk('read'),
    }
    await upsertEnvironmentProfile(profile, registryPath)
    await upsertEnvironmentProfile({ ...profile, policy: policyForRisk('destructive') }, registryPath)

    const registry = await loadEnvironmentProfileRegistry(registryPath)
    expect(registry.profiles[0]?.auth).toHaveLength(1)
    expect(registry.profiles[0]?.policy).toMatchObject({ allowWrite: true, allowDestructive: true })
  })

  it('does not replace a valid registry with an invalid profile update', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-atomic-'))
    temporaryDirectories.push(directory)
    const registryPath = resolve(directory, 'environment-profiles.json')
    const profile = {
      id: 'atomic-profile',
      origins: ['https://app.example.test'],
      auth: [],
      policy: policyForRisk('read'),
    }
    await upsertEnvironmentProfile(profile, registryPath)

    await expect(upsertEnvironmentProfile({
      ...profile,
      policy: { allowWrite: false, allowDestructive: true },
    }, registryPath)).rejects.toThrow(/cannot allow destructive/i)

    const registry = await loadEnvironmentProfileRegistry(registryPath)
    expect(registry.profiles[0]?.policy).toMatchObject({ allowWrite: false, allowDestructive: false })
  })
})
