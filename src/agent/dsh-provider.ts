import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AgentHostModelProviderAdapter, AgentHostProviderPrepareOptions, AgentHostRuntime } from './host.js'
import { agentProcessEnvironment, assertProviderApiSupported, requireProviderCredential, writePrivateText } from './provider-runtime.js'

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
