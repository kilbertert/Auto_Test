import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { AgentHostModelProviderAdapter, AgentHostProviderPrepareOptions, AgentHostRuntime } from './host.js'
import { agentProcessEnvironment, assertProviderApiSupported, requireProviderCredential, writePrivateText } from './provider-runtime.js'
import { controlServerPath, packageFilePath } from './runtime-paths.js'

const require = createRequire(import.meta.url)

export class DshModelProviderAdapter implements AgentHostModelProviderAdapter {
  readonly supportedApis = ['anthropic-messages'] as const

  async prepare(options: AgentHostProviderPrepareOptions): Promise<AgentHostRuntime> {
    await mkdir(options.agentHome, { recursive: true, mode: 0o700 })
    const environment = agentProcessEnvironment(options.environment, undefined, options.provider === undefined)
    if (!options.provider) return { agentHome: options.agentHome, environment, mcpEnvironment: { ...options.mcpEnvironment } }

    assertProviderApiSupported('dsh', 'DeepSeek Harness', this.supportedApis, options.provider)
    const envKey = requireProviderCredential('dsh', options.provider, options.environment)
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
    if (cordisTemplate) {
      await writePrivateText(resolve(options.agentHome, 'cordis.yml'), await readFile(cordisTemplate, 'utf8'))
    } else {
      throw new Error('DSH requires AUTO_TEST_DSH_CORDIS_TEMPLATE pointing to an SDK JSON-RPC cordis.yml')
    }
    const tsxCli = require.resolve('tsx/cli')
    environment.AUTO_TEST_PLAYWRIGHT_COMMAND = process.execPath
    environment.AUTO_TEST_PLAYWRIGHT_ARGS = JSON.stringify([
      packageFilePath('@playwright/mcp', 'cli.js'), '--config', options.playwrightConfigPath, '--secrets', options.playwrightSecretsPath,
    ])
    environment.AUTO_TEST_CONTROL_COMMAND = process.execPath
    environment.AUTO_TEST_CONTROL_ARGS = JSON.stringify([tsxCli, controlServerPath(), options.controlConfigPath])
    environment.AUTO_TEST_MCP_ENV = JSON.stringify(options.mcpEnvironment)
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
