import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import { createInterface } from 'node:readline'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  AgentEvent, AgentHost, AgentHostCapabilities, AgentHostLaunchOptions,
  AgentHostModelProviderAdapter, AgentHostProbeResult, AgentHostSession,
  AgentHostStream, AgentInputPart,
} from './host.js'
import { AgentHostError, normalizeAgentEvent, resolveHostExecutable } from './host.js'
import { DshModelProviderAdapter } from './dsh-provider.js'

/** Experimental JSONL contract for the DSH route-B bridge. */
export interface DshBridgeFrame { type: string; id?: string; [key: string]: unknown }

class Queue<T> {
  private values: T[] = []
  private waiters: Array<(value: IteratorResult<T>) => void> = []
  private done = false
  push(value: T): void { if (this.done) return; const waiter = this.waiters.shift(); waiter ? waiter({ value, done: false }) : this.values.push(value) }
  end(): void { if (this.done) return; this.done = true; for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true }) }
  async *iterate(): AsyncGenerator<T> { while (this.values.length || !this.done) { if (this.values.length) yield this.values.shift()!; else { const next = await new Promise<IteratorResult<T>>(resolvePromise => this.waiters.push(resolvePromise)); if (next.done) return; yield next.value } } }
}

function inputPayload(parts: AgentInputPart[]): Record<string, unknown> {
  return {
    type: 'input',
    parts: parts.map(part => part.type === 'text'
      ? part
      : { type: 'local_image', path: part.path }),
  }
}

class DshSession implements AgentHostSession {
  private readonly process: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, (frame: DshBridgeFrame) => void>()
  private active: Queue<AgentEvent> | undefined
  private closed = false
  private sessionId: string | null = null
  private readonly initialized: Promise<void>

  constructor(options: AgentHostLaunchOptions & { executable: string; resumeId?: string }, spawnProcess = crossSpawn as typeof spawn) {
    const args = ['--profile', 'auto-test-host', '--rpc', ...(options.resumeId ? ['--resume', options.resumeId] : [])]
    this.process = spawnProcess(options.executable, args, {
      cwd: options.workspaceDirectory,
      env: { ...options.runtime.environment, DSH_HOME: options.runtime.agentHome },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    const lines = createInterface({ input: this.process.stdout })
    lines.on('line', line => this.handleLine(line))
    this.process.once('error', error => this.fail(error instanceof Error ? error : new Error(String(error))))
    this.process.once('exit', () => { if (!this.closed) this.fail(new AgentHostError('dsh', 'DSH bridge exited unexpectedly', 'process')) })
    this.initialized = this.send({ type: options.resumeId ? 'resume' : 'start', id: randomUUID(), runId: resolve(options.workspaceDirectory), resumeId: options.resumeId })
      .then(frame => {
        if (typeof frame.sessionId !== 'string' || !frame.sessionId) throw new AgentHostError('dsh', 'DSH bridge did not return a sessionId', 'protocol')
        this.sessionId = frame.sessionId
      })
  }

  get id(): string | null { return this.sessionId }

  async initialize(): Promise<void> { await this.initialized }

  async run(input: AgentInputPart[]): Promise<AgentHostStream> {
    if (this.closed) throw new AgentHostError('dsh', 'DSH session is already closed', 'process')
    const queue = new Queue<AgentEvent>()
    this.active = queue
    await this.send(inputPayload(input) as DshBridgeFrame)
    return { events: queue.iterate() }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.active?.end()
    this.process.stdin.end(JSON.stringify({ type: 'close' }) + '\n')
    if (this.process.exitCode === null) this.process.kill()
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let frame: DshBridgeFrame
    try { frame = JSON.parse(line) as DshBridgeFrame } catch { return this.fail(new AgentHostError('dsh', 'DSH bridge emitted invalid JSON', 'protocol')) }
    if (frame.type === 'response' && typeof frame.id === 'string') { this.pending.get(frame.id)?.(frame); this.pending.delete(frame.id); return }
    if (frame.type === 'session_started' && typeof frame.sessionId === 'string') this.sessionId = frame.sessionId
    if (frame.type === 'turn_completed' || frame.type === 'turn_failed') { this.active?.push(normalizeAgentEvent(frame)); this.active?.end(); this.active = undefined; return }
    if (this.active) this.active.push(normalizeAgentEvent(frame))
  }

  private send(frame: DshBridgeFrame): Promise<DshBridgeFrame> {
    if (this.closed || !this.process.stdin.writable) return Promise.reject(new AgentHostError('dsh', 'DSH bridge stdin is unavailable', 'process'))
    const id = frame.id ?? randomUUID()
    const payload = JSON.stringify({ ...frame, id })
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => { this.pending.delete(id); rejectPromise(new AgentHostError('dsh', `DSH bridge ${frame.type} timed out`, 'transport')) }, 30_000)
      this.pending.set(id, response => { clearTimeout(timer); if (response.error) rejectPromise(new AgentHostError('dsh', String(response.error), 'transport')); else resolvePromise(response) })
      this.process.stdin.write(payload + '\n', error => { if (error) { clearTimeout(timer); this.pending.delete(id); rejectPromise(error) } })
    })
  }

  private fail(error: Error): void { this.active?.end(); this.active = undefined; for (const resolvePromise of this.pending.values()) resolvePromise({ type: 'response', error: error.message }); this.pending.clear() }
}

const capabilities: AgentHostCapabilities = {
  streaming: true, sessionResume: true, structuredOutput: false, localImages: true,
  mcp: true, shell: true, network: true, workspaceIsolation: 'prompt_only', restrictedMode: false,
}

export class DshAgentHost implements AgentHost {
  readonly id = 'dsh' as const
  readonly displayName = 'DeepSeek Harness RPC (experimental)'
  readonly capabilities = capabilities
  readonly modelProvider: AgentHostModelProviderAdapter = new DshModelProviderAdapter()

  constructor(private readonly options: { spawnProcess?: typeof spawn } = {}) {}

  private async executable(options: AgentHostLaunchOptions): Promise<string> {
    const value = options.executable || options.runtime.environment.AUTO_TEST_AGENT_BIN || 'dsh'
    const resolved = await resolveHostExecutable(value, options.runtime.environment)
    if (!resolved) throw new AgentHostError('dsh', `DSH executable is unavailable: ${value}`, 'configuration')
    return resolved
  }

  async probe(options: AgentHostLaunchOptions): Promise<AgentHostProbeResult> {
    try { return { ok: true, hostId: this.id, executable: await this.executable(options) } }
    catch (error) { return { ok: false, hostId: this.id, reason: error instanceof Error ? error.message : String(error) } }
  }

  async start(options: AgentHostLaunchOptions): Promise<AgentHostSession> {
    if (!options.fullAgentAccess) throw new AgentHostError('dsh', 'DSH route B currently requires direct mode', 'capability')
    await mkdir(resolve(options.runtime.agentHome, 'sessions'), { recursive: true, mode: 0o700 })
    const session = new DshSession({ ...options, executable: await this.executable(options) }, this.options.spawnProcess)
    await session.initialize()
    return session
  }

  async resume(options: AgentHostLaunchOptions & { resumeId: string }): Promise<AgentHostSession> {
    if (!options.fullAgentAccess) throw new AgentHostError('dsh', 'DSH route B currently requires direct mode', 'capability')
    await mkdir(resolve(options.runtime.agentHome, 'sessions'), { recursive: true, mode: 0o700 })
    const session = new DshSession({ ...options, executable: await this.executable(options) }, this.options.spawnProcess)
    await session.initialize()
    return session
  }
}
