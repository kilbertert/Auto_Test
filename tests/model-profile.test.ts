import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUILT_IN_MODEL_PROFILES,
  DEFAULT_MODEL_PROFILE_ID,
  defaultModelProfileRegistryPath,
  builtInModelProfileRegistry,
  hasModelProfileEnvironment,
  isValidModelProfileProviderId,
  loadModelProfileRegistry,
  modelProfileEnvironmentNames,
  resolveModelProfileEnvironment,
  resolveModelProfileRequest,
  runtimeModelProfileFromEnvironment,
  selectConfiguredModelProfile,
  selectModelProfile,
  shouldPreserveSourceModelProviderOnResume,
  toAgentModelProviderDescriptor,
  type ModelProfile,
  type ModelProfileRegistry,
} from '../src/workflow/model-profile.js'

const directories: string[] = []
const credentialPattern = /sk-[A-Za-z0-9]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const primary: ModelProfile = {
  id: 'primary', model: 'gpt-4.1', providerId: 'primary_api',
  baseUrl: 'https://model-api.example.test/v1', api: 'openai-responses', envKey: 'AUTO_TEST_MODEL_API_KEY',
}

const glm: ModelProfile = {
  id: 'glm', model: 'glm-4.6', providerId: 'glm_api',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions', envKey: 'GLM_API_KEY', reasoningEffort: 'xhigh',
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

  it('normalizes legacy Codex wireApi values into host-neutral model APIs', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-model-profile-legacy-'))
    directories.push(directory)
    const path = resolve(directory, 'model-profiles.json')
    const { api: _api, ...legacyPrimary } = primary
    await writeFile(path, JSON.stringify({
      version: '1.0',
      profiles: [{ ...legacyPrimary, wireApi: 'responses' }],
    }), 'utf8')
    await expect(loadModelProfileRegistry(path)).resolves.toMatchObject({
      profiles: [expect.objectContaining({ api: 'openai-responses' })],
    })
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
    ['bad api', registry([{ ...primary, api: 'streaming' as never }]), /api/],
    ['bad baseUrl', registry([{ ...primary, baseUrl: 'not-a-url' }]), /baseUrl/],
    ['credential-bearing baseUrl', registry([{ ...primary, baseUrl: 'https://user:secret@model-api.example.test/v1' }]), /without embedded credentials/],
    ['bad providerId', registry([{ ...primary, providerId: 'provider]injection' }]), /providerId/],
    ['bad envKey', registry([{ ...primary, envKey: '123bad' }]), /envKey/],
    ['bad envKeyAliases', registry([{ ...primary, envKeyAliases: ['123bad'] }]), /envKeyAliases/],
    ['duplicate envKey alias', registry([{ ...primary, envKeyAliases: ['AUTO_TEST_MODEL_API_KEY'] }]), /must not repeat envKey/],
    ['alias as defaultProfileId', registry([{ ...primary, aliases: ['primary-alias'] }], 'primary-alias'), /defaultProfileId/],
    ['bad supportsWebsockets', registry([{ ...primary, supportsWebsockets: 'yes' as never }]), /supportsWebsockets/],
    ['bad reasoning efforts', registry([{ ...primary, reasoningEfforts: ['high', 'max' as never] }]), /reasoningEfforts/],
    ['selected reasoning effort missing', registry([{ ...primary, reasoningEffort: 'high', reasoningEfforts: ['low'] }]), /must include reasoningEffort/],
    ['bad input modality', registry([{ ...primary, inputModalities: ['audio' as never] }]), /inputModalities/],
    ['missing text modality', registry([{ ...primary, inputModalities: ['image'] }]), /must include text/],
    ['bad parallel tools flag', registry([{ ...primary, supportsParallelToolCalls: 'yes' as never }]), /supportsParallelToolCalls/],
    ['bad search tool flag', registry([{ ...primary, supportsSearchTool: 'yes' as never }]), /supportsSearchTool/],
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

describe('built-in provider profiles', () => {
  it('contains the requested DeepSeek and Volcengine metadata without credentials', () => {
    expect(BUILT_IN_MODEL_PROFILES).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'deepseek', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com',
        api: 'openai-responses', envKey: 'DEEPSEEK_API_KEY', inputModalities: ['text'],
        supportsParallelToolCalls: true, supportsSearchTool: true, supportsWebsockets: false,
        maxOutputTokens: 393_216,
      }),
      expect.objectContaining({
        id: 'volcengine', model: 'glm-5.2', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
        api: 'openai-responses', envKey: 'ARK_API_KEY', inputModalities: ['text'],
        supportsWebsockets: false, contextWindowTokens: 1_024_000, maxOutputTokens: 65_536,
      }),
    ]))
    expect(JSON.stringify(BUILT_IN_MODEL_PROFILES)).not.toMatch(credentialPattern)
    expect(DEFAULT_MODEL_PROFILE_ID).toBe('deepseek')
    expect(builtInModelProfileRegistry()).toMatchObject({ defaultProfileId: 'deepseek' })
    expect(builtInModelProfileRegistry().profiles).toHaveLength(2)
  })

  it('keeps the public registry template secret-free and aligned with the built-ins', async () => {
    const template = await readFile(resolve(import.meta.dirname, '../templates/model-profiles.example.json'), 'utf8')
    const parsed = JSON.parse(template) as ModelProfileRegistry
    expect(parsed.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'deepseek', model: 'deepseek-v4-flash' }),
      expect.objectContaining({ id: 'volcengine', model: 'glm-5.2' }),
    ]))
    expect(parsed.defaultProfileId).toBe('deepseek')
    expect(template).not.toMatch(credentialPattern)
  })

  it('uses DeepSeek by default and still supports an explicit Volcengine switch', () => {
    expect(selectConfiguredModelProfile(undefined, undefined, {}))
      .toMatchObject({ explicit: false, profile: { id: 'deepseek', model: 'deepseek-v4-flash' } })
    expect(selectConfiguredModelProfile(undefined, 'volcengine', { ARK_API_KEY: 'fixture' }))
      .toMatchObject({ explicit: true, profile: { id: 'volcengine', envKey: 'ARK_API_KEY' } })
  })

  it('uses a complete host-neutral runtime profile without storing its credential value', () => {
    const environment = {
      AUTO_TEST_MODEL_PROFILE_ID: 'portable-default',
      AUTO_TEST_MODEL_PROVIDER_ID: 'portable_api',
      AUTO_TEST_MODEL_ID: 'portable-model',
      AUTO_TEST_MODEL_BASE_URL: 'https://portable.example.test/v1',
      AUTO_TEST_MODEL_API: 'openai-responses',
      AUTO_TEST_MODEL_ENV_KEY: 'PORTABLE_MODEL_KEY',
      PORTABLE_MODEL_KEY: 'fixture-secret',
    }
    const profile = runtimeModelProfileFromEnvironment(environment)
    expect(profile).toEqual(expect.objectContaining({
      id: 'portable-default', providerId: 'portable_api', model: 'portable-model',
      baseUrl: 'https://portable.example.test/v1', api: 'openai-responses',
      envKey: 'PORTABLE_MODEL_KEY', inputModalities: ['text'],
    }))
    expect(profile).not.toHaveProperty('apiKey')
    expect(selectConfiguredModelProfile(undefined, undefined, environment))
      .toMatchObject({ explicit: false, profile: { id: 'portable-default' } })
    expect(selectConfiguredModelProfile(undefined, 'deepseek', environment))
      .toMatchObject({ explicit: true, profile: { id: 'deepseek' } })
  })

  it('lets an explicit registry default override the process-scoped default', () => {
    const environment = {
      AUTO_TEST_MODEL_PROFILE_ID: 'portable-default',
      AUTO_TEST_MODEL_PROVIDER_ID: 'portable_api',
      AUTO_TEST_MODEL_ID: 'portable-model',
      AUTO_TEST_MODEL_BASE_URL: 'https://portable.example.test/v1',
      AUTO_TEST_MODEL_API: 'openai-responses',
      AUTO_TEST_MODEL_ENV_KEY: 'PORTABLE_MODEL_KEY',
    }
    expect(selectConfiguredModelProfile(registry([primary], 'primary'), undefined, environment))
      .toMatchObject({ profile: { id: 'primary' } })
  })

  it('fails closed on a partially configured runtime profile', () => {
    expect(() => runtimeModelProfileFromEnvironment({ AUTO_TEST_MODEL_PROFILE_ID: 'partial' }))
      .toThrow(/runtime model profile environment is incomplete/)
  })

  it('does not mistake package build endpoint inputs for a runtime profile', () => {
    const environment = {
      AUTO_TEST_MODEL_BASE_URL: 'https://package.example.test/v1',
      AUTO_TEST_MODEL_ID: 'package-model',
    }
    expect(runtimeModelProfileFromEnvironment(environment)).toBeUndefined()
    expect(selectConfiguredModelProfile(undefined, undefined, environment))
      .toMatchObject({ profile: { id: 'deepseek' } })
  })

  it('lets a configured default override DeepSeek', () => {
    const selection = selectConfiguredModelProfile(registry([primary, glm], 'glm'), undefined, {})
    expect(selection).toMatchObject({ explicit: false, profile: { id: 'glm' } })
  })

  it('does not treat a single custom profile as the default without defaultProfileId', () => {
    const selection = selectConfiguredModelProfile(registry([primary]), undefined, {})
    expect(selection).toMatchObject({ explicit: false, profile: { id: 'deepseek' } })
  })

  it('lets a configured DeepSeek profile override the built-in definition', () => {
    const customDeepSeek = {
      ...primary,
      id: 'deepseek',
      model: 'deepseek-private-deployment',
      baseUrl: 'https://deepseek-gateway.example.test/v1',
      envKey: 'PRIVATE_DEEPSEEK_API_KEY',
    }
    const selection = selectConfiguredModelProfile(registry([customDeepSeek]), undefined, { PRIVATE_DEEPSEEK_API_KEY: 'fixture' })
    expect(selection).toMatchObject({
      explicit: false,
      profile: {
        id: 'deepseek',
        model: 'deepseek-private-deployment',
        baseUrl: 'https://deepseek-gateway.example.test/v1',
        envKey: 'PRIVATE_DEEPSEEK_API_KEY',
      },
    })
  })

  it('reuses the recorded profile and model only for an implicit resume', () => {
    const recorded = { id: 'volcengine', model: 'glm-5-2-260617' }
    expect(resolveModelProfileRequest(undefined, undefined, recorded))
      .toEqual({ profileId: 'volcengine', model: 'glm-5-2-260617' })
    expect(resolveModelProfileRequest(undefined, 'glm-new', recorded))
      .toEqual({ profileId: 'volcengine', model: 'glm-new' })
    expect(resolveModelProfileRequest('deepseek', undefined, recorded))
      .toEqual({ profileId: 'deepseek' })
    expect(resolveModelProfileRequest('deepseek', 'deepseek-v4-flash', recorded))
      .toEqual({ profileId: 'deepseek', model: 'deepseek-v4-flash' })
    const request = resolveModelProfileRequest(undefined, undefined, recorded)
    expect(selectConfiguredModelProfile(registry([primary], 'primary'), request.profileId, { ARK_API_KEY: 'fixture' }))
      .toMatchObject({ explicit: true, profile: { id: 'volcengine' } })
  })

  it('preserves the source provider only for a bare legacy resume without a selection record', () => {
    expect(shouldPreserveSourceModelProviderOnResume(true, undefined, undefined, false)).toBe(true)
    expect(shouldPreserveSourceModelProviderOnResume(true, undefined, undefined, true)).toBe(false)
    expect(shouldPreserveSourceModelProviderOnResume(true, 'deepseek', undefined, false)).toBe(false)
    expect(shouldPreserveSourceModelProviderOnResume(true, undefined, 'deepseek-v4-flash', false)).toBe(false)
    expect(shouldPreserveSourceModelProviderOnResume(false, undefined, undefined, false)).toBe(false)
  })

  it('prefers a configured environment alias without exposing its value', () => {
    const profile = BUILT_IN_MODEL_PROFILES.find((item) => item.id === 'volcengine')!
    expect(modelProfileEnvironmentNames(profile)).toEqual(['ARK_API_KEY', 'VOLCENGINE_API_KEY', 'VOLCENGINE_ARK_API_KEY'])
    expect(hasModelProfileEnvironment(profile, { VOLCENGINE_API_KEY: 'fixture' })).toBe(true)
    expect(hasModelProfileEnvironment(profile, { VOLCENGINE_API_KEY: '' })).toBe(false)
    const resolved = resolveModelProfileEnvironment(profile, { VOLCENGINE_API_KEY: 'fixture' })
    expect(resolved.envKey).toBe('VOLCENGINE_API_KEY')
    expect(modelProfileEnvironmentNames(resolved)).toEqual(['VOLCENGINE_API_KEY', 'ARK_API_KEY', 'VOLCENGINE_ARK_API_KEY'])
    expect(resolved).not.toHaveProperty('apiKey')
    const selection = selectConfiguredModelProfile(undefined, 'volcengine', { VOLCENGINE_API_KEY: 'fixture' })
    expect(selection?.profile.envKey).toBe('VOLCENGINE_API_KEY')
  })

  it('creates a secret-free AgentHost provider descriptor', () => {
    const descriptor = toAgentModelProviderDescriptor(primary)
    expect(descriptor).toEqual({
      profileId: 'primary',
      providerId: 'primary_api',
      model: 'gpt-4.1',
      baseUrl: 'https://model-api.example.test/v1',
      api: 'openai-responses',
      credential: { type: 'environment', name: 'AUTO_TEST_MODEL_API_KEY' },
    })
    expect(descriptor).not.toHaveProperty('apiKey')
  })

  it('accepts only host-safe provider identifiers', () => {
    expect(isValidModelProfileProviderId('volcengine_coding')).toBe(true)
    expect(isValidModelProfileProviderId('provider-v2')).toBe(true)
    expect(isValidModelProfileProviderId('provider]injection')).toBe(false)
    expect(isValidModelProfileProviderId('1provider')).toBe(false)
  })
})
