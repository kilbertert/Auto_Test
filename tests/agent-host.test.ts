import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHostError, normalizeAgentEvent } from '../src/agent/host.js'
import type { AgentHost } from '../src/agent/host.js'
import { OmpAgentHost, RpcFrameDecoder } from '../src/agent/omp-host.js'
import { availableAgentHosts, createAgentHost } from '../src/agent/host-registry.js'
import { progressFromAgentEvent } from '../src/agent/progress.js'
import { runAgentTest } from '../src/agent/runner.js'
import type { CodexTestAgentResult } from '../src/agent/types.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function fakeOmpProcess(
  directory: string,
  onPrompt: (send: (value: unknown) => void, promptIndex: number) => void,
): ChildProcessWithoutNullStreams {
  const fakeProcess = new class extends EventEmitter {
    readonly stdin = new PassThrough()
    readonly stdout = new PassThrough()
    readonly stderr = new PassThrough()
    exitCode: number | null = null
    killed = false
    private promptIndex = 0
    constructor() {
      super()
      const send = (value: unknown): void => { this.stdout.write(`${JSON.stringify(value)}\n`) }
      const lines = createInterface({ input: this.stdin })
      this.stdin.on('finish', () => {
        if (this.exitCode !== null) return
        this.exitCode = 0
        queueMicrotask(() => this.emit('exit', 0, null))
      })
      lines.on('line', (line) => {
        const command = JSON.parse(line) as { id: string; type: string }
        if (command.type === 'negotiate_protocol') {
          send({ type: 'response', id: command.id, command: command.type, success: true, data: { protocolVersion: 2 } })
          return
        }
        if (command.type === 'get_state') {
          send({ type: 'response', id: command.id, command: command.type, success: true, data: { sessionId: 'omp-fixture-session', sessionFile: resolve(directory, 'session.jsonl') } })
          return
        }
        if (command.type === 'prompt') {
          send({ type: 'response', id: command.id, command: command.type, success: true, data: { agentInvoked: true } })
          onPrompt(send, this.promptIndex++)
        }
      })
      queueMicrotask(() => send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }))
    }
    kill(): boolean {
      this.killed = true
      this.exitCode = 0
      queueMicrotask(() => this.emit('exit', 0, null))
      return true
    }
  }()
  return fakeProcess as unknown as ChildProcessWithoutNullStreams
}

function oneCaseManifest(): WorkflowIntakeManifest {
  return {
    version: '1.0', kind: 'workflow-intake', workflowId: 'agent-host-fixture',
    source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'a'.repeat(64) },
    targetUrls: ['https://agent.example.test/'], requiredCapabilities: [],
    phases: [{
      id: 'case-one', title: 'Agent host contract', sourceRow: 2, risk: 'read',
      steps: [{ id: 'step-one', sourceText: 'Observe the fixture', confidence: 1 }],
      resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] },
    }],
    embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
  }
}

describe('AgentHost contract', () => {
  it('reassembles bounded OMP protocol-v2 frames and rejects invalid UTF-8', () => {
    const decoder = new RpcFrameDecoder(1024, 2 * 1024 * 1024)
    const payload = JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'x'.repeat(300_000) } })
    const bytes = Buffer.from(payload, 'utf8')
    const chunkSize = 256 * 1024
    const count = Math.ceil(bytes.length / chunkSize)
    let decoded: Record<string, unknown> | undefined
    for (let index = 0; index < count; index++) {
      const data = bytes.subarray(index * chunkSize, (index + 1) * chunkSize).toString('base64')
      decoded = decoder.push({ type: 'rpc_chunk', chunkId: 'fixture', index, count, byteLength: bytes.length, data }) as Record<string, unknown> | undefined
    }
    expect(decoded).toEqual(JSON.parse(payload))

    const invalid = new RpcFrameDecoder(1024, 2 * 1024 * 1024)
    const first = Buffer.concat([Buffer.from([0xff]), Buffer.alloc(511, 0x20)])
    const second = Buffer.alloc(512, 0x20)
    expect(() => {
      invalid.push({ type: 'rpc_chunk', chunkId: 'invalid', index: 0, count: 2, byteLength: 1024, data: first.toString('base64') })
      invalid.push({ type: 'rpc_chunk', chunkId: 'invalid', index: 1, count: 2, byteLength: 1024, data: second.toString('base64') })
    }).toThrow(/UTF-8/)
  })

  it('normalizes Codex and OMP events without exposing vendor types to the core', () => {
    expect(normalizeAgentEvent({ type: 'thread.started', thread_id: 'codex-1' })).toMatchObject({
      type: 'thread_started',
      threadId: 'codex-1',
    })
    expect(normalizeAgentEvent({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'browser_click',
      result: { ok: true },
    })).toMatchObject({ type: 'tool_completed', tool: 'browser_click', callId: 'tool-1' })
    expect(normalizeAgentEvent({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    })).toMatchObject({ type: 'agent_message', text: 'done' })
    expect(normalizeAgentEvent({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
    })).toMatchObject({ type: 'other' })
  })

  it('registers Codex and OMP as competing hosts with explicit capabilities', () => {
    expect(availableAgentHosts().map((host) => host.id)).toEqual(['codex', 'omp'])
    expect(createAgentHost('codex').capabilities.structuredOutput).toBe(true)
    expect(createAgentHost('omp').capabilities.structuredOutput).toBe(false)
    expect(createAgentHost('omp').capabilities.mcp).toBe(true)
    expect(createAgentHost('codex').capabilities.workspaceIsolation).toBe('enforced')
    expect(createAgentHost('omp').capabilities.workspaceIsolation).toBe('prompt_only')
    expect(createAgentHost('omp').capabilities.restrictedMode).toBe(false)
  })

  it('fails closed when OMP is asked to impersonate the restricted opaque mode', async () => {
    const host = new OmpAgentHost()
    await expect(host.probe({
      workspaceDirectory: '/tmp/workspace', agentHome: '/tmp/home', executable: '/tmp/omp',
      playwrightConfigPath: '/tmp/playwright.json', playwrightSecretsPath: '/tmp/secrets.env', controlConfigPath: '/tmp/control.json',
      environment: {}, mcpEnvironment: {}, fullAgentAccess: false,
    })).resolves.toMatchObject({ ok: false, hostId: 'omp' })
  })

  it('classifies AgentHost transport failures as infrastructure blocks', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-host-failure-'))
    directories.push(directory)
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const host = {
      id: 'omp' as const,
      displayName: 'OMP fixture',
      capabilities: {
        streaming: true,
        sessionResume: true,
        structuredOutput: false,
        localImages: true,
        mcp: true,
        shell: true,
        network: true,
        workspaceIsolation: 'prompt_only' as const,
        restrictedMode: false,
      },
      async probe(): Promise<{ ok: true; hostId: 'omp'; executable: string }> {
        return { ok: true, hostId: 'omp', executable: '/fixture/omp' }
      },
      async start(): Promise<never> {
        throw new AgentHostError('omp', 'OMP RPC emitted invalid JSON')
      },
      async resume(): Promise<never> {
        throw new AgentHostError('omp', 'OMP RPC emitted invalid JSON')
      },
    } satisfies AgentHost
    const run = await runAgentTest({
      outputDirectory: resolve(directory, 'run'),
      manifest: oneCaseManifest(),
      profile: { id: 'fixture', origins: ['https://agent.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false,
      agentHost: host,
    }, { browserExecutablePath: browserPath })
    expect(run.state.status).toBe('completed')
    expect(run.result?.outcome).toBe('blocked')
    expect(run.result?.cases[0]).toMatchObject({ failureSource: 'infrastructure', failureKind: 'execution' })
    expect(run.result?.summary).toContain('AgentHost')
  })

  it('drives an OMP RPC session through the same streaming host contract', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-omp-host-'))
    directories.push(directory)
    const executable = process.platform === 'win32' ? process.execPath : '/bin/true'
    const agentHome = resolve(directory, 'agent-home')
    const workspaceDirectory = resolve(directory, 'workspace')
    await mkdir(agentHome, { recursive: true })
    await mkdir(workspaceDirectory, { recursive: true })
    const processFactory = (): ChildProcessWithoutNullStreams => fakeOmpProcess(directory, (send) => {
      send({ type: 'agent_start' })
      send({ type: 'tool_execution_start', toolCallId: 'click-1', toolName: 'browser_click', args: { label: 'fixture' } })
      send({ type: 'tool_execution_end', toolCallId: 'click-1', toolName: 'browser_click', result: { ok: true } })
      const assistant = { role: 'assistant', content: [{ type: 'text', text: 'fixture completed' }] }
      send({ type: 'message_end', message: assistant })
      send({ type: 'agent_end', messages: [assistant] })
    })
    const spawnProcess = processFactory as unknown as typeof spawn
    const host = new OmpAgentHost({ spawnProcess })
    const options = {
      workspaceDirectory,
      agentHome,
      executable,
      playwrightConfigPath: resolve(directory, 'playwright.json'),
      playwrightSecretsPath: resolve(directory, 'secrets.env'),
      controlConfigPath: resolve(directory, 'control.json'),
      ompMcpConfigPath: resolve(workspaceDirectory, '.omp', 'mcp.json'),
      environment: {},
      mcpEnvironment: {},
      fullAgentAccess: true,
    }
    await expect(host.probe(options)).resolves.toMatchObject({ ok: true, hostId: 'omp' })
    const session = await host.start(options)
    expect(session.id).toContain('session.jsonl')
    const stream = await session.run([
      { type: 'text', text: 'run the fixture' },
    ])
    const events = []
    for await (const event of stream.events) events.push(event)
    expect(events.map((event) => event.type)).toEqual([
      'turn_started',
      'tool_started',
      'tool_completed',
      'agent_message',
      'turn_completed',
    ])
    expect(events.find((event) => event.type === 'agent_message')?.text).toBe('fixture completed')
    expect(events.find((event) => event.type === 'tool_completed')?.tool).toBe('browser_click')
    expect(events.filter((event) => event.type === 'agent_message')).toHaveLength(1)
    await session.close?.()
  })

  it('maps OMP-prefixed MCP tool names to the same safe progress categories', () => {
    expect(progressFromAgentEvent({
      type: 'tool_execution_start',
      toolCallId: 'omp-tool-1',
      toolName: 'mcp__playwright_browser_snapshot',
    })?.message).toContain('读取页面结构')
    expect(progressFromAgentEvent({
      type: 'tool_execution_end',
      toolCallId: 'omp-tool-2',
      toolName: 'mcp__auto_test_control_mutation_list',
      result: {},
    })?.message).toContain('核对未完成的业务写入')
  })

  it('waits for terminal agent_end across OMP inner turns and maintenance continuations', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-omp-multiturn-'))
    directories.push(directory)
    const processFactory = (() => fakeOmpProcess(directory, (send) => {
      send({ type: 'agent_start' })
      send({ type: 'turn_start' })
      send({ type: 'turn_end' })
      send({ type: 'agent_end', messages: [], isTerminal: false })
      send({ type: 'tool_execution_start', toolCallId: 'observe-1', toolName: 'browser_snapshot', args: {} })
      send({ type: 'tool_execution_end', toolCallId: 'observe-1', toolName: 'browser_snapshot', result: { ok: true } })
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'terminal answer' }] } })
      send({ type: 'agent_end', messages: [], isTerminal: true })
    })) as unknown as typeof spawn
    const host = new OmpAgentHost({ spawnProcess: processFactory })
    const root = resolve(directory, 'workspace')
    await mkdir(root, { recursive: true })
    const session = await host.start({
      workspaceDirectory: root, agentHome: resolve(directory, 'home'), executable: process.platform === 'win32' ? process.execPath : '/bin/true',
      playwrightConfigPath: resolve(directory, 'playwright.json'), playwrightSecretsPath: resolve(directory, 'secrets.env'), controlConfigPath: resolve(directory, 'control.json'),
      environment: {}, mcpEnvironment: {}, fullAgentAccess: true,
    })
    const events = []
    for await (const event of (await session.run([{ type: 'text', text: 'multi-turn fixture' }])).events) events.push(event)
    expect(events.at(-1)?.type).toBe('turn_completed')
    expect(events.some((event) => event.type === 'tool_completed' && event.tool === 'browser_snapshot')).toBe(true)
    await session.close?.()
  })

  it('accepts an OMP delivery through the same deterministic test contract as Codex', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-omp-runner-'))
    directories.push(directory)
    const manifest = oneCaseManifest()
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n')
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const result: CodexTestAgentResult = {
      version: '1.0', workflowId: manifest.workflowId, sourceSha256: manifest.source.sha256,
      outcome: 'passed', summary: 'OMP completed the fixture contract.',
      startedAt: '2026-08-05T00:00:00.000Z', finishedAt: '2026-08-05T00:01:00.000Z',
      cases: [{
        caseId: 'case-one', title: 'Agent host contract', outcome: 'passed', summary: 'Observed expected fixture state.',
        evidence: [{ kind: 'observation', description: 'Fixture observation saved by the active OMP session.' }],
      }],
      mutations: [], environmentRequirements: [], blockers: [], productDefects: [], nextActions: [],
    }
    const spawnProcess = (() => fakeOmpProcess(directory, (send, promptIndex) => {
      send({ type: 'agent_start' })
      const text = promptIndex === 0 ? 'fixture execution complete' : JSON.stringify(result)
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } })
      send({ type: 'agent_end', messages: [] })
    })) as unknown as typeof spawn
    const host = new OmpAgentHost({ spawnProcess })
    const outputDirectory = resolve(directory, 'run')
    const run = await runAgentTest({
      outputDirectory,
      manifest,
      profile: { id: 'fixture', origins: ['https://agent.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false,
      codexHome: sourceHome,
      agentHost: host,
      agentExecutable: process.platform === 'win32' ? process.execPath : '/bin/true',
    }, { browserExecutablePath: browserPath })
    expect(run.state.agentHost).toBe('omp')
    expect(run.result?.outcome).toBe('passed')
    expect(run.result?.cases).toHaveLength(1)
    expect(JSON.parse(await readFile(resolve(outputDirectory, 'agent-host-selection.json'), 'utf8'))).toMatchObject({
      id: 'omp',
      capabilities: { structuredOutput: false, mcp: true },
    })
  })
})
