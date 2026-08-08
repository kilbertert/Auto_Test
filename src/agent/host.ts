import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, extname, isAbsolute, resolve } from 'node:path'

/**
 * The only execution surface the Auto-Test core expects from an agent.
 *
 * Hosts are deliberately responsible for their own transport, session store,
 * model configuration, and native event format. The core consumes the
 * normalized events below and never imports a vendor SDK.
 */
export type AgentHostId = 'codex' | 'omp' | (string & {})
export const AGENT_MODEL_APIS = [
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
  'azure-openai-responses',
  'anthropic-messages',
  'bedrock-converse-stream',
  'google-generative-ai',
  'google-gemini-cli',
  'google-vertex',
] as const
export type AgentModelApi = typeof AGENT_MODEL_APIS[number]
export type AgentModelReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
export type AgentModelInputModality = 'text' | 'image'

export type AgentModelCredential =
  | { type: 'environment'; name: string }
  | { type: 'none' }

/** Host-neutral model endpoint selected once for an Auto-Test run. */
export interface AgentModelProviderDescriptor {
  profileId: string
  providerId: string
  model: string
  baseUrl: string
  api: AgentModelApi
  credential: AgentModelCredential
  displayName?: string
  reasoningEffort?: AgentModelReasoningEffort
  reasoningEfforts?: AgentModelReasoningEffort[]
  inputModalities?: AgentModelInputModality[]
  supportsParallelToolCalls?: boolean
  supportsSearchTool?: boolean
  serviceTier?: string
  supportsWebsockets?: boolean
  contextWindowTokens?: number
  maxOutputTokens?: number
}

export type AgentInputPart =
  | { type: 'text'; text: string }
  | { type: 'local_image'; path: string }

export interface AgentUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

export type AgentEventType =
  | 'thread_started'
  | 'turn_started'
  | 'turn_completed'
  | 'turn_failed'
  | 'session_incompatible'
  | 'error'
  | 'agent_message'
  | 'tool_started'
  | 'tool_completed'
  | 'command_started'
  | 'command_completed'
  | 'file_change_started'
  | 'file_change_completed'
  | 'reasoning_started'
  | 'todo_started'
  | 'other'

export interface AgentEvent {
  type: AgentEventType
  raw?: unknown | undefined
  threadId?: string | undefined
  message?: string | undefined
  text?: string | undefined
  usage?: AgentUsage | undefined
  id?: string | undefined
  server?: string | undefined
  tool?: string | undefined
  callId?: string | undefined
  status?: 'completed' | 'failed' | undefined
  arguments?: unknown | undefined
  result?: unknown | undefined
}

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

export type AgentHostErrorKind =
  | 'transport'
  | 'process'
  | 'quota'
  | 'session_incompatible'
  | 'capability'
  | 'configuration'
  | 'protocol'
  | 'unknown'

export interface AgentHost {
  readonly id: AgentHostId
  readonly displayName: string
  readonly capabilities: AgentHostCapabilities
  readonly modelProvider: AgentHostModelProviderAdapter
  probe(options: AgentHostLaunchOptions): Promise<AgentHostProbeResult>
  start(options: AgentHostLaunchOptions): Promise<AgentHostSession>
  resume(options: AgentHostLaunchOptions & { resumeId: string }): Promise<AgentHostSession>
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  return Boolean(value && typeof value === 'object' && 'type' in value && typeof (value as { type?: unknown }).type === 'string')
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function eventWithRaw(event: AgentEvent, raw: unknown): AgentEvent {
  return { ...event, raw }
}

function usageFrom(value: unknown): AgentUsage | undefined {
  const record = recordValue(value)
  if (!record) return undefined
  const inputTokens = record.inputTokens ?? record.input_tokens
  const cachedInputTokens = record.cachedInputTokens ?? record.cached_input_tokens
  const outputTokens = record.outputTokens ?? record.output_tokens
  if (![inputTokens, cachedInputTokens, outputTokens].every((item) => typeof item === 'number')) return undefined
  return { inputTokens: inputTokens as number, cachedInputTokens: cachedInputTokens as number, outputTokens: outputTokens as number }
}

const advisoryHostMessagePatterns = [
  /^Model metadata for `[^`]+` not found\. Defaulting to fallback metadata\b/i,
  /^Heads up: Long threads and multiple compactions can cause the model to be less accurate\./i,
  /^Skill descriptions were shortened to fit the skills context budget\./i,
]

const incompatibleSessionMessagePatterns = [
  /^This (?:session|thread) was (?:recorded|created|started) with (?:model|provider) .+ but is resuming with .+[.]?$/i,
  /\bCannot resume (?:session|thread)\b.*\b(?:different|incompatible)\b.*\b(?:model|provider)\b/i,
  /\b(?:session|thread)\b.*\b(?:model|provider)\b.*\b(?:mismatch|incompatible)\b/i,
]

/** These Codex advisories do not stop the following turn from running. */
function isAdvisoryHostMessage(message: string): boolean {
  return advisoryHostMessagePatterns.some((pattern) => pattern.test(message))
}

/** Host adapters use this only for physical-session compatibility failures. */
export function isAgentSessionIncompatibleMessage(message: string): boolean {
  return incompatibleSessionMessagePatterns.some((pattern) => pattern.test(message))
}

function normalizedFailureEvent(message: string, raw: unknown, id?: string): AgentEvent {
  if (isAdvisoryHostMessage(message)) return eventWithRaw({ type: 'other', ...(id ? { id } : {}), message }, raw)
  if (isAgentSessionIncompatibleMessage(message)) {
    return eventWithRaw({ type: 'session_incompatible', ...(id ? { id } : {}), message }, raw)
  }
  return eventWithRaw({ type: 'error', ...(id ? { id } : {}), message }, raw)
}

function normalizeItemEvent(raw: Record<string, unknown>, item: Record<string, unknown>): AgentEvent {
  const itemType = stringValue(item.type)
  const itemId = stringValue(item.id)
  const status = item.status === 'failed' || item.isError === true ? 'failed' : 'completed'
  if (itemType === 'mcp_tool_call') {
    return {
      type: raw.type === 'item.started' ? 'tool_started' : 'tool_completed',
      id: itemId,
      callId: itemId,
      server: stringValue(item.server),
      tool: stringValue(item.tool) ?? 'mcp_tool',
      status,
      arguments: item.arguments,
      result: item.result,
      raw,
    }
  }
  if (itemType === 'command_execution') {
    return {
      type: raw.type === 'item.started' ? 'command_started' : 'command_completed',
      id: itemId,
      callId: itemId,
      tool: 'command_execution',
      status,
      raw,
    }
  }
  if (itemType === 'file_change') {
    return {
      type: raw.type === 'item.started' ? 'file_change_started' : 'file_change_completed',
      id: itemId,
      callId: itemId,
      tool: 'file_change',
      status,
      raw,
    }
  }
  if (itemType === 'reasoning') return eventWithRaw({ type: 'reasoning_started', id: itemId }, raw)
  if (itemType === 'todo_list') return eventWithRaw({ type: 'todo_started', id: itemId }, raw)
  if (itemType === 'web_search') return eventWithRaw({ type: 'tool_completed', id: itemId, tool: 'web_search', status }, raw)
  if (itemType === 'agent_message') return eventWithRaw({ type: 'agent_message', id: itemId, text: stringValue(item.text) ?? '' }, raw)
  if (itemType === 'error') {
    const message = stringValue(item.message) ?? 'agent item failed'
    return normalizedFailureEvent(message, raw, itemId)
  }
  return eventWithRaw({ type: 'other', id: itemId }, raw)
}

function normalizeOmpMessage(raw: Record<string, unknown>): AgentEvent | undefined {
  const message = recordValue(raw.message)
  if (!message) return undefined
  const role = stringValue(message.role)
  if (role !== 'assistant') return undefined
  const content = message.content
  if (typeof content === 'string') return content ? eventWithRaw({ type: 'agent_message', text: content }, raw) : undefined
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((part) => {
      const value = recordValue(part)
      return value?.type === 'text' ? stringValue(value.text) ?? '' : ''
    })
    .join('')
  if (!text) return undefined
  return eventWithRaw({ type: 'agent_message', text }, raw)
}

function parseOmpMcpIdentity(value: string, inner?: Record<string, unknown>): { server?: string; tool: string } | undefined {
  if (!value.startsWith('mcp__')) return undefined
  const innerServer = stringValue(inner?.serverName)
  const innerTool = stringValue(inner?.mcpToolName)
  if (innerTool) return { ...(innerServer ? { server: innerServer } : {}), tool: innerTool }
  if (value.startsWith('mcp__playwright_')) return { server: 'playwright', tool: value.slice('mcp__playwright_'.length) }
  if (value.startsWith('mcp__auto_test_control_')) {
    return { server: 'auto-test-control', tool: value.slice('mcp__auto_test_control_'.length) }
  }
  return { tool: value }
}

function parseOmpXdArguments(value: unknown): unknown {
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function ompXdInvocation(raw: Record<string, unknown>): {
  server?: string
  tool: string
  arguments?: unknown
  failed: boolean
} | undefined {
  const result = recordValue(raw.result)
  const xdev = recordValue(recordValue(result?.details)?.xdev)
  const inner = recordValue(xdev?.inner)
  const completedIdentity = stringValue(xdev?.mode) === 'execute'
    ? parseOmpMcpIdentity(stringValue(xdev?.tool) ?? '', inner)
    : undefined
  if (completedIdentity) {
    return {
      ...completedIdentity,
      ...(xdev?.args !== undefined ? { arguments: xdev.args } : {}),
      failed: raw.isError === true || result?.isError === true || inner?.isError === true,
    }
  }

  if (raw.type !== 'tool_execution_start' || raw.toolName !== 'write') return undefined
  const args = recordValue(raw.args)
  const path = stringValue(args?.path)
  if (!path?.startsWith('xd://mcp__')) return undefined
  const identity = parseOmpMcpIdentity(path.slice('xd://'.length))
  if (!identity) return undefined
  const invocationArguments = parseOmpXdArguments(args?.content)
  return {
    ...identity,
    ...(invocationArguments !== undefined ? { arguments: invocationArguments } : {}),
    failed: false,
  }
}

/** Normalize Codex SDK events, OMP RPC events, and already-normalized events. */
export function normalizeAgentEvent(value: unknown): AgentEvent {
  if (!recordValue(value)) return { type: 'error', message: 'Agent host emitted a non-object event', raw: value }
  const raw = value as Record<string, unknown>
  if (isAgentEvent(raw) && [
    'thread_started', 'turn_started', 'turn_completed', 'turn_failed', 'session_incompatible', 'agent_message',
    'tool_started', 'tool_completed', 'command_started', 'command_completed', 'file_change_started',
    'file_change_completed', 'reasoning_started', 'todo_started', 'other',
  ].includes(raw.type)) return raw as AgentEvent

  if (raw.type === 'thread.started') return eventWithRaw({ type: 'thread_started', threadId: stringValue(raw.thread_id) }, raw)
  if (raw.type === 'turn.started') return eventWithRaw({ type: 'turn_started' }, raw)
  if (raw.type === 'turn.completed') return eventWithRaw({ type: 'turn_completed', usage: usageFrom(raw.usage) }, raw)
  if (raw.type === 'turn.failed') {
    const error = recordValue(raw.error)
    const message = stringValue(error?.message) ?? stringValue(raw.message) ?? 'agent turn failed'
    return isAgentSessionIncompatibleMessage(message)
      ? eventWithRaw({ type: 'session_incompatible', message }, raw)
      : eventWithRaw({ type: 'turn_failed', message }, raw)
  }
  if (raw.type === 'error' || raw.type === 'extension_error') {
    const message = stringValue(raw.message) ?? stringValue(raw.error) ?? 'agent host error'
    return normalizedFailureEvent(message, raw)
  }
  if (raw.type === 'notice') {
    return eventWithRaw({ type: 'other', message: stringValue(raw.message) }, raw)
  }
  if (raw.type === 'item.started' || raw.type === 'item.completed') {
    const item = recordValue(raw.item)
    return item ? normalizeItemEvent(raw, item) : eventWithRaw({ type: 'other' }, raw)
  }
  if (raw.type === 'agent_start') return eventWithRaw({ type: 'turn_started' }, raw)
  if (raw.type === 'agent_end') {
    return raw.isTerminal === false
      ? eventWithRaw({ type: 'other', message: 'Agent host scheduled continuation work' }, raw)
      : eventWithRaw({ type: 'turn_completed', usage: usageFrom(raw.usage) }, raw)
  }
  // OMP turn_start/turn_end describe inner model/tool-loop turns. A single
  // Auto-Test prompt may contain several of them and completes only at the
  // terminal agent_end event.
  if (raw.type === 'turn_start' || raw.type === 'turn_end') return eventWithRaw({ type: 'other' }, raw)
  // OMP message_update frames are streaming partials. Only message_end is a
  // complete assistant response that the core may use as a final delivery.
  if (raw.type === 'message_end') return normalizeOmpMessage(raw) ?? eventWithRaw({ type: 'other' }, raw)
  if (raw.type === 'message_update' || raw.type === 'message_start') return eventWithRaw({ type: 'other' }, raw)
  if (raw.type === 'tool_execution_update') return eventWithRaw({ type: 'other' }, raw)
  if (raw.type === 'tool_execution_start' || raw.type === 'tool_execution_end') {
    const details = recordValue(raw)
    const type = raw.type === 'tool_execution_start' ? 'tool_started' : 'tool_completed'
    const xdev = ompXdInvocation(raw)
    const toolName = stringValue(details?.toolName) ?? 'agent_tool'
    const identity = xdev ?? parseOmpMcpIdentity(toolName, recordValue(recordValue(details?.result)?.details))
    return eventWithRaw({
      type,
      id: stringValue(details?.toolCallId),
      callId: stringValue(details?.toolCallId),
      ...(identity?.server ? { server: identity.server } : {}),
      tool: identity?.tool ?? toolName,
      status: xdev?.failed || details?.isError === true ? 'failed' : 'completed',
      arguments: xdev?.arguments ?? details?.args,
      result: details?.result ?? details?.partialResult,
    }, raw)
  }
  if (raw.type === 'ready' || raw.type === 'response' || raw.type === 'prompt_result') return eventWithRaw({ type: 'other' }, raw)
  return eventWithRaw({ type: 'other' }, raw)
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
