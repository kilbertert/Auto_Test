import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { AgentHostModelProviderAdapter, AgentHostProviderPrepareOptions, AgentHostRuntime } from './host.js'
import { agentProcessEnvironment, assertProviderApiSupported, requireProviderCredential, writePrivateText } from './provider-runtime.js'
import { controlServerPath, packageFilePath } from './runtime-paths.js'

const require = createRequire(import.meta.url)

const defaultCordisConfiguration = `
- id: sdk-jsonrpc-server
  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'
  config:
    maxTokensAsSuccess: true
    requiredTools:
      - mcp__auto-test-control__test_contract
      - mcp__playwright__browser_navigate
      - bash
    readinessTimeoutMs: 15000
- id: llm-profile
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config: !!js JSON.parse(process.env.AUTO_TEST_DSH_PROVIDER_CONFIG ?? '{}')
- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js process.env.DSH_SESSION_ROOT ?? './sessions'
    compression: none
- id: session-checkpoints
  name: '@deepseek-ai/dsh-session-checkpoint-policy'
- id: mcp-playwright
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: playwright
    transport: stdio
    command: !!js process.env.AUTO_TEST_PLAYWRIGHT_COMMAND
    args: !!js JSON.parse(process.env.AUTO_TEST_PLAYWRIGHT_ARGS ?? '[]')
    cwd: !!js process.env.DSH_CWD ?? process.cwd()
    env: !!js JSON.parse(process.env.AUTO_TEST_MCP_ENV ?? '{}')
    failOnStartupError: true
- id: mcp-control
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: auto-test-control
    transport: stdio
    command: !!js process.env.AUTO_TEST_CONTROL_COMMAND
    args: !!js JSON.parse(process.env.AUTO_TEST_CONTROL_ARGS ?? '[]')
    cwd: !!js process.env.DSH_CWD ?? process.cwd()
    env: !!js JSON.parse(process.env.AUTO_TEST_MCP_ENV ?? '{}')
    failOnStartupError: true
- id: subprocess-local
  name: '@deepseek-ai/dsh-subprocess-local'
- id: bash-local
  name: '@deepseek-ai/dsh-bash-local'
- id: agent-spine
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    tools:
      mode: native
    persona: !!js process.env.DSH_SYSTEM_PROMPT ?? 'You are the Auto-Test browser testing agent. DSH names MCP tools as mcp__<server>__<tool>; when Auto-Test says auto-test-control.<tool>, call the corresponding mcp__auto-test-control__<tool> tool.'
    workspaceContext:
      maxBytes: 100000
    skills:
      enabled: false
    toolBash:
      enableRunInBackground: false
    toolJobs: false
- id: repeat-tool-reminder
  name: '@deepseek-ai/dsh-repeat-tool-reminder'
  config:
    thresholds: [3, 5, 8]
    include:
      - mcp__auto-test-control__test_value_get
`.trimStart()

export class DshModelProviderAdapter implements AgentHostModelProviderAdapter {
  readonly supportedApis = ['anthropic-messages', 'openai-completions', 'openai-responses'] as const

  async prepare(options: AgentHostProviderPrepareOptions): Promise<AgentHostRuntime> {
    await mkdir(options.agentHome, { recursive: true, mode: 0o700 })
    const environment = agentProcessEnvironment(options.environment, undefined, options.provider === undefined)
    if (!options.provider) return { agentHome: options.agentHome, environment, mcpEnvironment: { ...options.mcpEnvironment } }

    assertProviderApiSupported('dsh', 'DeepSeek Harness', this.supportedApis, options.provider)
    const envKey = requireProviderCredential('dsh', options.provider, options.environment)
    if (envKey && options.environment[envKey]) environment[envKey] = options.environment[envKey]
    const selector = `${options.provider.providerId}/${options.model ?? options.provider.model}`
    const settings = {
      'llm-pi-ai': {
        providers: {
          [options.provider.providerId]: {
            displayName: options.provider.displayName ?? options.provider.profileId,
            api: options.provider.api,
            baseURL: options.provider.baseUrl,
            apiKeyEnv: envKey,
            models: [{ id: options.model ?? options.provider.model }],
          },
        },
      },
      'agent-default-model': {
        provider: options.provider.providerId,
        model: options.model ?? options.provider.model,
        ...(options.provider.reasoningEffort ? { reasoningEffort: options.provider.reasoningEffort } : {}),
      },
      permission: { defaultPreset: 'workspace-write' },
    }
    // JSON is valid YAML and avoids owning a YAML serializer.
    const configurationPath = resolve(options.agentHome, 'settings.yaml')
    await writePrivateText(configurationPath, JSON.stringify(settings, null, 2) + '\n')
    const cordisTemplate = options.environment.AUTO_TEST_DSH_CORDIS_TEMPLATE
    await writePrivateText(resolve(options.agentHome, 'cordis.yml'), cordisTemplate ? await readFile(cordisTemplate, 'utf8') : defaultCordisConfiguration)
    const tsxCli = require.resolve('tsx/cli')
    environment.AUTO_TEST_PLAYWRIGHT_COMMAND = process.execPath
    environment.AUTO_TEST_PLAYWRIGHT_ARGS = JSON.stringify([
      packageFilePath('@playwright/mcp', 'cli.js'), '--config', options.playwrightConfigPath, '--secrets', options.playwrightSecretsPath,
    ])
    environment.AUTO_TEST_CONTROL_COMMAND = process.execPath
    environment.AUTO_TEST_CONTROL_ARGS = JSON.stringify([tsxCli, controlServerPath(), options.controlConfigPath])
    environment.AUTO_TEST_MCP_ENV = JSON.stringify(options.mcpEnvironment)
    environment.AUTO_TEST_DSH_PROVIDER_CONFIG = JSON.stringify({ providers: { [options.provider.providerId]: {
      displayName: options.provider.displayName ?? options.provider.profileId,
      api: options.provider.api,
      apiKeyEnv: envKey,
      baseURL: options.provider.baseUrl,
      models: [{ id: options.model ?? options.provider.model }],
    } } })
    environment.DSH_HOME = options.agentHome
    return {
      agentHome: options.agentHome,
      environment,
      mcpEnvironment: { ...options.mcpEnvironment },
      model: selector,
      provider: {
        profileId: options.provider.profileId,
        providerId: options.provider.providerId,
        baseUrl: options.provider.baseUrl,
        api: options.provider.api,
        model: options.model ?? options.provider.model,
        modelSelector: selector,
        configurationPath,
        ...(envKey ? { credentialEnvironmentVariable: envKey } : {}),
        ...(options.provider.displayName ? { displayName: options.provider.displayName } : {}),
        ...(options.provider.reasoningEffort ? { reasoningEffort: options.provider.reasoningEffort } : {}),
      },
    }
  }
}
