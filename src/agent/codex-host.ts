import { Codex, type Input, type Thread, type ThreadEvent } from '@openai/codex-sdk'
import { delimiter, dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AgentEvent,
  AgentHost,
  AgentHostCapabilities,
  AgentHostLaunchOptions,
  AgentHostProbeResult,
  AgentHostSession,
  AgentInputPart,
  AgentHostStream,
} from './host.js'
import { AgentHostError, normalizeAgentEvent, resolveHostExecutable } from './host.js'

interface CodexThreadLike {
  readonly id: string | null
  runStreamed(input: Input, options?: { outputSchema?: unknown }): Promise<{ events: AsyncGenerator<ThreadEvent> }>
}

export interface LegacyCodexThreadFactory {
  startThread(options: {
    workspaceDirectory: string
    agentHome: string
    model?: string
    codexExecutable: string
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
    codexExecutable: string
    playwrightConfigPath: string
    playwrightSecretsPath: string
    controlConfigPath: string
    codexEnvironment: Record<string, string>
    mcpEnvironment: Record<string, string>
    fullAgentAccess: boolean
  }): CodexThreadLike
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))

function packageFilePath(packageName: string, fileName: string): string {
  const packagePath = import.meta.resolve(`${packageName}/package.json`)
  return resolve(dirname(fileURLToPath(packagePath)), fileName)
}

function controlServerPath(): string {
  const extension = extname(fileURLToPath(import.meta.url)) === '.ts' ? '.ts' : '.js'
  return resolve(moduleDirectory, `control-server${extension}`)
}

function toCodexInput(input: AgentInputPart[]): Input {
  return input.map((part) => part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'local_image', path: part.path }) as Input
}

async function resolveCodexExecutable(executable: string | undefined, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const configured = executable || environment.AUTO_TEST_CODEX_BIN || process.env.AUTO_TEST_CODEX_BIN || 'codex'
  const pathKey = environment.Path !== undefined ? 'Path' : 'PATH'
  const pathValue = environment[pathKey]
  const filteredEnvironment = configured === 'codex' && pathValue
    ? { ...environment, [pathKey]: pathValue.split(delimiter).filter((entry) => !/[\\/]node_modules[\\/]\.bin(?:[\\/]|$)/i.test(entry)).join(delimiter) }
    : environment
  const resolved = await resolveHostExecutable(configured, filteredEnvironment)
  if (resolved) return resolved
  // Keep the old diagnostic for callers that supplied a path or relied on PATH.
  if (executable || process.env.AUTO_TEST_CODEX_BIN) {
    throw new AgentHostError('codex', `Configured Codex CLI executable is unavailable: ${configured}`)
  }
  throw new AgentHostError('codex', 'Current Codex CLI executable was not found. Install Codex CLI or set AUTO_TEST_CODEX_BIN.')
}

function restrictedPlaywrightTools(fullAgentAccess: boolean): string[] | undefined {
  if (fullAgentAccess) return undefined
  return [
    'browser_click', 'browser_check', 'browser_close', 'browser_console_messages', 'browser_drag', 'browser_drop',
    'browser_file_upload', 'browser_fill_form', 'browser_find', 'browser_handle_dialog', 'browser_hover',
    'browser_navigate', 'browser_navigate_back', 'browser_navigate_forward', 'browser_network_request',
    'browser_network_requests', 'browser_press_key', 'browser_reload', 'browser_resize', 'browser_select_option',
    'browser_snapshot', 'browser_tabs', 'browser_take_screenshot', 'browser_type', 'browser_uncheck', 'browser_verify_element_visible',
    'browser_verify_list_visible', 'browser_verify_text_visible', 'browser_verify_value', 'browser_wait_for',
    'browser_cookie_clear', 'browser_localstorage_clear', 'browser_sessionstorage_clear', 'browser_set_storage_state',
  ]
}

export function startCodexSdkThread(options: AgentHostLaunchOptions): Thread {
  if (!options.executable) throw new AgentHostError('codex', 'Codex executable was not resolved before starting a thread')
  const playwrightCli = packageFilePath('@playwright/mcp', 'cli.js')
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'))
  const controlServer = controlServerPath()
  const enabledTools = restrictedPlaywrightTools(options.fullAgentAccess)
  const playwrightServer = {
    command: process.execPath,
    args: [playwrightCli, '--config', options.playwrightConfigPath, '--secrets', options.playwrightSecretsPath],
    cwd: options.workspaceDirectory,
    env: options.mcpEnvironment,
    required: true,
    startup_timeout_sec: 60,
    tool_timeout_sec: 180,
    default_tools_approval_mode: 'approve',
    ...(enabledTools ? { enabled_tools: enabledTools } : {}),
  }
  const codex = new Codex({
    codexPathOverride: options.executable,
    env: { ...options.environment, CODEX_HOME: options.agentHome },
    config: {
      developer_instructions: options.fullAgentAccess
        ? 'Act as the primary test engineer. Use the raw run inputs, shell, writable workspace, network, and full Playwright MCP autonomously. Follow workspace AGENTS.md. Do not edit files outside the run workspace.'
        : 'Operate only as the Auto-Test web testing agent. Follow the workspace AGENTS.md and configured MCP instructions. Do not modify source code.',
      features: {
        shell_tool: options.fullAgentAccess,
        apps: false,
        multi_agent: options.fullAgentAccess,
        remote_plugin: false,
        hooks: false,
        memories: false,
      },
      tools: { web_search: options.fullAgentAccess },
      mcp_servers: {
        playwright: playwrightServer,
        'auto-test-control': {
          command: process.execPath,
          args: [tsxCli, controlServer, options.controlConfigPath],
          cwd: options.workspaceDirectory,
          env: options.mcpEnvironment,
          required: true,
          startup_timeout_sec: 60,
          tool_timeout_sec: 60,
          default_tools_approval_mode: 'approve',
        },
      },
    },
  })
  const threadOptions = {
    ...(options.model ? { model: options.model } : {}),
    sandboxMode: options.fullAgentAccess ? 'workspace-write' : 'read-only',
    workingDirectory: options.workspaceDirectory,
    skipGitRepoCheck: true,
    modelReasoningEffort: 'xhigh',
    networkAccessEnabled: options.fullAgentAccess,
    webSearchMode: options.fullAgentAccess ? 'live' : 'disabled',
    approvalPolicy: 'never',
  } as const
  return options.resumeId
    ? codex.resumeThread(options.resumeId, threadOptions)
    : codex.startThread(threadOptions)
}

class CodexSession implements AgentHostSession {
  constructor(private readonly thread: CodexThreadLike) {}

  get id(): string | null {
    return this.thread.id
  }

  async run(input: AgentInputPart[], options?: { outputSchema?: unknown }): Promise<AgentHostStream> {
    const stream = await this.thread.runStreamed(toCodexInput(input), options)
    return {
      events: (async function* (): AsyncGenerator<AgentEvent> {
        for await (const event of stream.events) yield normalizeAgentEvent(event)
      })(),
    }
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
  workspaceIsolation: 'enforced',
  restrictedMode: true,
}

export class CodexAgentHost implements AgentHost {
  readonly id = 'codex' as const
  readonly displayName = 'Codex CLI'
  readonly capabilities = capabilities

  async probe(options: AgentHostLaunchOptions): Promise<AgentHostProbeResult> {
    let executable: string | undefined
    let reason: string | undefined
    try {
      executable = await resolveCodexExecutable(options.executable, options.environment)
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
    }
    return executable
      ? { ok: true, hostId: this.id, executable }
      : { ok: false, hostId: this.id, reason: reason ?? 'Codex CLI executable is unavailable' }
  }

  async start(options: AgentHostLaunchOptions): Promise<AgentHostSession> {
    const executable = await resolveCodexExecutable(options.executable, options.environment)
    return new CodexSession(startCodexSdkThread({ ...options, executable }))
  }

  async resume(options: AgentHostLaunchOptions & { resumeId: string }): Promise<AgentHostSession> {
    const executable = await resolveCodexExecutable(options.executable, options.environment)
    return new CodexSession(startCodexSdkThread({ ...options, executable }))
  }
}

/** Adapter used by the existing unit-test seam and third-party integrations. */
export function createLegacyCodexAgentHost(factory: LegacyCodexThreadFactory, executable = 'codex'): AgentHost {
  return {
    id: 'codex',
    displayName: 'Codex CLI (injected)',
    capabilities,
    async probe(): Promise<AgentHostProbeResult> {
      return { ok: true, hostId: 'codex', executable }
    },
    async start(options: AgentHostLaunchOptions): Promise<AgentHostSession> {
      return new CodexSession(factory.startThread({
        workspaceDirectory: options.workspaceDirectory,
        agentHome: options.agentHome,
        ...(options.model ? { model: options.model } : {}),
        codexExecutable: options.executable ?? executable,
        playwrightConfigPath: options.playwrightConfigPath,
        playwrightSecretsPath: options.playwrightSecretsPath,
        controlConfigPath: options.controlConfigPath,
        codexEnvironment: options.environment,
        mcpEnvironment: options.mcpEnvironment,
        fullAgentAccess: options.fullAgentAccess,
      }))
    },
    async resume(options: AgentHostLaunchOptions & { resumeId: string }): Promise<AgentHostSession> {
      return new CodexSession(factory.resumeThread({
        threadId: options.resumeId,
        workspaceDirectory: options.workspaceDirectory,
        agentHome: options.agentHome,
        ...(options.model ? { model: options.model } : {}),
        codexExecutable: options.executable ?? executable,
        playwrightConfigPath: options.playwrightConfigPath,
        playwrightSecretsPath: options.playwrightSecretsPath,
        controlConfigPath: options.controlConfigPath,
        codexEnvironment: options.environment,
        mcpEnvironment: options.mcpEnvironment,
        fullAgentAccess: options.fullAgentAccess,
      }))
    },
  }
}
