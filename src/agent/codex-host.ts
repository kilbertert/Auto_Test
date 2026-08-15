import { Codex, type Input, type Thread, type ThreadEvent } from '@openai/codex-sdk'
import { createRequire } from 'node:module'
import type {
  AgentEvent,
  AgentHost,
  AgentHostCapabilities,
  AgentHostModelProviderAdapter,
  AgentHostLaunchOptions,
  AgentHostProbeResult,
  AgentHostSession,
  AgentInputPart,
  AgentHostStream,
} from './host.js'
import { AgentHostError, isAgentSessionIncompatibleMessage, normalizeAgentEvent } from './host.js'
import { resolveCodexExecutable } from './codex-executable.js'
import { CodexModelProviderAdapter } from './codex-provider.js'
import { startResponsesToolBridge, type ResponsesToolBridge } from './responses-tool-bridge.js'
import { controlServerPath, packageFilePath } from './runtime-paths.js'

const require = createRequire(import.meta.url)

interface CodexThreadLike {
  readonly id: string | null
  runStreamed(input: Input, options?: { outputSchema?: unknown }): Promise<{ events: AsyncGenerator<ThreadEvent> }>
}

export interface LegacyCodexThreadFactory {
  startThread(options: {
    workspaceDirectory: string
    agentHome: string
    model?: string
    wireApi?: 'responses' | 'chat'
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    modelContextWindow?: number
    supportsWebsockets?: boolean
    codexExecutable: string
    additionalDirectories?: string[]
    playwrightConfigPath: string
    playwrightSecretsPath: string
    controlConfigPath: string
    codexEnvironment: Record<string, string>
    mcpEnvironment: Record<string, string>
    fullAgentAccess: boolean
  }): CodexThreadLike
  resumeThread(options: {
    threadId: string
    workspaceDirectory: string
    agentHome: string
    model?: string
    wireApi?: 'responses' | 'chat'
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    modelContextWindow?: number
    supportsWebsockets?: boolean
    codexExecutable: string
    additionalDirectories?: string[]
    playwrightConfigPath: string
    playwrightSecretsPath: string
    controlConfigPath: string
    codexEnvironment: Record<string, string>
    mcpEnvironment: Record<string, string>
    fullAgentAccess: boolean
  }): CodexThreadLike
}

function toCodexInput(input: AgentInputPart[]): Input {
  return input.map((part) => part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'local_image', path: part.path }) as Input
}

function rethrowCodexSessionError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (isAgentSessionIncompatibleMessage(message)) {
    throw new AgentHostError('codex', message, 'session_incompatible')
  }
  throw error
}

function restrictedPlaywrightTools(fullAgentAccess: boolean): string[] | undefined {
  if (fullAgentAccess) return undefined
  return [
    'browser_click', 'browser_check', 'browser_close', 'browser_console_messages', 'browser_drag', 'browser_drop',
    'browser_file_upload', 'browser_fill_form', 'browser_find', 'browser_handle_dialog', 'browser_hover',
    'browser_navigate', 'browser_navigate_back', 'browser_navigate_forward', 'browser_network_request',
    'browser_network_requests', 'browser_press_key', 'browser_reload', 'browser_resize', 'browser_select_option',
    'browser_snapshot', 'browser_tabs', 'browser_take_screenshot', 'browser_type', 'browser_uncheck', 'browser_evaluate', 'browser_storage_state', 'browser_verify_element_visible',
    'browser_verify_list_visible', 'browser_verify_text_visible', 'browser_verify_value', 'browser_wait_for',
    'browser_cookie_clear', 'browser_localstorage_clear', 'browser_sessionstorage_clear', 'browser_set_storage_state',
  ]
}

/**
 * The native Windows Codex runner cannot launch child MCP processes or run
 * writable shell commands under its workspace-write policy.  The CLI's
 * danger-full-access mode is the documented escape hatch for an externally
 * isolated automation process.  Auto-Test still constrains business writes
 * through the Control MCP and Mutation Ledger, while the host capability
 * below records that the OS-level workspace sandbox is not enforced there.
 */
export function codexSandboxMode(
  fullAgentAccess: boolean,
  platform: NodeJS.Platform = process.platform,
): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (!fullAgentAccess) return 'read-only'
  return platform === 'win32' ? 'danger-full-access' : 'workspace-write'
}

export function codexWorkspaceIsolation(
  platform: NodeJS.Platform = process.platform,
): AgentHostCapabilities['workspaceIsolation'] {
  return platform === 'win32' ? 'prompt_only' : 'enforced'
}

export function codexWebSearchEnabled(runtime: AgentHostLaunchOptions['runtime'], fullAgentAccess: boolean): boolean {
  const modelSupportsSearch = runtime.provider
    ? runtime.provider.supportsSearchTool === true
    : true
  return fullAgentAccess && modelSupportsSearch
}

export function startCodexSdkThread(
  options: AgentHostLaunchOptions & { providerBaseUrlOverride?: string },
  platform: NodeJS.Platform = process.platform,
): Thread {
  if (!options.executable) throw new AgentHostError('codex', 'Codex executable was not resolved before starting a thread', 'configuration')
  const playwrightCli = packageFilePath('@playwright/mcp', 'cli.js')
  const tsxCli = require.resolve('tsx/cli')
  const controlServer = controlServerPath()
  const enabledTools = restrictedPlaywrightTools(options.fullAgentAccess)
  const webSearchEnabled = codexWebSearchEnabled(options.runtime, options.fullAgentAccess)
  const playwrightServer = {
    command: process.execPath,
    args: [playwrightCli, '--config', options.playwrightConfigPath, '--secrets', options.playwrightSecretsPath],
    cwd: options.workspaceDirectory,
    env: options.runtime.mcpEnvironment,
    required: true,
    startup_timeout_sec: 60,
    tool_timeout_sec: 180,
    default_tools_approval_mode: 'approve',
    ...(enabledTools ? { enabled_tools: enabledTools } : {}),
  }
  const codex = new Codex({
    codexPathOverride: options.executable,
    env: { ...options.runtime.environment, CODEX_HOME: options.runtime.agentHome },
    config: {
      developer_instructions: options.fullAgentAccess
        ? 'Act as the primary test engineer. Use the raw run inputs, shell, writable workspace, network, and full Playwright MCP autonomously. Follow workspace AGENTS.md. Do not edit files outside the run workspace.'
        : 'Operate only as the Auto-Test web testing agent. Follow the workspace AGENTS.md and configured MCP instructions. Do not modify source code.',
      features: {
        shell_tool: options.fullAgentAccess,
        apps: false,
        plugins: false,
        multi_agent: false,
        remote_plugin: false,
        hooks: false,
        memories: false,
      },
      tools: { web_search: webSearchEnabled },
      ...(options.providerBaseUrlOverride && options.runtime.provider ? {
        model_providers: {
          [options.runtime.provider.providerId]: { base_url: options.providerBaseUrlOverride },
        },
      } : {}),
      mcp_servers: {
        playwright: playwrightServer,
        'auto-test-control': {
          command: process.execPath,
          args: [tsxCli, controlServer, options.controlConfigPath],
          cwd: options.workspaceDirectory,
          env: options.runtime.mcpEnvironment,
          required: true,
          startup_timeout_sec: 60,
          tool_timeout_sec: 60,
          default_tools_approval_mode: 'approve',
        },
      },
    },
  })
  const managedReasoningEffort = options.runtime.provider?.reasoningEffort
  const threadOptions = {
    ...(options.runtime.model ? { model: options.runtime.model } : {}),
    sandboxMode: codexSandboxMode(options.fullAgentAccess, platform),
    workingDirectory: options.workspaceDirectory,
    skipGitRepoCheck: true,
    ...(managedReasoningEffort
      ? { modelReasoningEffort: managedReasoningEffort }
      : options.runtime.provider ? {} : { modelReasoningEffort: 'xhigh' as const }),
    networkAccessEnabled: options.fullAgentAccess,
    webSearchMode: webSearchEnabled ? 'live' : 'disabled',
    approvalPolicy: 'never',
    ...(options.additionalWritableDirectories?.length
      ? { additionalDirectories: [...new Set(options.additionalWritableDirectories)] }
      : {}),
  } as const
  return options.resumeId
    ? codex.resumeThread(options.resumeId, threadOptions)
    : codex.startThread(threadOptions)
}

class CodexSession implements AgentHostSession {
  private closed = false

  constructor(
    private readonly thread: CodexThreadLike,
    private readonly bridge?: ResponsesToolBridge,
  ) {}

  get id(): string | null {
    return this.thread.id
  }

  async run(input: AgentInputPart[], options?: { outputSchema?: unknown }): Promise<AgentHostStream> {
    let stream: Awaited<ReturnType<CodexThreadLike['runStreamed']>>
    try {
      stream = await this.thread.runStreamed(toCodexInput(input), options)
    } catch (error) {
      rethrowCodexSessionError(error)
    }
    return {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        try {
          for await (const event of stream.events) yield normalizeAgentEvent(event)
        } catch (error) {
          rethrowCodexSessionError(error)
        }
      })(),
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.bridge?.close()
  }
}

const capabilities: AgentHostCapabilities = {
  streaming: true,
  sessionResume: true,
  structuredOutput: true,
  localImages: true,
  mcp: true,
  shell: true,
  network: true,
  workspaceIsolation: codexWorkspaceIsolation(),
  restrictedMode: true,
}

export class CodexAgentHost implements AgentHost {
  readonly id = 'codex' as const
  readonly displayName = 'Codex CLI'
  readonly capabilities = capabilities
  readonly modelProvider: AgentHostModelProviderAdapter = new CodexModelProviderAdapter()

  async probe(options: AgentHostLaunchOptions): Promise<AgentHostProbeResult> {
    let executable: string | undefined
    let reason: string | undefined
    try {
      executable = await resolveCodexExecutable(options.executable, options.runtime.environment)
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
    }
    return executable
      ? { ok: true, hostId: this.id, executable }
      : { ok: false, hostId: this.id, reason: reason ?? 'Codex CLI executable is unavailable' }
  }

  private async open(options: AgentHostLaunchOptions): Promise<AgentHostSession> {
    const executable = await resolveCodexExecutable(options.executable, options.runtime.environment)
    const bridge = options.runtime.provider ? await startResponsesToolBridge(options.runtime.provider.baseUrl) : undefined
    try {
      return new CodexSession(startCodexSdkThread({
        ...options,
        executable,
        ...(bridge ? { providerBaseUrlOverride: bridge.baseUrl } : {}),
      }), bridge)
    } catch (error) {
      await bridge?.close()
      throw error
    }
  }

  async start(options: AgentHostLaunchOptions): Promise<AgentHostSession> {
    return this.open(options)
  }

  async resume(options: AgentHostLaunchOptions & { resumeId: string }): Promise<AgentHostSession> {
    return this.open(options)
  }
}

/** Adapter used by the existing unit-test seam and third-party integrations. */
export function createLegacyCodexAgentHost(factory: LegacyCodexThreadFactory, executable = 'codex'): AgentHost {
  const legacyOptions = (options: AgentHostLaunchOptions) => ({
    workspaceDirectory: options.workspaceDirectory,
    agentHome: options.runtime.agentHome,
    ...(options.runtime.model ? { model: options.runtime.model } : {}),
    ...(options.runtime.provider?.api === 'openai-responses' ? { wireApi: 'responses' as const } : {}),
    ...(options.runtime.provider?.reasoningEffort ? { reasoningEffort: options.runtime.provider.reasoningEffort } : {}),
    ...(options.runtime.provider?.contextWindowTokens !== undefined ? { modelContextWindow: options.runtime.provider.contextWindowTokens } : {}),
    ...(options.runtime.provider?.supportsWebsockets !== undefined ? { supportsWebsockets: options.runtime.provider.supportsWebsockets } : {}),
    codexExecutable: options.executable ?? executable,
    ...(options.additionalWritableDirectories ? { additionalDirectories: [...options.additionalWritableDirectories] } : {}),
    playwrightConfigPath: options.playwrightConfigPath,
    playwrightSecretsPath: options.playwrightSecretsPath,
    controlConfigPath: options.controlConfigPath,
    codexEnvironment: options.runtime.environment,
    mcpEnvironment: options.runtime.mcpEnvironment,
    fullAgentAccess: options.fullAgentAccess,
  })
  return {
    id: 'codex',
    displayName: 'Codex CLI (injected)',
    capabilities,
    modelProvider: new CodexModelProviderAdapter(),
    async probe(): Promise<AgentHostProbeResult> {
      return { ok: true, hostId: 'codex', executable }
    },
    async start(options: AgentHostLaunchOptions): Promise<AgentHostSession> {
      return new CodexSession(factory.startThread(legacyOptions(options)))
    },
    async resume(options: AgentHostLaunchOptions & { resumeId: string }): Promise<AgentHostSession> {
      return new CodexSession(factory.resumeThread({
        threadId: options.resumeId,
        ...legacyOptions(options),
      }))
    },
  }
}
