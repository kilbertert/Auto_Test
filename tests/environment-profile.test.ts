import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultEnvironmentProfileRegistryPath,
  loadEnvironmentProfileRegistry,
  loadEnvironmentProfileContext,
  resolveEnvironmentProfileTargets,
  selectEnvironmentProfile,
} from '../src/workflow/environment-profile.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(mode = 0o600): Promise<{ directory: string; registryPath: string; authPath: string; contextPath: string }> {
  const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-profile-'))
  temporaryDirectories.push(directory)
  const authPath = resolve(directory, 'admin.storage-state.json')
  const contextPath = resolve(directory, 'planner-context.txt')
  await writeFile(authPath, '{}\n', { mode })
  await writeFile(contextPath, 'Environment: staging\nSocket host: 127.0.0.1\nSocket port: 9872\n', { mode: 0o600 })
  await chmod(authPath, mode)
  const registryPath = resolve(directory, 'environment-profiles.json')
  await writeFile(registryPath, `${JSON.stringify({
    version: '1.0',
    profiles: [{
      id: 'charging-staging',
      origins: ['https://h5.example.test', 'https://admin.example.test'],
      auth: [{ origin: 'https://admin.example.test', storageStatePath: './admin.storage-state.json' }],
      plannerContextPath: './planner-context.txt',
      policy: { allowWrite: true, allowDestructive: true, maxRefinements: 4, maxEnvironmentRetries: 2 },
    }],
  })}\n`, { mode: 0o600 })
  return { directory, registryPath, authPath, contextPath }
}

describe('environment profile registry', () => {
  it('uses the roaming application-data directory on Windows', () => {
    expect(defaultEnvironmentProfileRegistryPath(
      { APPDATA: 'C:\\Users\\Tester\\AppData\\Roaming' },
      'win32',
      'C:\\Users\\Tester',
    )).toBe('C:\\Users\\Tester\\AppData\\Roaming\\auto-test\\environment-profiles.json')
  })

  it('selects a unique profile by URL origins and maps private auth adapters to target IDs', async () => {
    const { registryPath, authPath } = await fixture()
    const registry = await loadEnvironmentProfileRegistry(registryPath)
    const profile = selectEnvironmentProfile(registry, [
      'https://h5.example.test/login?redirect=/index',
      'https://admin.example.test/#/orders',
    ])
    const resolved = resolveEnvironmentProfileTargets(profile, [
      { id: 'h5', baseUrl: 'https://h5.example.test/', allowedOrigins: ['https://h5.example.test/'] },
      { id: 'admin', baseUrl: 'https://admin.example.test/', allowedOrigins: ['https://admin.example.test/'] },
    ])

    expect(profile.id).toBe('charging-staging')
    expect(resolved.storageStateByTarget).toEqual({ admin: authPath })
    expect(resolved.sessionStorageByTarget).toEqual({})
    expect(await loadEnvironmentProfileContext(profile)).toContain('Socket port: 9872')
  })

  it('names every missing origin when a requested profile is incomplete', async () => {
    const { registryPath } = await fixture()
    const registry = await loadEnvironmentProfileRegistry(registryPath)

    expect(() => selectEnvironmentProfile(registry, [
      'https://admin.example.test/',
      'https://h5.example.test/',
      'https://new.example.test/',
      'https://other.example.test/',
    ], 'charging-staging')).toThrow(
      'missing origins: https://new.example.test, https://other.example.test',
    )
  })

  it('rejects auth artifacts that are readable by group or other users', async () => {
    if (process.platform === 'win32') return
    const { registryPath } = await fixture(0o640)
    await expect(loadEnvironmentProfileRegistry(registryPath)).rejects.toThrow(/must not grant group or other permissions/i)
  })

  it('uses Windows ACL semantics instead of POSIX mode bits', async () => {
    const { registryPath } = await fixture(0o640)
    await expect(loadEnvironmentProfileRegistry(registryPath, 'win32')).resolves.toMatchObject({ version: '1.0' })
  })

  it('accepts UTF-8 JSON files with a byte-order mark', async () => {
    const { registryPath } = await fixture()
    const content = await readFile(registryPath, 'utf8')
    await writeFile(registryPath, `\uFEFF${content}`, { mode: 0o600 })

    await expect(loadEnvironmentProfileRegistry(registryPath)).resolves.toMatchObject({ version: '1.0' })
  })

  it('rejects plaintext credentials in planner context', async () => {
    const { registryPath, contextPath } = await fixture()
    await writeFile(contextPath, 'password: synthetic-secret\n', { mode: 0o600 })
    const registry = await loadEnvironmentProfileRegistry(registryPath)
    await expect(loadEnvironmentProfileContext(registry.profiles[0]!)).rejects.toThrow(/plaintext sensitive data/i)
  })
})
