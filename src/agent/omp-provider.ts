import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AgentHostModelProviderAdapter,
  AgentHostProviderPrepareOptions,
  AgentHostRuntime,
  AgentModelProviderDescriptor,
} from './host.js'
import { AGENT_MODEL_APIS } from './host.js'
import {
  agentProcessEnvironment,
  assertProviderApiSupported,
  copyPrivateFile,
  forwardedAgentEnvironmentNames,
  requireProviderCredential,
  writePrivateText,
} from './provider-runtime.js'
import { controlServerPath, packageFilePath } from './runtime-paths.js'
import { writePrivateJson } from './state.js'

const OMP_SUPPORTED_APIS: AgentHostModelProviderAdapter['supportedApis'] = AGENT_MODEL_APIS

const OMP_PROVIDER_FILES = [
  'config.yml',
  'config.yaml',
  'models.yml',
  'models.yaml',
  'agent.db',
  'agent.db-wal',
  'agent.db-shm',
  'auth.json',
  'settings.json',
  '.env',
] as const

async function writeOmpMcpConfig(options: AgentHostProviderPrepareOptions, mcpEnvironment: Record<string, string>): Promise<void> {
  let tsxCli: string
  try {
    tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'))
  } catch {
    tsxCli = createRequire(import.meta.url).resolve('tsx/cli')
  }
  const playwrightCli = packageFilePath('@playwright/mcp', 'cli.js')
  const path = resolve(options.workspaceDirectory, '.omp', 'mcp.json')
  await writePrivateJson(path, {
    mcpServers: {
      playwright: {
        type: 'stdio',
        command: process.execPath,
        args: [playwrightCli, '--config', options.playwrightConfigPath, '--secrets', options.playwrightSecretsPath],
        cwd: options.workspaceDirectory,
        env: mcpEnvironment,
        timeout: 180_000,
      },
      'auto-test-control': {
        type: 'stdio',
        command: process.execPath,
        args: [tsxCli, controlServerPath(), options.controlConfigPath],
        cwd: options.workspaceDirectory,
        env: mcpEnvironment,
        timeout: 60_000,
      },
    },
  })
}

async function writeOmpProjectConfig(workspaceDirectory: string): Promise<void> {
  await writePrivateText(resolve(workspaceDirectory, '.omp', 'config.yml'), [
    '# Auto-Test owns this project overlay for the selected OMP process.',
    '# The built-in browser must stay disabled so OMP loads the run-scoped',
    '# Playwright MCP instead of silently substituting a different browser.',
    'browser:',
    '  enabled: false',
    'mcp:',
    '  enableProjectConfig: true',
    'memory:',
    '  backend: off',
    'memories:',
    '  enabled: false',
    'autolearn:',
    '  enabled: false',
    'extensions: []',
    'startup:',
    '  checkUpdate: false',
    '  quiet: true',
    '',
  ].join('\n'))
}

function profileModelsConfig(
  provider: AgentModelProviderDescriptor,
  model: string,
  credentialEnvironmentVariable: string | undefined,
): string {
  const modelDefinition = {
    id: model,
    name: provider.displayName ?? provider.profileId,
    api: provider.api,
    reasoning: provider.reasoningEffort !== undefined,
    supportsTools: true,
    input: provider.inputModalities ?? ['text'],
    ...(provider.contextWindowTokens !== undefined ? { contextWindow: provider.contextWindowTokens } : {}),
    ...(provider.maxOutputTokens !== undefined ? { maxTokens: provider.maxOutputTokens } : {}),
    ...(provider.reasoningEffort !== undefined ? {
      thinking: {
        mode: 'effort',
        efforts: provider.reasoningEfforts ?? ['minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultLevel: provider.reasoningEffort,
      },
    } : {}),
  }
  const providerConfig = {
    baseUrl: provider.baseUrl,
    api: provider.api,
    ...(credentialEnvironmentVariable ? { apiKey: credentialEnvironmentVariable } : { auth: 'none' }),
    models: [modelDefinition],
  }
  // JSON is a valid YAML document and avoids a second hand-rolled serializer.
  return `${JSON.stringify({ providers: { [provider.providerId]: providerConfig } }, null, 2)}\n`
}

async function clearManagedProviderFiles(agentHome: string): Promise<void> {
  await Promise.all(OMP_PROVIDER_FILES.map((name) => rm(resolve(agentHome, name), { force: true })))
}

async function sourceDirectory(sourceHome: string, forwardedNames: Set<string>): Promise<string | undefined> {
  const candidates = [resolve(sourceHome), resolve(sourceHome, 'agent')]
  const names = forwardedNames.size > 0 ? [...OMP_PROVIDER_FILES] : OMP_PROVIDER_FILES.filter((name) => name !== '.env')
  for (const candidate of candidates) {
    for (const name of names) {
      if (await access(resolve(candidate, name)).then(() => true, () => false)) return candidate
    }
  }
  return undefined
}

async function copyNativeOmpHome(agentHome: string, sourceHome: string, forwardedNames: Set<string>): Promise<void> {
  const source = await sourceDirectory(sourceHome, forwardedNames)
  if (!source) return
  for (const name of OMP_PROVIDER_FILES.filter((item) => item !== '.env')) {
    const sourcePath = resolve(source, name)
    const destinationPath = resolve(agentHome, name)
    if (sourcePath === destinationPath) continue
    await copyPrivateFile(sourcePath, destinationPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
  if (forwardedNames.size > 0) {
    const sourceEnv = await readFile(resolve(source, '.env'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (sourceEnv !== undefined) {
      const selected = sourceEnv.split(/\r?\n/).flatMap((line) => {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
        return match && forwardedNames.has(match[1]!) ? [`${match[1]}=${match[2]}`] : []
      })
      if (selected.length > 0) await writePrivateText(resolve(agentHome, '.env'), `${selected.join('\n')}\n`)
    }
  }
}

export class OmpModelProviderAdapter implements AgentHostModelProviderAdapter {
  readonly supportedApis = OMP_SUPPORTED_APIS

  async prepare(options: AgentHostProviderPrepareOptions): Promise<AgentHostRuntime> {
    await mkdir(options.agentHome, { recursive: true, mode: 0o700 })
    const baseEnvironment = agentProcessEnvironment(options.environment, undefined, options.provider === undefined)
    const mcpEnvironment = { ...options.mcpEnvironment }
    const isolatedHome = resolve(options.privateDirectory, 'omp-home')
    const mcpHome = resolve(options.privateDirectory, 'omp-mcp-home')
    await mkdir(isolatedHome, { recursive: true, mode: 0o700 })
    await mkdir(mcpHome, { recursive: true, mode: 0o700 })
    baseEnvironment.PI_CODING_AGENT_DIR = options.agentHome
    baseEnvironment.HOME = isolatedHome
    baseEnvironment.USERPROFILE = isolatedHome
    delete baseEnvironment.OMP_PROFILE
    delete baseEnvironment.PI_PROFILE
    mcpEnvironment.HOME = mcpHome
    mcpEnvironment.USERPROFILE = mcpHome
    delete mcpEnvironment.PI_CODING_AGENT_DIR

    let credentialEnvironmentVariable: string | undefined
    if (options.provider) {
      assertProviderApiSupported('omp', 'oh-my-pi', this.supportedApis, options.provider)
      credentialEnvironmentVariable = requireProviderCredential('omp', options.provider, options.environment)
      if (credentialEnvironmentVariable) {
        baseEnvironment[credentialEnvironmentVariable] = options.environment[credentialEnvironmentVariable]!
        delete mcpEnvironment[credentialEnvironmentVariable]
      }
    }

    await writeOmpMcpConfig(options, mcpEnvironment)
    await writeOmpProjectConfig(options.workspaceDirectory)

    if (options.provider) {
      const model = options.model ?? options.provider.model
      const configurationPath = resolve(options.agentHome, 'models.yml')
      await clearManagedProviderFiles(options.agentHome)
      await writePrivateText(configurationPath, profileModelsConfig(options.provider, model, credentialEnvironmentVariable))
      return {
        agentHome: options.agentHome,
        environment: baseEnvironment,
        mcpEnvironment,
        model: `${options.provider.providerId}/${model}`,
        provider: {
          profileId: options.provider.profileId,
          providerId: options.provider.providerId,
          baseUrl: options.provider.baseUrl,
          api: options.provider.api,
          model,
          modelSelector: `${options.provider.providerId}/${model}`,
          configurationPath,
          ...(credentialEnvironmentVariable ? { credentialEnvironmentVariable } : {}),
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

    const sourceHome = options.sourceAgentHome ?? options.environment.AUTO_TEST_AGENT_HOME ?? options.environment.AUTO_TEST_OMP_HOME ?? resolve(options.environment.HOME ?? process.env.HOME ?? '.', '.omp', 'agent')
    if (!(options.resume && !options.sourceAgentHome)) {
      const sourceCandidates = [resolve(sourceHome), resolve(sourceHome, 'agent')]
      if (!sourceCandidates.includes(resolve(options.agentHome))) {
        await clearManagedProviderFiles(options.agentHome)
        await copyNativeOmpHome(options.agentHome, sourceHome, forwardedAgentEnvironmentNames(options.environment))
      }
    }
    return {
      agentHome: options.agentHome,
      environment: baseEnvironment,
      mcpEnvironment,
      ...(options.model ? { model: options.model } : {}),
    }
  }
}
