import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  AgentHostModelProviderAdapter,
  AgentHostProviderPrepareOptions,
  AgentHostRuntime,
  AgentModelProviderDescriptor,
} from './host.js'
import { AgentHostError } from './host.js'
import { resolveCodexExecutable } from './codex-executable.js'
import {
  agentProcessEnvironment,
  assertProviderApiSupported,
  copyPrivateFile,
  requireProviderCredential,
  withoutProviderCredential,
  writePrivateText,
} from './provider-runtime.js'
import { writePrivateJson } from './state.js'

const CODEX_SUPPORTED_APIS = ['openai-responses'] as const
const execFileAsync = promisify(execFile)

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function configTomlForProvider(
  provider: AgentModelProviderDescriptor,
  model: string,
  credentialEnvironmentVariable: string,
  modelCatalogPath: string,
): string {
  const lines = [
    `model = ${tomlString(model)}`,
    `model_provider = ${tomlString(provider.providerId)}`,
    `model_catalog_json = ${tomlString(modelCatalogPath)}`,
  ]
  if (provider.contextWindowTokens) lines.push(`model_context_window = ${provider.contextWindowTokens}`)
  if (provider.reasoningEffort) lines.push(`model_reasoning_effort = "${provider.reasoningEffort}"`)
  if (provider.serviceTier) lines.push(`service_tier = ${tomlString(provider.serviceTier)}`)
  lines.push(
    '',
    `[model_providers.${provider.providerId}]`,
    `name = ${tomlString(provider.displayName ?? provider.providerId)}`,
    `base_url = ${tomlString(provider.baseUrl)}`,
    'wire_api = "responses"',
    `env_key = ${tomlString(credentialEnvironmentVariable)}`,
    ...(provider.supportsWebsockets !== undefined ? [`supports_websockets = ${provider.supportsWebsockets}`] : []),
    'requires_openai_auth = false',
  )
  return `${lines.join('\n')}\n`
}

type CodexModelCatalogEntry = Record<string, unknown> & {
  base_instructions: string
  model_messages: Record<string, unknown>
}

async function bundledModelTemplate(options: AgentHostProviderPrepareOptions): Promise<CodexModelCatalogEntry> {
  await mkdir(options.privateDirectory, { recursive: true, mode: 0o700 })
  const probeHome = await mkdtemp(resolve(options.privateDirectory, 'codex-catalog-probe-'))
  try {
    const executable = await resolveCodexExecutable(options.executable, options.environment)
    const command = extname(executable).toLowerCase() === '.js' ? process.execPath : executable
    const args = extname(executable).toLowerCase() === '.js'
      ? [executable, 'debug', 'models', '--bundled']
      : ['debug', 'models', '--bundled']
    const { stdout } = await execFileAsync(
      command,
      args,
      {
        env: {
          ...agentProcessEnvironment(options.environment, undefined, false),
          CODEX_HOME: probeHome,
        },
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        timeout: 15_000,
        windowsHide: true,
      },
    )
    const catalog = JSON.parse(stdout) as { models?: unknown[] }
    const template = catalog.models?.find((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
      const item = candidate as Record<string, unknown>
      return item.supported_in_api === true && item.shell_type === 'shell_command' && item.visibility === 'list'
    }) as CodexModelCatalogEntry | undefined
    if (
      !template || typeof template.base_instructions !== 'string' || template.base_instructions.length === 0 ||
      !template.model_messages || typeof template.model_messages !== 'object' || Array.isArray(template.model_messages)
    ) {
      throw new Error('bundled catalog has no compatible agent model template')
    }
    return template
  } catch (error) {
    throw new AgentHostError(
      'codex',
      `Installed Codex CLI cannot provide a compatible bundled model catalog: ${error instanceof Error ? error.message : String(error)}`,
      'configuration',
    )
  } finally {
    await rm(probeHome, { recursive: true, force: true })
  }
}

function modelCatalogForProvider(
  template: CodexModelCatalogEntry,
  provider: AgentModelProviderDescriptor,
  model: string,
): unknown {
  const reasoningEfforts = provider.reasoningEfforts ? [...provider.reasoningEfforts] : []
  if (reasoningEfforts.length === 0 && provider.reasoningEffort) reasoningEfforts.push(provider.reasoningEffort)
  const inputModalities = provider.inputModalities ?? ['text']
  const catalogModel: Record<string, unknown> = {
    ...template,
    slug: model,
    display_name: provider.displayName ?? model,
    description: provider.displayName ?? `Managed model ${model}`,
    ...(provider.reasoningEffort ? { default_reasoning_level: provider.reasoningEffort } : {}),
    supported_reasoning_levels: reasoningEfforts.map((effort) => ({
      effort,
      description: `Use ${effort} reasoning effort.`,
    })),
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: provider.serviceTier ? [{
      id: provider.serviceTier,
      name: provider.serviceTier,
      description: `Use the ${provider.serviceTier} provider service tier.`,
    }] : [],
    default_service_tier: provider.serviceTier ?? null,
    availability_nux: null,
    upgrade: null,
    base_instructions: template.base_instructions,
    model_messages: template.model_messages,
    default_reasoning_summary: 'none',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: provider.supportsParallelToolCalls ?? false,
    supports_image_detail_original: inputModalities.includes('image') && template.supports_image_detail_original === true,
    auto_compact_token_limit: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: inputModalities,
    supports_search_tool: provider.supportsSearchTool ?? false,
    use_responses_lite: false,
    tool_mode: null,
  }
  if (provider.contextWindowTokens !== undefined) {
    catalogModel.context_window = provider.contextWindowTokens
    catalogModel.max_context_window = provider.contextWindowTokens
  } else {
    delete catalogModel.context_window
    delete catalogModel.max_context_window
  }
  if (!provider.reasoningEffort) delete catalogModel.default_reasoning_level
  return {
    models: [catalogModel],
  }
}

async function copySourceAuthIfNeeded(agentHome: string, sourceHome: string, providerEnvironmentName?: string): Promise<void> {
  if (providerEnvironmentName || resolve(agentHome) === resolve(sourceHome)) return
  await copyPrivateFile(resolve(sourceHome, 'auth.json'), resolve(agentHome, 'auth.json')).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

async function sourceConfig(agentHome: string, sourceHome: string): Promise<string | undefined> {
  const sourceConfig = await readFile(resolve(sourceHome, 'config.toml'), 'utf8').catch(() => '')
  const assignment = (key: string) => new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, 'm').exec(sourceConfig)?.[0]
  const providerId = /^[ \t]*model_provider[ \t]*=[ \t]*"([^"]+)"[ \t]*$/m.exec(sourceConfig)?.[1]
  let providerSection = ''
  if (providerId) {
    const escaped = providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const start = sourceConfig.search(new RegExp(`^[ \\t]*\\[model_providers\\.${escaped}\\][ \\t]*$`, 'm'))
    if (start >= 0) {
      const tail = sourceConfig.slice(start)
      const firstLineEnd = tail.indexOf('\n')
      const following = firstLineEnd >= 0 ? tail.slice(firstLineEnd + 1) : ''
      const nextSection = following.search(/^[ \t]*\[/m)
      providerSection = (nextSection >= 0 ? tail.slice(0, firstLineEnd + 1 + nextSection) : tail).trim()
    }
  }
  const config = [
    assignment('model'),
    assignment('model_provider'),
    assignment('model_reasoning_effort'),
    assignment('model_context_window'),
    assignment('service_tier'),
    providerSection,
  ].filter(Boolean).join('\n')
  await writePrivateText(resolve(agentHome, 'config.toml'), `${config}\n`)
  return /^[ \t]*env_key[ \t]*=[ \t]*"([^"]+)"[ \t]*$/m.exec(providerSection)?.[1]
}

export class CodexModelProviderAdapter implements AgentHostModelProviderAdapter {
  readonly supportedApis = CODEX_SUPPORTED_APIS

  async prepare(options: AgentHostProviderPrepareOptions): Promise<AgentHostRuntime> {
    await mkdir(options.agentHome, { recursive: true, mode: 0o700 })
    if (options.provider) {
      assertProviderApiSupported('codex', 'Codex CLI', this.supportedApis, options.provider)
      const credentialEnvironmentVariable = requireProviderCredential('codex', options.provider, options.environment)
      if (!credentialEnvironmentVariable) {
        throw new AgentHostError('codex', 'Codex model profiles currently require an environment credential', 'configuration')
      }
      const model = options.model ?? options.provider.model
      const configurationPath = resolve(options.agentHome, 'config.toml')
      const modelCatalogPath = resolve(options.agentHome, 'models.json')
      const modelTemplate = await bundledModelTemplate(options)
      await rm(resolve(options.agentHome, 'auth.json'), { force: true })
      await writePrivateJson(modelCatalogPath, modelCatalogForProvider(modelTemplate, options.provider, model))
      await writePrivateText(
        configurationPath,
        configTomlForProvider(options.provider, model, credentialEnvironmentVariable, modelCatalogPath),
      )
      return {
        agentHome: options.agentHome,
        environment: agentProcessEnvironment(options.environment, credentialEnvironmentVariable, false),
        mcpEnvironment: withoutProviderCredential(options.mcpEnvironment, credentialEnvironmentVariable),
        model,
        provider: {
          profileId: options.provider.profileId,
          providerId: options.provider.providerId,
          baseUrl: options.provider.baseUrl,
          api: options.provider.api,
          model,
          modelSelector: model,
          configurationPath,
          modelCatalogPath,
          credentialEnvironmentVariable,
          ...(options.provider.displayName !== undefined ? { displayName: options.provider.displayName } : {}),
          ...(options.provider.reasoningEffort !== undefined ? { reasoningEffort: options.provider.reasoningEffort } : {}),
          ...(options.provider.reasoningEfforts !== undefined ? { reasoningEfforts: [...options.provider.reasoningEfforts] } : {}),
          ...(options.provider.inputModalities !== undefined ? { inputModalities: [...options.provider.inputModalities] } : {}),
          ...(options.provider.supportsParallelToolCalls !== undefined ? { supportsParallelToolCalls: options.provider.supportsParallelToolCalls } : {}),
          ...(options.provider.supportsSearchTool !== undefined ? { supportsSearchTool: options.provider.supportsSearchTool } : {}),
          ...(options.provider.serviceTier !== undefined ? { serviceTier: options.provider.serviceTier } : {}),
          ...(options.provider.contextWindowTokens !== undefined ? { contextWindowTokens: options.provider.contextWindowTokens } : {}),
          ...(options.provider.maxOutputTokens !== undefined ? { maxOutputTokens: options.provider.maxOutputTokens } : {}),
          ...(options.provider.supportsWebsockets !== undefined ? { supportsWebsockets: options.provider.supportsWebsockets } : {}),
        },
      }
    }

    const sourceHome = options.sourceAgentHome ?? options.environment.AUTO_TEST_AGENT_HOME ?? options.environment.CODEX_HOME ?? options.environment.AUTO_TEST_CODEX_HOME ?? resolve(options.environment.HOME ?? process.env.HOME ?? '.', '.codex')
    const configurationPath = resolve(options.agentHome, 'config.toml')
    let providerEnvironmentName: string | undefined
    if (options.resume && !options.sourceAgentHome) {
      providerEnvironmentName = /^[ \t]*env_key[ \t]*=[ \t]*"([^"]+)"[ \t]*$/m.exec(await readFile(configurationPath, 'utf8').catch(() => ''))?.[1]
    } else {
      providerEnvironmentName = await sourceConfig(options.agentHome, sourceHome)
      await copySourceAuthIfNeeded(options.agentHome, sourceHome, providerEnvironmentName)
    }
    return {
      agentHome: options.agentHome,
      environment: agentProcessEnvironment(options.environment, providerEnvironmentName),
      mcpEnvironment: withoutProviderCredential(options.mcpEnvironment, providerEnvironmentName),
      ...(options.model ? { model: options.model } : {}),
    }
  }
}
