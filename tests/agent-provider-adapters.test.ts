import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexModelProviderAdapter } from '../src/agent/codex-provider.js'
import { OmpModelProviderAdapter } from '../src/agent/omp-provider.js'
import type { AgentHostProviderPrepareOptions, AgentModelProviderDescriptor } from '../src/agent/host.js'

const directories: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function descriptor(overrides: Partial<AgentModelProviderDescriptor> = {}): AgentModelProviderDescriptor {
  return {
    profileId: 'fixture',
    providerId: 'fixture_provider',
    model: 'fixture-model',
    baseUrl: 'https://provider.example.test/v1',
    api: 'openai-responses',
    credential: { type: 'environment', name: 'FIXTURE_PROVIDER_KEY' },
    displayName: 'Fixture Provider Model',
    reasoningEffort: 'high',
    reasoningEfforts: ['low', 'high'],
    inputModalities: ['text'],
    supportsParallelToolCalls: true,
    supportsSearchTool: true,
    contextWindowTokens: 100_000,
    maxOutputTokens: 8_000,
    ...overrides,
  }
}

async function options(directory: string, environment: NodeJS.ProcessEnv, provider: AgentModelProviderDescriptor): Promise<AgentHostProviderPrepareOptions> {
  const workspaceDirectory = resolve(directory, 'workspace')
  const privateDirectory = resolve(directory, 'private')
  const agentHome = resolve(privateDirectory, 'agent-home')
  await mkdir(workspaceDirectory, { recursive: true })
  await mkdir(privateDirectory, { recursive: true })
  const codexPackage = createRequire(import.meta.url).resolve('@openai/codex/package.json')
  return {
    workspaceDirectory,
    privateDirectory,
    agentHome,
    executable: resolve(dirname(codexPackage), 'bin', 'codex.js'),
    playwrightConfigPath: resolve(privateDirectory, 'playwright.json'),
    playwrightSecretsPath: resolve(privateDirectory, 'secrets.env'),
    controlConfigPath: resolve(privateDirectory, 'control.json'),
    environment,
    mcpEnvironment: { PATH: '/usr/bin', HOME: resolve(directory, 'mcp-home') },
    provider,
  }
}

describe('AgentHost model provider adapters', () => {
  it.each([
    ['deepseek', 'deepseek', 'deepseek-v4-flash', 'https://api.deepseek.com', 'DEEPSEEK_API_KEY'],
    ['volcengine', 'volcengine_coding', 'glm-5.2', 'https://ark.cn-beijing.volces.com/api/coding/v3', 'ARK_API_KEY'],
  ])('translates one %s descriptor independently for Codex and OMP', async (_id, providerId, model, baseUrl, keyName) => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-provider-adapter-'))
    directories.push(directory)
    const provider = descriptor({ profileId: _id, providerId, model, baseUrl, credential: { type: 'environment', name: keyName } })
    const environment = {
      PATH: '/usr/bin',
      [keyName]: `fixture-${_id}-secret`,
      AUTO_TEST_AGENT_FORWARD_ENV: 'OTHER_PROVIDER_KEY',
      OTHER_PROVIDER_KEY: 'must-not-forward-with-managed-profile',
    }
    const codexOptions = await options(resolve(directory, 'codex'), environment, provider)
    const ompOptions = await options(resolve(directory, 'omp'), environment, provider)
    codexOptions.mcpEnvironment[keyName] = 'must-not-reach-mcp'
    ompOptions.mcpEnvironment[keyName] = 'must-not-reach-mcp'
    await mkdir(codexOptions.agentHome, { recursive: true })
    await writeFile(resolve(codexOptions.agentHome, 'auth.json'), 'stale-native-auth')

    const codexRuntime = await new CodexModelProviderAdapter().prepare(codexOptions)
    const ompRuntime = await new OmpModelProviderAdapter().prepare(ompOptions)
    const codexConfig = await readFile(resolve(codexRuntime.agentHome, 'config.toml'), 'utf8')
    const ompConfig = JSON.parse(await readFile(resolve(ompRuntime.agentHome, 'models.yml'), 'utf8')) as {
      providers: Record<string, {
        baseUrl: string
        api: string
        apiKey: string
        models: Array<{ id: string; input: string[]; thinking: { efforts: string[] } }>
      }>
    }
    const codexCatalog = JSON.parse(await readFile(resolve(codexRuntime.agentHome, 'models.json'), 'utf8')) as {
      models: Array<Record<string, unknown>>
    }
    const ompMcpConfig = JSON.parse(await readFile(resolve(ompOptions.workspaceDirectory, '.omp', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { env: Record<string, string> }>
    }

    expect(codexRuntime.model).toBe(model)
    expect(codexRuntime.provider).toMatchObject({
      providerId, baseUrl, api: 'openai-responses', model, modelSelector: model, maxOutputTokens: 8_000,
    })
    expect(codexConfig).toContain(`model = "${model}"`)
    expect(codexConfig).toContain(`base_url = "${baseUrl}"`)
    expect(codexConfig).toContain('name = "Fixture Provider Model"')
    expect(codexConfig).toContain('wire_api = "responses"')
    expect(codexConfig).toContain('model_catalog_json = ')
    expect(codexCatalog.models).toEqual([expect.objectContaining({
      slug: model,
      display_name: 'Fixture Provider Model',
      base_instructions: expect.stringContaining('You are Codex'),
      model_messages: expect.objectContaining({
        instructions_template: expect.stringContaining('You are Codex'),
      }),
      tool_mode: null,
      input_modalities: ['text'],
      supports_parallel_tool_calls: true,
      supports_search_tool: true,
      context_window: 100_000,
      max_context_window: 100_000,
    })])
    expect(codexRuntime.environment[keyName]).toBe(`fixture-${_id}-secret`)
    expect(codexRuntime.environment).not.toHaveProperty('OTHER_PROVIDER_KEY')
    expect(codexRuntime.mcpEnvironment).not.toHaveProperty(keyName)
    await expect(access(resolve(codexRuntime.agentHome, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })

    expect(ompRuntime.model).toBe(`${providerId}/${model}`)
    expect(ompRuntime.provider).toMatchObject({
      providerId, baseUrl, api: 'openai-responses', model, modelSelector: `${providerId}/${model}`, maxOutputTokens: 8_000,
    })
    expect(ompConfig.providers[providerId]).toMatchObject({ baseUrl, api: 'openai-responses', apiKey: keyName })
    expect(ompConfig.providers[providerId]?.models).toEqual([expect.objectContaining({
      id: model,
      input: ['text'],
      thinking: expect.objectContaining({ efforts: ['low', 'high'] }),
    })])
    expect(ompRuntime.environment[keyName]).toBe(`fixture-${_id}-secret`)
    expect(ompRuntime.environment).not.toHaveProperty('OTHER_PROVIDER_KEY')
    expect(ompRuntime.mcpEnvironment).not.toHaveProperty(keyName)
    expect(Object.values(ompMcpConfig.mcpServers).every((server) => !(keyName in server.env))).toBe(true)
  })

  it('fails closed in the Codex adapter when a generic API is not supported', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-provider-adapter-capability-'))
    directories.push(directory)
    await expect(new CodexModelProviderAdapter().prepare(await options(
      directory,
      { FIXTURE_PROVIDER_KEY: 'fixture-secret' },
      descriptor({ api: 'openai-completions' }),
    ))).rejects.toThrow(/does not support model API openai-completions/)
  })

  it('writes a model catalog accepted by the installed Codex CLI', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-provider-adapter-codex-cli-'))
    directories.push(directory)
    const runtime = await new CodexModelProviderAdapter().prepare(await options(
      directory,
      { PATH: process.env.PATH, FIXTURE_PROVIDER_KEY: 'fixture-secret' },
      descriptor(),
    ))
    const codexPackage = createRequire(import.meta.url).resolve('@openai/codex/package.json')
    const codexCli = resolve(dirname(codexPackage), 'bin', 'codex.js')
    const { stdout } = await execFileAsync(process.execPath, [codexCli, 'debug', 'models'], {
      env: { ...runtime.environment, CODEX_HOME: runtime.agentHome },
      maxBuffer: 1024 * 1024,
    })
    const catalog = JSON.parse(stdout) as {
      models: Array<{ slug: string; base_instructions: string; model_messages: { instructions_template?: string } }>
    }
    expect(catalog.models.map((model) => model.slug)).toEqual(['fixture-model'])
    expect(catalog.models[0]?.base_instructions.length).toBeGreaterThan(1_000)
    expect(catalog.models[0]?.model_messages.instructions_template).toBe(catalog.models[0]?.base_instructions)
  })

  it('treats omitted managed-profile media capability as text-only', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-provider-adapter-modality-'))
    directories.push(directory)
    const { inputModalities: _inputModalities, ...provider } = descriptor()
    const environment = { PATH: '/usr/bin', FIXTURE_PROVIDER_KEY: 'fixture-secret' }
    const codexRuntime = await new CodexModelProviderAdapter().prepare(await options(resolve(directory, 'codex'), environment, provider))
    const ompRuntime = await new OmpModelProviderAdapter().prepare(await options(resolve(directory, 'omp'), environment, provider))
    const codexCatalog = JSON.parse(await readFile(resolve(codexRuntime.agentHome, 'models.json'), 'utf8')) as {
      models: Array<{ input_modalities: string[] }>
    }
    const ompConfig = JSON.parse(await readFile(resolve(ompRuntime.agentHome, 'models.yml'), 'utf8')) as {
      providers: Record<string, { models: Array<{ input: string[] }> }>
    }
    expect(codexCatalog.models[0]?.input_modalities).toEqual(['text'])
    expect(ompConfig.providers.fixture_provider?.models[0]?.input).toEqual(['text'])
  })

  it('keeps OMP native provider behavior when Core supplies no profile', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-provider-adapter-native-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-agent')
    await mkdir(sourceHome, { recursive: true })
    await writeFile(resolve(sourceHome, 'models.yml'), '{"providers":{"native":{"api":"openai-completions"}}}\n')
    const nativeOptions = await options(directory, { PATH: '/usr/bin', AUTO_TEST_AGENT_HOME: sourceHome }, descriptor())
    const { provider: _provider, ...nativePrepareOptions } = nativeOptions
    const runtime = await new OmpModelProviderAdapter().prepare(nativePrepareOptions)
    expect(runtime.provider).toBeUndefined()
    expect(runtime.model).toBeUndefined()
    expect(await readFile(resolve(runtime.agentHome, 'models.yml'), 'utf8')).toContain('native')

    await new OmpModelProviderAdapter().prepare({
      ...nativePrepareOptions,
      agentHome: runtime.agentHome,
      sourceAgentHome: runtime.agentHome,
      resume: true,
    })
    expect(await readFile(resolve(runtime.agentHome, 'models.yml'), 'utf8')).toContain('native')
  })
})
