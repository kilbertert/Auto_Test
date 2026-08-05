import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultModelProfileRegistryPath,
  loadModelProfileRegistry,
  selectModelProfile,
  type ModelProfile,
  type ModelProfileRegistry,
} from '../src/workflow/model-profile.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const primary: ModelProfile = {
  id: 'primary', model: 'gpt-4.1', providerId: 'primary_api',
  baseUrl: 'https://model-api.example.test/v1', wireApi: 'responses', envKey: 'AUTO_TEST_MODEL_API_KEY',
}

const glm: ModelProfile = {
  id: 'glm', model: 'glm-4.6', providerId: 'glm_api',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4', wireApi: 'chat', envKey: 'GLM_API_KEY', reasoningEffort: 'xhigh',
}

function registry(profiles: ModelProfile[], defaultProfileId?: string): ModelProfileRegistry {
  return { version: '1.0', ...(defaultProfileId !== undefined ? { defaultProfileId } : {}), profiles }
}

async function writeRegistry(profiles: ModelProfile[], defaultProfileId?: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-model-profile-'))
  directories.push(directory)
  const path = resolve(directory, 'model-profiles.json')
  await writeFile(path, JSON.stringify(registry(profiles, defaultProfileId)), 'utf8')
  return path
}

describe('model profile registry path', () => {
  it('resolves under the XDG config home on Linux', () => {
    expect(defaultModelProfileRegistryPath({ XDG_CONFIG_HOME: '/home/claude/.config' }, 'linux', '/home/claude'))
      .toBe('/home/claude/.config/auto-test/model-profiles.json')
  })

  it('resolves under APPDATA on Windows', () => {
    expect(defaultModelProfileRegistryPath({ APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' }, 'win32', 'C:\\Users\\tester'))
      .toBe('C:\\Users\\tester\\AppData\\Roaming\\auto-test\\model-profiles.json')
  })
})

describe('loadModelProfileRegistry', () => {
  it('loads and validates a registry with a default profile', async () => {
    const path = await writeRegistry([primary, glm], 'primary')
    const loaded = await loadModelProfileRegistry(path)
    expect(loaded.defaultProfileId).toBe('primary')
    expect(loaded.profiles).toHaveLength(2)
    expect(loaded.profiles[1]).toMatchObject({ id: 'glm', reasoningEffort: 'xhigh' })
  })

  it('strips a UTF-8 BOM', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-model-profile-bom-'))
    directories.push(directory)
    const path = resolve(directory, 'model-profiles.json')
    await writeFile(path, `\uFEFF${JSON.stringify(registry([primary]))}`, 'utf8')
    const loaded = await loadModelProfileRegistry(path)
    expect(loaded.profiles).toHaveLength(1)
  })

  it('loads adaptive epoch capacity hints', async () => {
    const path = await writeRegistry([{
      ...primary,
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_000,
      caseOutputTokens: 900,
      targetContextRatio: 0.55,
      targetOutputRatio: 0.6,
    }])
    expect((await loadModelProfileRegistry(path)).profiles[0]).toMatchObject({
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_000,
      caseOutputTokens: 900,
      targetContextRatio: 0.55,
      targetOutputRatio: 0.6,
    })
  })

  it.each([
    ['bad version', { ...registry([primary]), version: '2.0' }, /version/],
    ['duplicate id', registry([primary, { ...primary, providerId: 'other' }]), /duplicate/],
    ['missing model', registry([{ ...primary, model: '' }]), /model/],
    ['bad wireApi', registry([{ ...primary, wireApi: 'streaming' as never }]), /wireApi/],
    ['bad baseUrl', registry([{ ...primary, baseUrl: 'not-a-url' }]), /baseUrl/],
    ['bad envKey', registry([{ ...primary, envKey: '123bad' }]), /envKey/],
    ['bad context capacity', registry([{ ...primary, contextWindowTokens: 0 }]), /contextWindowTokens/],
    ['bad output ratio', registry([{ ...primary, targetOutputRatio: 1 }]), /targetOutputRatio/],
    ['unknown defaultProfileId', registry([primary], 'missing'), /defaultProfileId/],
  ])('rejects %s', async (_label, payload, pattern) => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-model-profile-invalid-'))
    directories.push(directory)
    const path = resolve(directory, 'model-profiles.json')
    await writeFile(path, JSON.stringify(payload), 'utf8')
    await expect(loadModelProfileRegistry(path)).rejects.toThrow(pattern)
  })
})

describe('selectModelProfile', () => {
  it('returns undefined when no registry is provided', () => {
    expect(selectModelProfile(undefined)).toBeUndefined()
  })

  it('returns undefined for an empty registry', () => {
    expect(selectModelProfile({ version: '1.0', profiles: [] })).toBeUndefined()
  })

  it('uses the explicit request when it exists', () => {
    const selection = selectModelProfile(registry([primary, glm], 'primary'), 'glm')
    expect(selection?.profile.id).toBe('glm')
    expect(selection?.explicit).toBe(true)
  })

  it('throws on an unknown explicit request', () => {
    expect(() => selectModelProfile(registry([primary, glm], 'primary'), 'missing')).toThrow(/未找到模型 Profile/)
  })

  it('falls back to the registry default', () => {
    const selection = selectModelProfile(registry([primary, glm], 'glm'))
    expect(selection?.profile.id).toBe('glm')
    expect(selection?.explicit).toBe(false)
  })

  it('uses the single registered profile without a default', () => {
    const selection = selectModelProfile(registry([primary]))
    expect(selection?.profile.id).toBe('primary')
  })

  it('throws when multiple profiles exist without a default or request', () => {
    expect(() => selectModelProfile(registry([primary, glm]))).toThrow(/--model-profile/)
  })
})
