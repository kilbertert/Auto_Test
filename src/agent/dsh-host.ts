import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import { createInterface } from 'node:readline'
import { mkdir, symlink } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import type {
  AgentEvent, AgentHost, AgentHostCapabilities, AgentHostLaunchOptions,
  AgentHostModelProviderAdapter, AgentHostProbeResult, AgentHostSession,
  AgentHostStream, AgentInputPart,
} from './host.js'
import { AgentHostError, resolveHostExecutable } from './host.js'
import { DshModelProviderAdapter } from './dsh-provider.js'

interface JsonRpcFrame { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: Record<string, unknown> }

class Queue<T> {
  private values: T[] = []
  private waiters: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (error: Error) => void }> = []
  private failure: Error | undefined
  private done = false
  push(value: T): void { if (this.done) return; const waiter = this.waiters.shift(); waiter ? waiter.resolve({ value, done: false }) : this.values.push(value) }
  end(error?: Error): void {
    if (this.done) return
    this.done = true
    this.failure = error
    for (const waiter of this.waiters.splice(0)) error ? waiter.reject(error) : waiter.resolve({ value: undefined, done: true })
  }
  async *iterate(): AsyncGenerator<T> {
    while (this.values.length || !this.done) {
      if (this.values.length) yield this.values.shift()!
      else {
        const next = await new Promise<IteratorResult<T>>((resolvePromise, rejectPromise) => {
          if (this.failure) rejectPromise(this.failure)
          else this.waiters.push({ resolve: resolvePromise, reject: rejectPromise })
        })
        if (next.done) return
        yield next.value
      }
    }
    if (this.failure) throw this.failure
  }
}

function contentParts(input: AgentInputPart[]): Array<Record<string, unknown>> {
  return input.map(part => part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'text', text: `A local image is available at ${part.path}. Inspect it from the run workspace.` })
}

function eventFromSession(event: Record<string, unknown>, toolNames = new Map<string, string>()): AgentEvent | undefined {
  const type = event.type
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
  if (type === 'assistant/message') {
    const message = data.message && typeof data.message === 'object' ? data.message as Record<string, unknown> : {}
    const content = Array.isArray(message.content) ? message.content : []
    const text = content.map(block => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text' ? (block as Record<string, unknown>).text : '').filter(value => typeof value === 'string').join('')
    return { type: 'agent_message', ...(text ? { text } : {}), raw: event }
  }
  if (type === 'tool/call') {
    const name = typeof data.name === 'string' ? data.name : 'agent_tool'
    const match = /^mcp__([^_]+(?:[_-][^_]+)*)__(.+)$/.exec(name)
    if (typeof data.callId === 'string') toolNames.set(data.callId, name)
    return { type: 'tool_started', callId: typeof data.callId === 'string' ? data.callId : undefined, ...(match ? { server: match[1], tool: match[2] } : { tool: name }), arguments: data.arguments, raw: event }
  }
  if (type === 'tool/result') {
    const message = data.message && typeof data.message === 'object' ? data.message as Record<string, unknown> : {}
    const source = typeof message.source === 'object' && message.source ? message.source as Record<string, unknown> : {}
    const callId = typeof data.callId === 'string' ? data.callId : typeof source.callId === 'string' ? source.callId : undefined
    const name = typeof data.name === 'string' ? data.name : typeof source.name === 'string' ? source.name : callId ? toolNames.get(callId) ?? 'agent_tool' : 'agent_tool'
    const match = /^mcp__([^_]+(?:[_-][^_]+)*)__(.+)$/.exec(name)
    return { type: 'tool_completed', callId, ...(match ? { server: match[1], tool: match[2] } : { tool: name }), status: message.isError === true ? 'failed' : 'completed', result: message.content, raw: event }
  }
  if (type === 'turn/start') return { type: 'turn_started', raw: event }
  if (type === 'turn/end') return { type: 'turn_completed', raw: event }
  return undefined
}

class DshSdkSession implements AgentHostSession {
  private readonly process: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  private readonly toolNames = new Map<string, string>()
  private readonly sessionId: string
  private serial = 0
  private active: Queue<AgentEvent> | undefined
  private closed = false
  private initialized: Promise<void>

  constructor(options: AgentHostLaunchOptions & { executable: string; configPath: string; resumeId?: string }, spawnProcess = crossSpawn as typeof spawn) {
    this.sessionId = options.resumeId ?? `auto-test-${randomUUID()}`
    const executableIsScript = ['.js', '.mjs', '.cjs'].includes(extname(options.executable).toLowerCase())
    const args = executableIsScript ? [options.executable, options.configPath] : [options.configPath]
    this.process = spawnProcess(executableIsScript ? process.execPath : options.executable, args, {
      cwd: options.workspaceDirectory,
      env: { ...options.runtime.environment, DSH_CWD: options.workspaceDirectory, DSH_HOME: options.runtime.agentHome },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    const lines = createInterface({ input: this.process.stdout })
    lines.on('line', line => this.handleLine(line))
    this.process.once('error', error => this.fail(error instanceof Error ? error : new Error(String(error))))
    this.process.once('exit', () => { if (!this.closed) this.fail(new AgentHostError('dsh', 'DSH SDK runtime exited unexpectedly', 'process')) })
    this.initialized = this.request('initialize', {
      cwd: options.workspaceDirectory,
      provider: options.runtime.provider?.providerId ?? 'deepseek',
      model: options.runtime.provider?.model ?? options.runtime.model ?? 'deepseek-v4-flash',
      ...(options.runtime.provider?.maxOutputTokens ? { maxTokens: options.runtime.provider.maxOutputTokens } : {}),
    }).then(() => undefined)
  }

  get id(): string | null { return this.sessionId }
  async initialize(): Promise<void> { await this.initialized }

  async run(input: AgentInputPart[]): Promise<AgentHostStream> {
    await this.initialized
    if (this.closed) throw new AgentHostError('dsh', 'DSH SDK session is closed', 'process')
    if (this.active) throw new AgentHostError('dsh', 'DSH SDK session already has an active prompt', 'process')
    const queue = new Queue<AgentEvent>()
    this.active = queue
    await this.request('session/prompt', { sessionId: this.sessionId, contentBlocks: contentParts(input) })
    return { events: queue.iterate() }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.active?.end(new AgentHostError('dsh', 'DSH SDK session closed', 'process'))
    await Promise.race([
      this.request('shutdown', {}).catch(() => undefined),
      new Promise<void>(resolvePromise => setTimeout(resolvePromise, 2_000)),
    ])
    this.process.stdin.end()
    if (this.process.exitCode !== null) return
    await Promise.race([
      new Promise<void>(resolvePromise => this.process.once('exit', () => resolvePromise())),
      new Promise<void>(resolvePromise => setTimeout(resolvePromise, 2_000)),
    ])
    if (this.process.exitCode === null) this.process.kill()
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let frame: JsonRpcFrame
    try { frame = JSON.parse(line) as JsonRpcFrame } catch { this.fail(new AgentHostError('dsh', 'DSH SDK emitted invalid JSON-RPC', 'protocol')); return }
    if (typeof frame.id === 'number') {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      if (frame.error) pending.reject(new AgentHostError('dsh', String(frame.error.message ?? 'DSH SDK request failed'), 'transport'))
      else pending.resolve(frame.result ?? {})
      return
    }
    if (frame.method === 'session.event') {
      const params = frame.params ?? {}
      if (params.sessionId !== this.sessionId || !this.active || !params.event || typeof params.event !== 'object') return
      const event = eventFromSession(params.event as Record<string, unknown>, this.toolNames)
      if (event) this.active.push(event)
      if ((params.event as Record<string, unknown>).type === 'turn/end') {
        const active = this.active
        this.active = undefined
        active?.end()
      }
      return
    }
    if (frame.method === 'session.status' && frame.params?.sessionId === this.sessionId && frame.params.status === 'idle' && this.active) {
      const active = this.active
      this.active = undefined
      active.end()
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.process.stdin.writable) return Promise.reject(new AgentHostError('dsh', 'DSH SDK stdin is unavailable', 'process'))
    const id = ++this.serial
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => { this.pending.delete(id); rejectPromise(new AgentHostError('dsh', `DSH SDK ${method} timed out`, 'transport')) }, 30_000)
      this.pending.set(id, { resolve: result => { clearTimeout(timer); resolvePromise(result) }, reject: error => { clearTimeout(timer); rejectPromise(error) } })
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  private fail(error: Error): void {
    this.active?.end(error)
    this.active = undefined
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

const capabilities: AgentHostCapabilities = {
  streaming: true, sessionResume: true, structuredOutput: false, localImages: true,
  mcp: true, shell: true, network: true, workspaceIsolation: 'prompt_only', restrictedMode: false,
}

export class DshAgentHost implements AgentHost {
  readonly id = 'dsh' as const
  readonly displayName = 'DeepSeek Harness SDK JSON-RPC'
  readonly capabilities = capabilities
  readonly modelProvider: AgentHostModelProviderAdapter = new DshModelProviderAdapter()
  constructor(private readonly options: { spawnProcess?: typeof spawn } = {}) {}

  private async executable(options: AgentHostLaunchOptions): Promise<string> {
    const value = options.executable || options.runtime.environment.AUTO_TEST_AGENT_BIN || 'dsh-jsonrpc-agent'
    const found = await resolveHostExecutable(value, options.runtime.environment)
    if (!found) throw new AgentHostError('dsh', `DSH SDK JSON-RPC executable is unavailable: ${value}`, 'configuration')
    return found
  }

  async probe(options: AgentHostLaunchOptions): Promise<AgentHostProbeResult> {
    try { return { ok: true, hostId: this.id, executable: await this.executable(options) } }
    catch (error) { return { ok: false, hostId: this.id, reason: error instanceof Error ? error.message : String(error) } }
  }

  private async launch(options: AgentHostLaunchOptions & { resumeId?: string }): Promise<AgentHostSession> {
    if (!options.fullAgentAccess) throw new AgentHostError('dsh', 'DSH SDK route currently requires direct mode', 'capability')
    await mkdir(resolve(options.runtime.agentHome, 'sessions'), { recursive: true, mode: 0o700 })
    const executable = await this.executable(options)
    const executableNodeModules = resolve(dirname(executable), '../../../..', 'node_modules', '.pnpm', 'node_modules')
    try { await symlink(executableNodeModules, resolve(options.runtime.agentHome, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new AgentHostError('dsh', `DSH runtime dependency link failed: ${String(error)}`, 'configuration')
    }
    const configPath = resolve(options.runtime.agentHome, 'cordis.yml')
    const session = new DshSdkSession({ ...options, executable, configPath }, this.options.spawnProcess)
    await session.initialize()
    return session
  }

  async start(options: AgentHostLaunchOptions): Promise<AgentHostSession> { return this.launch(options) }
  async resume(options: AgentHostLaunchOptions & { resumeId: string }): Promise<AgentHostSession> { return this.launch(options) }
}
