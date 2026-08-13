import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import { mkdir, readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { extname, resolve } from 'node:path'
import type {
  AgentEvent,
  AgentHost,
  AgentHostCapabilities,
  AgentHostModelProviderAdapter,
  AgentHostLaunchOptions,
  AgentHostProbeResult,
  AgentHostSession,
  AgentHostStream,
  AgentInputPart,
  AgentUsage,
} from './host.js'
import { AgentHostError, normalizeAgentEvent, resolveHostExecutable, usageFrom } from './host.js'
import { OmpModelProviderAdapter } from './omp-provider.js'

interface OmpResponse {
  id?: string
  type: 'response'
  command?: string
  success?: boolean
  data?: unknown
  error?: string
  code?: string
}

interface OmpReadyFrame {
  type: 'ready'
  protocolVersion?: number
  supportedProtocolVersions?: number[]
  maxFrameBytes?: number
  maxReassembledFrameBytes?: number
}

interface OmpChunkFrame {
  type: 'rpc_chunk'
  chunkId: string
  index: number
  count: number
  byteLength: number
  data: string
}

type OmpFrame = Record<string, unknown>

const PASSIVE_EXTENSION_UI_METHODS = new Set([
  'cancel',
  'notify',
  'setStatus',
  'setWidget',
  'setTitle',
  'set_editor_text',
])

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024
const DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024
const DEFAULT_CHUNK_BYTES = 256 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

class AsyncEventQueue<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: Error) => void }> = []
  private ended = false
  private terminalError: Error | undefined

  push(value: T): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve({ value, done: false })
    else this.values.push(value)
  }

  end(error?: Error): void {
    if (this.ended) return
    this.ended = true
    this.terminalError = error
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      if (error) waiter.reject(error)
      else waiter.resolve({ value: undefined, done: true })
    }
  }

  async *iterate(): AsyncGenerator<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift()!
        continue
      }
      if (this.ended) {
        if (this.terminalError) throw this.terminalError
        return
      }
      const next = await new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }))
      if (next.done) return
      yield next.value
    }
  }
}

export class RpcFrameDecoder {
  private pending: {
    chunkId: string
    count: number
    byteLength: number
    nextIndex: number
    chunks: Buffer[]
    receivedBytes: number
  } | undefined

  constructor(
    private maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    private maxReassembledBytes = DEFAULT_MAX_REASSEMBLED_BYTES,
  ) {}

  setLimits(maxFrameBytes: number, maxReassembledBytes: number): void {
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1024 || maxFrameBytes > DEFAULT_MAX_REASSEMBLED_BYTES) return
    if (!Number.isInteger(maxReassembledBytes) || maxReassembledBytes < maxFrameBytes || maxReassembledBytes > DEFAULT_MAX_REASSEMBLED_BYTES) return
    this.maxFrameBytes = maxFrameBytes
    this.maxReassembledBytes = maxReassembledBytes
  }

  push(frame: OmpFrame): OmpFrame | undefined {
    if (frame.type !== 'rpc_chunk') {
      if (this.pending) throw new Error('OMP RPC chunk sequence was interrupted')
      return frame
    }
    const chunk = frame as unknown as Partial<OmpChunkFrame>
    if (
      typeof chunk.chunkId !== 'string' || chunk.chunkId.length === 0 || chunk.chunkId.length > 128 ||
      !Number.isSafeInteger(chunk.index) || !Number.isSafeInteger(chunk.count) || !Number.isSafeInteger(chunk.byteLength) ||
      (chunk.index as number) < 0 || (chunk.count as number) < 2 || (chunk.index as number) >= (chunk.count as number) ||
      (chunk.count as number) > Math.ceil(this.maxReassembledBytes / DEFAULT_CHUNK_BYTES) ||
      (chunk.byteLength as number) < this.maxFrameBytes || (chunk.byteLength as number) > this.maxReassembledBytes ||
      typeof chunk.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data) || chunk.data.length === 0
    ) throw new Error('Invalid OMP RPC chunk metadata')
    const chunkId = chunk.chunkId
    const index = chunk.index as number
    const count = chunk.count as number
    const byteLength = chunk.byteLength as number
    const data = chunk.data
    const decoded = Buffer.from(data, 'base64')
    if (decoded.length > DEFAULT_CHUNK_BYTES || decoded.toString('base64') !== data) throw new Error('Invalid OMP RPC chunk data')
    if (!this.pending) {
      if (index !== 0) throw new Error('OMP RPC chunk sequence must start at index 0')
      this.pending = {
        chunkId,
        count,
        byteLength,
        nextIndex: 0,
        chunks: [],
        receivedBytes: 0,
      }
    }
    const pending = this.pending
    if (!pending) throw new Error('OMP RPC chunk sequence was not initialized')
    if (pending.chunkId !== chunkId || pending.count !== count || pending.byteLength !== byteLength || pending.nextIndex !== index) {
      throw new Error('OMP RPC chunk sequence mismatch')
    }
    pending.chunks.push(decoded)
    pending.receivedBytes += decoded.length
    pending.nextIndex += 1
    if (pending.receivedBytes > pending.byteLength) throw new Error('OMP RPC chunk sequence exceeds declared length')
    if (pending.nextIndex < pending.count) return undefined
    if (pending.receivedBytes !== pending.byteLength) throw new Error('OMP RPC chunk sequence length mismatch')
    this.pending = undefined
    let decodedText: string
    try {
      decodedText = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pending.chunks))
    } catch {
      throw new Error('OMP RPC reassembled frame is not valid UTF-8')
    }
    const parsed = JSON.parse(decodedText) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('OMP RPC reassembled frame is not an object')
    return parsed as OmpFrame
  }
}

interface PendingRequest {
  command: string
  resolve: (value: OmpResponse) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

interface ActiveRun {
  queue: AsyncEventQueue<AgentEvent>
  promptId: string
  lastAssistantText?: string
  /** Accumulated per-turn token usage; attached to the terminal turn_completed. */
  usage: AgentUsage
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return 'image/png'
  }
}

function assistantTextFromAgentEnd(frame: OmpFrame): string | undefined {
  if (!Array.isArray(frame.messages)) return undefined
  for (const message of [...frame.messages].reverse()) {
    const value = message && typeof message === 'object' && !Array.isArray(message) ? message as Record<string, unknown> : undefined
    if (value?.role !== 'assistant') continue
    if (typeof value.content === 'string') return value.content
    if (Array.isArray(value.content)) {
      const text = value.content.map((part) => {
        const item = part && typeof part === 'object' && !Array.isArray(part) ? part as Record<string, unknown> : undefined
        return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
      }).join('')
      if (text) return text
    }
  }
  return undefined
}

async function promptPayload(input: AgentInputPart[], promptId: string, maxFrameBytes: number): Promise<Record<string, unknown>> {
  const textParts = input.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
  let message = textParts.map((part) => part.text).join('\n\n')
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = []
  for (const part of input) {
    if (part.type !== 'local_image') continue
    const image = { type: 'image' as const, data: (await readFile(part.path)).toString('base64'), mimeType: mimeType(part.path) }
    const candidate = JSON.stringify({ type: 'prompt', id: promptId, message, images: [...images, image] })
    if (Buffer.byteLength(candidate, 'utf8') + 1 <= maxFrameBytes) {
      images.push(image)
      continue
    }
    // RPC commands are intentionally unchunked. Keep the input contract
    // intact by telling OMP where the staged image lives when inline media
    // would exceed the advertised physical frame limit.
    message += `\n\nA staged local image is available at ${part.path}. Inspect that file from the run workspace if visual evidence is needed.`
  }
  const payload: Record<string, unknown> = { type: 'prompt', id: promptId, message }
  if (images.length > 0) payload.images = images
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') + 1 > maxFrameBytes) {
    throw new AgentHostError('omp', 'OMP prompt exceeded the RPC input frame limit after image fallback', 'protocol')
  }
  return payload
}

/**
 * Launch arguments for the OMP RPC session. The `--config` overlay is what
 * makes OMP load the run-scoped MCP servers (`.omp/mcp.json`) and disable its
 * built-in browser in favor of the injected Playwright MCP; omitting it leaves
 * the session with only built-in tools and the Control MCP preflight fails.
 */
export function ompSessionLaunchArgs(options: {
  workspaceDirectory: string
  sessionDirectory: string
  model?: string
  reasoningEffort?: string
  serviceTier?: string
  resumeId?: string
}): string[] {
  return [
    '--mode', 'rpc',
    '--no-title',
    '--approval-mode', 'yolo',
    '--session-dir', options.sessionDirectory,
    '--config', resolve(options.workspaceDirectory, '.omp', 'config.yml'),
    ...(options.model ? ['--model', options.model] : []),
    ...(options.reasoningEffort ? ['--thinking', options.reasoningEffort] : []),
    ...(options.serviceTier ? ['--service-tier', options.serviceTier] : []),
    ...(options.resumeId ? ['--resume', options.resumeId] : []),
  ]
}

class OmpRpcSession implements AgentHostSession {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly decoder = new RpcFrameDecoder()
  private readonly process: ChildProcessWithoutNullStreams
  private readonly ready: Promise<void>
  private readonly readyResolve: () => void
  private readonly readyReject: (error: Error) => void
  private activeRun: ActiveRun | undefined
  private closed = false
  private closing = false
  private failedError: Error | undefined
  private stderrTail = ''
  private sessionIdentifier: string | null = null
  private maxFrameBytes = DEFAULT_MAX_FRAME_BYTES
  private maxReassembledFrameBytes = DEFAULT_MAX_REASSEMBLED_BYTES
  private readonly exited: Promise<void>
  private readonly resolveExited: () => void

  constructor(
    options: AgentHostLaunchOptions & { executable: string; resumeId?: string },
    spawnProcess: typeof spawn = crossSpawn as typeof spawn,
  ) {
    const sessionDirectory = resolve(options.runtime.agentHome, 'sessions')
    const args = ompSessionLaunchArgs({
      workspaceDirectory: options.workspaceDirectory,
      sessionDirectory,
      ...(options.runtime.model !== undefined ? { model: options.runtime.model } : {}),
      ...(options.runtime.provider?.reasoningEffort !== undefined ? { reasoningEffort: options.runtime.provider.reasoningEffort } : {}),
      ...(options.runtime.provider?.serviceTier !== undefined ? { serviceTier: options.runtime.provider.serviceTier } : {}),
      ...(options.resumeId !== undefined ? { resumeId: options.resumeId } : {}),
    })
    const env: NodeJS.ProcessEnv = {
      ...options.runtime.environment,
      PI_CODING_AGENT_DIR: options.runtime.agentHome,
      PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
    }
    this.process = spawnProcess(options.executable, args, {
      cwd: options.workspaceDirectory,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    this.ready = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveReady = resolvePromise
      rejectReady = rejectPromise
    })
    this.readyResolve = resolveReady
    this.readyReject = rejectReady
    const startupTimeout = setTimeout(() => this.fail(new AgentHostError('omp', 'OMP RPC startup timed out', 'transport')), DEFAULT_REQUEST_TIMEOUT_MS)
    void this.ready.then(
      () => clearTimeout(startupTimeout),
      () => clearTimeout(startupTimeout),
    )
    let resolveExited!: () => void
    this.exited = new Promise<void>((resolvePromise) => { resolveExited = resolvePromise })
    this.resolveExited = resolveExited
    const lines = createInterface({ input: this.process.stdout })
    lines.on('line', (line) => this.handleLine(line))
    this.process.stderr.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-4000)
    })
    this.process.once('error', (error) => this.fail(error instanceof Error ? error : new Error(String(error))))
    this.process.once('exit', (code, signal) => {
      this.resolveExited()
      if (this.closing) {
        this.failPending(new Error('OMP process closed'))
        return
      }
      const suffix = this.stderrTail.trim() ? `: ${this.stderrTail.trim().slice(-1000)}` : ''
      this.fail(new Error(`OMP process exited (${signal ?? code ?? 'unknown'})${suffix}`))
    })
  }

  get id(): string | null {
    return this.sessionIdentifier
  }

  async initialize(): Promise<void> {
    await this.ready
    const state = await this.request({ type: 'get_state' })
    const data = state.data && typeof state.data === 'object' ? state.data as Record<string, unknown> : {}
    if (typeof data.sessionFile === 'string') this.sessionIdentifier = data.sessionFile
    else if (typeof data.sessionId === 'string') this.sessionIdentifier = data.sessionId
    else this.sessionIdentifier = null
  }

  async run(input: AgentInputPart[]): Promise<AgentHostStream> {
    if (this.closed) throw new AgentHostError('omp', 'OMP session is already closed', 'process')
    await this.ready
    if (this.closed) throw new AgentHostError('omp', 'OMP session is already closed', 'process')
    if (this.activeRun) throw new AgentHostError('omp', 'OMP session already has an active prompt', 'process')
    const queue = new AsyncEventQueue<AgentEvent>()
    const promptId = `autotest-${randomUUID()}`
    this.activeRun = { queue, promptId, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } }
    try {
      const prompt = await promptPayload(input, promptId, this.maxFrameBytes)
      const response = await this.request(prompt)
      const invoked = response.data && typeof response.data === 'object' &&
        (response.data as Record<string, unknown>).agentInvoked
      if (invoked === false && this.activeRun?.promptId === promptId) {
        const active = this.activeRun
        this.activeRun = undefined
        active.queue.end()
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      queue.end(normalized)
      this.activeRun = undefined
      throw normalized
    }
    return { events: queue.iterate() }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closing = true
    this.closed = true
    this.failPending(new AgentHostError('omp', 'OMP session closed', 'process'))
    if (this.activeRun) {
      const active = this.activeRun
      this.activeRun = undefined
      active.queue.end(new AgentHostError('omp', 'OMP session closed before the prompt completed', 'process'))
    }
    if (this.process.stdin.writable) this.process.stdin.end()
    if (this.process.exitCode === null) {
      await Promise.race([this.exited, delay(DEFAULT_CLOSE_TIMEOUT_MS)])
      if (this.process.exitCode === null) this.process.kill()
      await Promise.race([this.exited, delay(500)])
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      this.fail(new Error(`OMP RPC emitted invalid JSON: ${String(error)}`))
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.fail(new Error('OMP RPC frame must be an object'))
      return
    }
    let frame: OmpFrame | undefined
    try {
      frame = this.decoder.push(parsed as OmpFrame)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (!frame) return
    if (frame.type === 'ready') {
      const ready = frame as unknown as OmpReadyFrame
      if (typeof ready.maxFrameBytes === 'number' && Number.isInteger(ready.maxFrameBytes) && ready.maxFrameBytes >= 1024 && ready.maxFrameBytes <= DEFAULT_MAX_REASSEMBLED_BYTES) {
        this.maxFrameBytes = ready.maxFrameBytes
      }
      if (typeof ready.maxReassembledFrameBytes === 'number' && Number.isInteger(ready.maxReassembledFrameBytes) && ready.maxReassembledFrameBytes >= this.maxFrameBytes && ready.maxReassembledFrameBytes <= DEFAULT_MAX_REASSEMBLED_BYTES) {
        this.maxReassembledFrameBytes = ready.maxReassembledFrameBytes
      }
      this.decoder.setLimits(this.maxFrameBytes, this.maxReassembledFrameBytes)
      if (ready.supportedProtocolVersions?.includes(2)) {
        void this.request({ type: 'negotiate_protocol', protocolVersion: 2 })
          .then((response) => {
            const data = response.data && typeof response.data === 'object' ? response.data as Record<string, unknown> : undefined
            if (data?.protocolVersion !== 2) throw new AgentHostError('omp', 'OMP RPC protocol v2 negotiation returned an invalid version', 'protocol')
            this.readyResolve()
          })
          .catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))))
      } else {
        this.readyResolve()
      }
      return
    }
    if (frame.type === 'response') {
      const response = frame as unknown as OmpResponse
      const id = typeof response.id === 'string' ? response.id : undefined
      const pending = id ? this.pending.get(id) : undefined
      if (pending && id) {
        this.pending.delete(id)
        clearTimeout(pending.timeout)
        if (response.success === false) {
          pending.reject(new AgentHostError('omp', response.error ?? `OMP RPC ${pending.command} failed`, 'transport'))
        } else {
          pending.resolve(response)
        }
      } else if (response.success === false) {
        const error = new AgentHostError('omp', response.error ?? 'OMP RPC command failed', 'transport')
        if (id && this.activeRun?.promptId === id) {
          const active = this.activeRun
          this.activeRun = undefined
          active.queue.end(error)
        } else {
          this.fail(error)
        }
      }
      return
    }
    if (frame.type === 'prompt_result') {
      if (frame.agentInvoked === false && (!frame.id || frame.id === this.activeRun?.promptId) && this.activeRun) {
        const active = this.activeRun
        this.activeRun = undefined
        active.queue.end()
      }
      return
    }
    if (frame.type === 'extension_ui_request') {
      if (typeof frame.method === 'string' && PASSIVE_EXTENSION_UI_METHODS.has(frame.method)) return
      this.fail(new AgentHostError('omp', 'OMP requested interactive RPC UI input in headless Auto-Test mode', 'capability'))
      return
    }
    if (frame.type === 'host_tool_call' || frame.type === 'host_uri_request') {
      this.fail(new AgentHostError('omp', `OMP requested an unsupported host integration frame: ${frame.type}`, 'capability'))
      return
    }
    // OMP deltas contain the complete accumulated message/result. The final
    // message and tool events carry the same usable facts without O(n^2) logs.
    if (frame.type === 'message_start' || frame.type === 'message_update' || frame.type === 'tool_execution_update') return
    const active = this.activeRun
    if (!active) return
    // OMP reports per-turn token usage nested in turn_end.message.usage; the
    // terminal agent_end carries none. Accumulate here so the emitted
    // turn_completed carries the run's total usage for the live lastUsage
    // snapshot (the events-file reader sums turn_end frames independently).
    if (frame.type === 'turn_end') {
      const message = frame.message
      const usageRecord = message && typeof message === 'object' && !Array.isArray(message)
        ? (message as Record<string, unknown>).usage
        : undefined
      const turnUsage = usageFrom(usageRecord)
      if (turnUsage) {
        active.usage.inputTokens += turnUsage.inputTokens
        active.usage.cachedInputTokens += turnUsage.cachedInputTokens
        active.usage.outputTokens += turnUsage.outputTokens
      }
    }
    const event = normalizeAgentEvent(frame)
    if (event.type === 'agent_message' && event.text) active.lastAssistantText = event.text
    // OMP normally emits the complete assistant message as message_end and
    // repeats it in terminal agent_end.messages. Forward the latter only as a
    // compatibility fallback for older/compacted servers, otherwise the Core
    // would see duplicate final responses and duplicate progress receipts.
    if (frame.type === 'agent_end' && frame.isTerminal !== false && !active.lastAssistantText) {
      const finalText = assistantTextFromAgentEnd(frame)
      if (finalText) {
        active.lastAssistantText = finalText
        active.queue.push({ type: 'agent_message', text: finalText, raw: frame })
      }
    }
    if (event.type === 'turn_completed') event.usage = active.usage
    active.queue.push(event)
    if (frame.type === 'agent_end' && frame.isTerminal !== false) {
      this.activeRun = undefined
      active.queue.end()
    }
  }

  private request(command: Record<string, unknown>): Promise<OmpResponse> {
    if (this.failedError) return Promise.reject(this.failedError)
    if (this.closed || !this.process.stdin.writable) return Promise.reject(new AgentHostError('omp', 'OMP RPC stdin is unavailable', 'process'))
    const id = typeof command.id === 'string' ? command.id : `request-${randomUUID()}`
    const payload = JSON.stringify({ ...command, id })
    if (Buffer.byteLength(payload, 'utf8') + 1 > this.maxFrameBytes) {
      return Promise.reject(new AgentHostError('omp', `OMP RPC ${String(command.type ?? 'command')} exceeds the advertised input frame limit`, 'protocol'))
    }
    return new Promise<OmpResponse>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        rejectPromise(new AgentHostError('omp', `OMP RPC ${String(command.type ?? 'command')} timed out`, 'transport'))
      }, DEFAULT_REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        command: typeof command.type === 'string' ? command.type : 'unknown',
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout,
      })
      this.process.stdin.write(`${payload}\n`, (error) => {
        if (!error) return
        const pending = this.pending.get(id)
        if (pending) clearTimeout(pending.timeout)
        this.pending.delete(id)
        rejectPromise(error)
      })
    })
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
  }

  private fail(error: Error): void {
    if (this.failedError || this.closing) return
    this.failedError = error
    this.readyReject(error)
    this.failPending(error)
    if (this.activeRun) {
      const active = this.activeRun
      this.activeRun = undefined
      active.queue.end(error)
    }
  }
}

const capabilities: AgentHostCapabilities = {
  streaming: true,
  sessionResume: true,
  structuredOutput: false,
  localImages: true,
  mcp: true,
  shell: true,
  network: true,
  workspaceIsolation: 'prompt_only',
  restrictedMode: false,
}

export interface OmpAgentHostOptions {
  spawnProcess?: typeof spawn
}

async function resolveOmpExecutable(executable: string | undefined, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const configured = executable || environment.AUTO_TEST_AGENT_BIN || environment.AUTO_TEST_OMP_BIN || process.env.AUTO_TEST_AGENT_BIN || process.env.AUTO_TEST_OMP_BIN || 'omp'
  const resolved = await resolveHostExecutable(configured, environment)
  if (!resolved) throw new AgentHostError('omp', `OMP executable is unavailable: ${configured}`, 'configuration')
  return resolved
}

export class OmpAgentHost implements AgentHost {
  readonly id = 'omp' as const
  readonly displayName = 'oh-my-pi RPC'
  readonly capabilities = capabilities
  readonly modelProvider: AgentHostModelProviderAdapter = new OmpModelProviderAdapter()

  constructor(private readonly options: OmpAgentHostOptions = {}) {}

  async probe(options: AgentHostLaunchOptions): Promise<AgentHostProbeResult> {
    try {
      if (!options.fullAgentAccess) {
        throw new AgentHostError('omp', 'OMP currently supports Auto-Test direct mode only; opaque/restricted mode cannot be enforced by this adapter', 'capability')
      }
      const executable = await resolveOmpExecutable(options.executable, options.runtime.environment)
      return { ok: true, hostId: this.id, executable }
    } catch (error) {
      return { ok: false, hostId: this.id, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async start(options: AgentHostLaunchOptions): Promise<AgentHostSession> {
    if (!options.fullAgentAccess) throw new AgentHostError('omp', 'OMP currently supports Auto-Test direct mode only', 'capability')
    await mkdir(resolve(options.runtime.agentHome, 'sessions'), { recursive: true, mode: 0o700 })
    const executable = await resolveOmpExecutable(options.executable, options.runtime.environment)
    const session = new OmpRpcSession({ ...options, executable }, this.options.spawnProcess)
    try {
      await session.initialize()
      return session
    } catch (error) {
      await session.close()
      throw error
    }
  }

  async resume(options: AgentHostLaunchOptions & { resumeId: string }): Promise<AgentHostSession> {
    if (!options.fullAgentAccess) throw new AgentHostError('omp', 'OMP currently supports Auto-Test direct mode only', 'capability')
    await mkdir(resolve(options.runtime.agentHome, 'sessions'), { recursive: true, mode: 0o700 })
    const executable = await resolveOmpExecutable(options.executable, options.runtime.environment)
    const session = new OmpRpcSession({ ...options, executable, resumeId: options.resumeId }, this.options.spawnProcess)
    try {
      await session.initialize()
      return session
    } catch (error) {
      await session.close()
      throw error
    }
  }
}
