import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  environmentProfileMatches,
  matchingEnvironmentProfiles,
  normalizeTargetUrls,
  policyForRisk,
  registerEnvironment,
  riskForPolicy,
  safeProfileId,
  upsertEnvironmentProfile,
} from '../src/usability/environment-registration.js'
import { loadEnvironmentProfileRegistry } from '../src/workflow/environment-profile.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('easy environment registration', () => {
  it('registers a clean environment by default and requires an explicit interactive login capture', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-clean-auth-'))
    temporaryDirectories.push(directory)
    const root = resolve(import.meta.dirname, '..')
    const command = [
      resolve(root, 'node_modules/tsx/dist/cli.mjs'),
      resolve(root, 'src/cli/easy.ts'),
      'register', '--profile', 'auth-under-test', '--url', 'https://login.example.test/', '--risk', 'read',
    ]
    const environment = { ...process.env, XDG_CONFIG_HOME: directory }

    const clean = spawnSync(process.execPath, command, { cwd: root, env: environment, encoding: 'utf8' })
    const capture = spawnSync(process.execPath, [...command, '--capture-login'], { cwd: root, env: environment, encoding: 'utf8' })

    expect(clean.status, clean.stderr).toBe(0)
    expect(JSON.parse(await readFile(resolve(directory, 'auto-test', 'environment-profiles.json'), 'utf8')))
      .toMatchObject({ profiles: [{ id: 'auth-under-test', auth: [] }] })
    expect(capture.status).toBe(1)
    expect(capture.stderr).toContain('捕获登录状态需要交互终端')
  })

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
    expect(riskForPolicy(policyForRisk('read'))).toBe('read')
    expect(riskForPolicy(policyForRisk('write'))).toBe('write')
    expect(riskForPolicy(policyForRisk('destructive'))).toBe('destructive')
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
      policy: { ...policyForRisk('read'), maxRefinements: 7, maxEnvironmentRetries: 5 },
    }
    await upsertEnvironmentProfile(profile, registryPath)
    await registerEnvironment({
      profileId: profile.id,
      urls: ['https://admin.example.test/'],
      risk: 'destructive',
      captureLogin: false,
      registryPath,
    })

    const registry = await loadEnvironmentProfileRegistry(registryPath)
    expect(registry.profiles[0]?.auth).toHaveLength(1)
    expect(registry.profiles[0]?.policy).toMatchObject({
      allowWrite: true,
      allowDestructive: true,
      maxRefinements: 7,
      maxEnvironmentRetries: 5,
    })
  })

  it('reports origins discovered after the initial URL entry as partial profile coverage', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-coverage-'))
    temporaryDirectories.push(directory)
    const registryPath = resolve(directory, 'environment-profiles.json')
    await upsertEnvironmentProfile({
      id: 'charging-environment',
      origins: ['https://admin.example.test', 'https://simulator.example.test'],
      auth: [],
      policy: policyForRisk('destructive'),
    }, registryPath)

    const targetUrls = [
      'https://admin.example.test/',
      'https://simulator.example.test/',
      'https://h5.example.test/login',
    ]
    const matches = await environmentProfileMatches(targetUrls, registryPath)

    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      profile: { id: 'charging-environment' },
      coveredOrigins: ['https://admin.example.test', 'https://simulator.example.test'],
      missingOrigins: ['https://h5.example.test'],
    })
    expect(await matchingEnvironmentProfiles(targetUrls, registryPath)).toEqual([])
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
