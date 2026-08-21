import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, extname, isAbsolute, resolve } from 'node:path'
import {
  type AgentModelApi,
  type AgentModelInputModality,
  type AgentModelProviderDescriptor,
  type AgentModelReasoningEffort,
} from '../core/model-provider.js'

/**
 * The only execution surface the Auto-Test core expects from an agent.
 *
 * Hosts are deliberately responsible for their own transport, session store,
 * model configuration, and native event format. The core consumes the
 * normalized events below and never imports a vendor SDK.
 */
export type AgentHostId = 'codex' | 'omp' | (string & {})
// Model capability contract now lives in core/model-provider.ts (a provider
// contract, not agent-specific); re-exported here for agent-layer consumers.
export {
  AGENT_MODEL_APIS,
  type AgentModelApi,
  type AgentModelCredential,
  type AgentModelInputModality,
  type AgentModelProviderDescriptor,
  type AgentModelReasoningEffort,
} from '../core/model-provider.js'


// Agent event contract lives in core/agent-events.ts; imported here for the
// host surface and re-exported for agent-layer consumers.
import {
  agentHostErrorKindForMessage,
  type AgentEvent,
  type AgentHostErrorKind,
  type AgentInputPart,
} from '../core/agent-events.js'
export {
  type AgentEventType,
  type AgentEvent,
  type AgentHostErrorKind,
  type AgentInputPart,
  type AgentUsage,
  agentHostErrorMessageForMatching,
  agentHostErrorKindForMessage,
  isAgentEvent,
  isAgentSessionIncompatibleMessage,
  normalizeAgentEvent,
  usageFrom,
} from '../core/agent-events.js'


export interface AgentHostCapabilities {
  streaming: boolean
  sessionResume: boolean
  structuredOutput: boolean
  localImages: boolean
  mcp: boolean
  shell: boolean
  network: boolean
  /** Filesystem boundary enforced by the host process itself. */
  workspaceIsolation: 'enforced' | 'prompt_only'
  /** Whether the adapter can enforce Auto-Test's legacy opaque/restricted mode. */
  restrictedMode: boolean
}

/** Auditable, secret-free result of translating a provider for one host. */
export interface AgentHostProviderBinding {
  profileId: string
  providerId: string
  baseUrl: string
  api: AgentModelApi
  model: string
  modelSelector: string
  configurationPath?: string
  modelCatalogPath?: string
  credentialEnvironmentVariable?: string
  displayName?: string
  reasoningEffort?: AgentModelReasoningEffort
  reasoningEfforts?: AgentModelReasoningEffort[]
  inputModalities?: AgentModelInputModality[]
  supportsParallelToolCalls?: boolean
  supportsSearchTool?: boolean
  serviceTier?: string
  contextWindowTokens?: number
  maxOutputTokens?: number
  supportsWebsockets?: boolean
}

export interface AgentHostRuntime {
  agentHome: string
  environment: Record<string, string>
  mcpEnvironment: Record<string, string>
  /** Host-native selector passed to the session launcher. */
  model?: string
  provider?: AgentHostProviderBinding
}

export interface AgentHostProviderPrepareOptions {
  workspaceDirectory: string
  privateDirectory: string
  agentHome: string
  /** Exact host executable selected by the caller, when explicitly configured. */
  executable?: string
  sourceAgentHome?: string
  playwrightConfigPath: string
  playwrightSecretsPath: string
  controlConfigPath: string
  environment: NodeJS.ProcessEnv
  mcpEnvironment: Record<string, string>
  model?: string
  provider?: AgentModelProviderDescriptor
  resume?: boolean
}

/**
 * The provider adapter is the only layer allowed to translate a generic model
 * endpoint into host-native files, selectors, arguments, or environment.
 */
export interface AgentHostModelProviderAdapter {
  readonly supportedApis: readonly AgentModelApi[]
  prepare(options: AgentHostProviderPrepareOptions): Promise<AgentHostRuntime>
}

export interface AgentHostLaunchOptions {
  workspaceDirectory: string
  runtime: AgentHostRuntime
  executable?: string
  /** Additional run-private directories that the host may write through its sandbox. */
  additionalWritableDirectories?: string[]
  resumeId?: string
  playwrightConfigPath: string
  playwrightSecretsPath: string
  controlConfigPath: string
  fullAgentAccess: boolean
}

export interface AgentHostRunOptions {
  outputSchema?: unknown
}

export interface AgentHostStream {
  events: AsyncGenerator<AgentEvent>
}

export interface AgentHostSession {
  readonly id: string | null
  run(input: AgentInputPart[], options?: AgentHostRunOptions): Promise<AgentHostStream>
  close?(): Promise<void>
}

export interface AgentHostProbeResult {
  ok: boolean
  hostId: AgentHostId
  executable?: string
  version?: string
  reason?: string
}


export interface AgentHost {
  readonly id: AgentHostId
  readonly displayName: string
  readonly capabilities: AgentHostCapabilities
  readonly modelProvider: AgentHostModelProviderAdapter
  probe(options: AgentHostLaunchOptions): Promise<AgentHostProbeResult>
  start(options: AgentHostLaunchOptions): Promise<AgentHostSession>
  resume(options: AgentHostLaunchOptions & { resumeId: string }): Promise<AgentHostSession>
}


export function normalizeAgentHostError(hostId: AgentHostId, error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error)
  const kind = agentHostErrorKindForMessage(message)
  if (error instanceof AgentHostError) {
    // An adapter's explicit capability/configuration/protocol classification
    // is authoritative; infer quota only for an unclassified transport.
    return kind && (error.kind === 'transport' || error.kind === 'unknown')
      ? new AgentHostError(hostId, message, kind)
      : error
  }
  return kind ? new AgentHostError(hostId, message, kind) : error
}

function executableNames(command: string, environment: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32' || extname(command)) return [command]
  const extensions = (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)]
}

export async function resolveHostExecutable(command: string, environment: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const candidate = isAbsolute(command) || command.includes('/') || command.includes('\\')
    ? resolve(process.cwd(), command)
    : undefined
  if (candidate) {
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      return undefined
    }
  }
  const pathValue = environment.Path ?? environment.PATH ?? ''
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const name of executableNames(command, environment)) {
      const path = resolve(directory, name)
      try {
        await access(path, fsConstants.X_OK)
        return path
      } catch {
        // Continue searching the host PATH.
      }
    }
  }
  return undefined
}

export class AgentHostError extends Error {
  readonly hostId: AgentHostId
  readonly kind: AgentHostErrorKind
  readonly retryable: boolean
  constructor(hostId: AgentHostId, message: string, kind: AgentHostErrorKind = 'transport') {
    super(message)
    this.name = 'AgentHostError'
    this.hostId = hostId
    this.kind = kind
    this.retryable = kind === 'transport' || kind === 'process' || kind === 'quota' || kind === 'session_incompatible'
  }
}
