import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHostError, normalizeAgentEvent } from '../src/agent/host.js'
import type { AgentHost, AgentHostLaunchOptions, AgentHostProviderPrepareOptions, AgentInputPart } from '../src/agent/host.js'
import { codexSandboxMode, codexWebSearchEnabled, codexWorkspaceIsolation, startCodexSdkThread } from '../src/agent/codex-host.js'
import { OmpAgentHost, RpcFrameDecoder } from '../src/agent/omp-host.js'
import { availableAgentHosts, createAgentHost } from '../src/agent/host-registry.js'
import { AgentTestProgressReporter, progressFromAgentEvent, type AgentTestProgress } from '../src/agent/progress.js'
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

function ompLaunchOptions(directory: string, workspaceDirectory: string, fullAgentAccess = true): AgentHostLaunchOptions {
  return {
    workspaceDirectory,
    runtime: {
      agentHome: resolve(directory, 'agent-home'),
      environment: {},
      mcpEnvironment: {},
    },
    executable: process.platform === 'win32' ? process.execPath : '/bin/true',
    playwrightConfigPath: resolve(directory, 'playwright.json'),
    playwrightSecretsPath: resolve(directory, 'secrets.env'),
    controlConfigPath: resolve(directory, 'control.json'),
    fullAgentAccess,
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
      type: 'tool_execution_start',
      toolCallId: 'xdev-start',
      toolName: 'write',
      args: { path: 'xd://mcp__playwright_browser_click', content: '{"element":"Log In","ref":"e1"}' },
    })).toMatchObject({
      type: 'tool_started', server: 'playwright', tool: 'browser_click',
      arguments: { element: 'Log In', ref: 'e1' },
    })
    expect(normalizeAgentEvent({
      type: 'tool_execution_end',
      toolCallId: 'xdev-end',
      toolName: 'write',
      result: {
        details: {
          xdev: {
            tool: 'mcp__auto_test_control_case_execution_begin', mode: 'execute', args: { caseId: 'case-one' },
            inner: { serverName: 'auto-test-control', mcpToolName: 'case_execution_begin' },
          },
        },
      },
    })).toMatchObject({
      type: 'tool_completed', server: 'auto-test-control', tool: 'case_execution_begin',
      arguments: { caseId: 'case-one' },
    })
    expect(normalizeAgentEvent({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    })).toMatchObject({ type: 'agent_message', text: 'done' })
    expect(normalizeAgentEvent({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'tool_call', name: 'browser_click' }] },
    })).toMatchObject({ type: 'other' })
    expect(normalizeAgentEvent({ type: 'error', error: 'OMP provider disconnected' })).toMatchObject({
      type: 'error', message: 'OMP provider disconnected',
    })
    expect(normalizeAgentEvent({
      type: 'item.completed',
      item: {
        id: 'session-model-mismatch',
        type: 'error',
        message: 'This session was recorded with model deepseek-v4-flash but is resuming with gpt-5.6-sol.',
      },
    })).toMatchObject({
      type: 'session_incompatible',
      message: expect.stringContaining('resuming with gpt-5.6-sol'),
    })
    expect(normalizeAgentEvent({
      type: 'item.completed',
      item: {
        id: 'metadata-warning',
        type: 'error',
        message: 'Model metadata for `deepseek-v4-flash` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
      },
    })).toMatchObject({
      type: 'other',
      message: expect.stringContaining('Defaulting to fallback metadata'),
    })
    expect(normalizeAgentEvent({
      type: 'error',
      message: 'Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.',
    })).toMatchObject({ type: 'other' })
    expect(normalizeAgentEvent({
      type: 'item.completed',
      item: {
        id: 'skill-budget-warning',
        type: 'error',
        message: 'Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter.',
      },
    })).toMatchObject({ type: 'other', message: expect.stringContaining('skills context budget') })
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
    expect(createAgentHost('codex').capabilities.workspaceIsolation).toBe(
      process.platform === 'win32' ? 'prompt_only' : 'enforced',
    )
    expect(createAgentHost('codex').modelProvider.supportedApis).toEqual(['openai-responses'])
    expect(createAgentHost('omp').modelProvider.supportedApis).toContain('openai-completions')
    expect(createAgentHost('omp').capabilities.workspaceIsolation).toBe('prompt_only')
    expect(createAgentHost('omp').capabilities.restrictedMode).toBe(false)
  })

  it('gates Codex web search with the selected provider capability', () => {
    const nativeRuntime = { agentHome: '/tmp/native', environment: {}, mcpEnvironment: {} }
    const managedRuntime = {
      ...nativeRuntime,
      provider: {
        profileId: 'fixture', providerId: 'fixture', baseUrl: 'https://provider.example.test',
        api: 'openai-responses' as const, model: 'fixture', modelSelector: 'fixture',
      },
    }
    expect(codexWebSearchEnabled(nativeRuntime, true)).toBe(true)
    expect(codexWebSearchEnabled(managedRuntime, true)).toBe(false)
    expect(codexWebSearchEnabled({
      ...managedRuntime,
      provider: { ...managedRuntime.provider, supportsSearchTool: true },
    }, true)).toBe(true)
    expect(codexWebSearchEnabled(nativeRuntime, false)).toBe(false)
  })

  it('selects a host-level Windows fallback for writable MCP execution', () => {
    expect(codexSandboxMode(false, 'win32')).toBe('read-only')
    expect(codexSandboxMode(true, 'linux')).toBe('workspace-write')
    expect(codexSandboxMode(true, 'win32')).toBe('danger-full-access')
    expect(codexWorkspaceIsolation('linux')).toBe('enforced')
    expect(codexWorkspaceIsolation('win32')).toBe('prompt_only')
  })

  it.skipIf(process.platform === 'win32')('passes the Windows fallback to the native Codex CLI invocation', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-codex-sandbox-'))
    directories.push(directory)
    const capturePath = resolve(directory, 'argv.json')
    const executable = resolve(directory, 'codex-fixture.mjs')
    await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.AUTO_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)))
process.stdin.resume()
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'fixture-message', type: 'agent_message', text: 'ok' } }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }) + '\\n')
})
`)
    await chmod(executable, 0o755)
    const thread = startCodexSdkThread({
      workspaceDirectory: directory,
      runtime: {
        agentHome: resolve(directory, 'agent-home'),
        environment: { PATH: process.env.PATH ?? '', AUTO_TEST_CAPTURE: capturePath },
        mcpEnvironment: {},
        model: 'fixture-model',
      },
      executable,
      additionalWritableDirectories: [resolve(directory, 'private')],
      playwrightConfigPath: resolve(directory, 'playwright.json'),
      playwrightSecretsPath: resolve(directory, 'secrets.env'),
      controlConfigPath: resolve(directory, 'control.json'),
      fullAgentAccess: true,
    }, 'win32')
    const streamed = await thread.runStreamed('fixture prompt')
    for await (const _event of streamed.events) {
      // Drain the fake CLI stream so the child can exit cleanly.
    }
    const args = JSON.parse(await readFile(capturePath, 'utf8')) as string[]
    const sandboxIndex = args.indexOf('--sandbox')
    expect(sandboxIndex).toBeGreaterThanOrEqual(0)
    expect(args[sandboxIndex + 1]).toBe('danger-full-access')
    expect(args).toContain('features.plugins=false')
  })

  it('classifies host errors so only operational transport classes are retryable', () => {
    expect(new AgentHostError('codex', 'quota', 'quota').retryable).toBe(true)
    expect(new AgentHostError('omp', 'transport', 'transport').retryable).toBe(true)
    expect(new AgentHostError('codex', 'model changed', 'session_incompatible').retryable).toBe(true)
    expect(new AgentHostError('omp', 'unsupported mode', 'capability').retryable).toBe(false)
    expect(new AgentHostError('codex', 'bad executable', 'configuration').retryable).toBe(false)
    expect(new AgentHostError('omp', 'bad protocol', 'protocol').retryable).toBe(false)
  })

  it('fails before model traffic when a profile uses a model API unsupported by the selected host', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-host-wire-'))
    directories.push(directory)
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    let started = false
    const host = {
      id: 'codex' as const,
      displayName: 'Codex fixture',
      capabilities: {
        streaming: true, sessionResume: true, structuredOutput: true, localImages: true, mcp: true,
        shell: true, network: true, workspaceIsolation: 'enforced' as const, restrictedMode: true,
      },
      modelProvider: createAgentHost('codex').modelProvider,
      async probe(): Promise<{ ok: true; hostId: 'codex'; executable: string }> {
        return { ok: true, hostId: 'codex', executable: '/fixture/codex' }
      },
      async start(): Promise<never> {
        started = true
        throw new Error('must not start')
      },
      async resume(): Promise<never> {
        started = true
        throw new Error('must not resume')
      },
    } satisfies AgentHost
    const run = await runAgentTest({
      outputDirectory: resolve(directory, 'run'),
      manifest: oneCaseManifest(),
      profile: { id: 'fixture', origins: ['https://agent.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false,
      modelProfile: {
        id: 'chat-only', model: 'fixture', providerId: 'fixture', baseUrl: 'https://provider.example.test',
        api: 'openai-completions', envKey: 'FIXTURE_KEY',
      },
      environment: { FIXTURE_KEY: 'fixture-key' },
      agentHost: host,
    }, { browserExecutablePath: browserPath })
    expect(started).toBe(false)
    expect(run.state.status).toBe('failed')
    expect(run.state.error).toMatch(/does not support model API openai-completions/)
  })

  it('blocks before the business prompt when the model cannot call the Control MCP', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-host-preflight-'))
    directories.push(directory)
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const prompts: string[] = []
    const host = {
      id: 'portable',
      displayName: 'Portable fixture host',
      capabilities: {
        streaming: true, sessionResume: true, structuredOutput: false, localImages: true, mcp: true,
        shell: true, network: true, workspaceIsolation: 'prompt_only' as const, restrictedMode: false,
      },
      modelProvider: {
        supportedApis: ['openai-responses'] as const,
        async prepare(options: AgentHostProviderPrepareOptions) {
          return { agentHome: options.agentHome, environment: {}, mcpEnvironment: {} }
        },
      },
      async probe() {
        return { ok: true as const, hostId: 'portable', executable: '/fixture/portable' }
      },
      async start() {
        return {
          id: 'portable-no-control-mcp',
          async run(input: AgentInputPart[]) {
            prompts.push(input.filter((part) => part.type === 'text').map((part) => part.text).join('\n'))
            return {
              events: (async function* () {
                yield { type: 'thread_started' as const, threadId: 'portable-no-control-mcp' }
                yield { type: 'agent_message' as const, text: 'No Control MCP tool is available.' }
                yield { type: 'turn_completed' as const }
                throw new Error('terminal AgentHost events must end turn consumption')
              })(),
            }
          },
        }
      },
      async resume(): Promise<never> {
        throw new Error('fixture must not resume')
      },
    } satisfies AgentHost
    const outputDirectory = resolve(directory, 'run')
    const run = await runAgentTest({
      outputDirectory,
      manifest: oneCaseManifest(),
      profile: { id: 'fixture', origins: ['https://agent.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, agentHost: host,
    }, {
      browserExecutablePath: browserPath,
      startThread: () => { throw new Error('the injected real AgentHost must take precedence') },
    })

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('capability preflight')
    expect(prompts[0]).not.toContain('primary test engineer')
    expect(run.state.status).toBe('completed')
    expect(run.result?.cases[0]).toMatchObject({ outcome: 'blocked', failureSource: 'infrastructure' })
    expect(run.result?.blockers[0]).toMatch(/能力预检未观察到唯一且合规的 test_contract 调用/)
    expect(JSON.parse(await readFile(resolve(outputDirectory, '.agent-private', 'mutation-ledger.json'), 'utf8'))).toEqual([])
  })

  it('rejects a Control MCP preflight that also calls another tool', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-host-preflight-extra-tool-'))
    directories.push(directory)
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const prompts: string[] = []
    const host = {
      id: 'portable',
      displayName: 'Portable fixture host',
      capabilities: {
        streaming: true, sessionResume: true, structuredOutput: false, localImages: true, mcp: true,
        shell: true, network: true, workspaceIsolation: 'prompt_only' as const, restrictedMode: false,
      },
      modelProvider: {
        supportedApis: ['openai-responses'] as const,
        async prepare(options: AgentHostProviderPrepareOptions) {
          return { agentHome: options.agentHome, environment: {}, mcpEnvironment: {} }
        },
      },
      async probe() {
        return { ok: true as const, hostId: 'portable', executable: '/fixture/portable' }
      },
      async start() {
        return {
          id: 'portable-extra-tool',
          async run(input: AgentInputPart[]) {
            prompts.push(input.filter((part) => part.type === 'text').map((part) => part.text).join('\n'))
            return {
              events: (async function* () {
                yield { type: 'tool_completed' as const, server: 'auto-test-control', tool: 'test_contract', status: 'completed' as const }
                yield { type: 'tool_completed' as const, server: 'playwright', tool: 'browser_snapshot', status: 'completed' as const }
                yield { type: 'agent_message' as const, text: 'preflight complete' }
              })(),
            }
          },
        }
      },
      async resume(): Promise<never> {
        throw new Error('fixture must not resume')
      },
    } satisfies AgentHost
    const run = await runAgentTest({
      outputDirectory: resolve(directory, 'run'),
      manifest: oneCaseManifest(),
      profile: { id: 'fixture', origins: ['https://agent.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, agentHost: host,
    }, { browserExecutablePath: browserPath })

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('capability preflight')
    expect(run.result?.cases[0]).toMatchObject({ outcome: 'blocked', failureSource: 'infrastructure' })
  })

  it('runs an unregistered third-party host through the generic provider runtime contract', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-host-portable-'))
    directories.push(directory)
    const browserPath = resolve(directory, 'chromium')
    const sourceAgentHome = resolve(directory, 'portable-source-home')
    const agentExecutable = resolve(directory, 'portable-agent')
    const inputImagePath = resolve(directory, 'case-one-image.png')
    await Promise.all([
      writeFile(browserPath, ''),
      mkdir(sourceAgentHome, { recursive: true }),
      writeFile(agentExecutable, ''),
      writeFile(inputImagePath, ''),
    ])
    const manifest = oneCaseManifest()
    manifest.phases[0]!.imageIds.push('case-one-image')
    manifest.supplementalImages.push({
      id: 'case-one-image', sourceKind: 'supplemental', fileName: 'case-one-image.png',
      mediaType: 'image/png', bytes: 0, sha256: 'b'.repeat(64), reviewStatus: 'required',
    })
    const delivered: CodexTestAgentResult = {
      version: '1.0', workflowId: manifest.workflowId, sourceSha256: manifest.source.sha256,
      outcome: 'passed', summary: 'Portable host completed the generic contract.',
      startedAt: '2026-08-06T00:00:00.000Z', finishedAt: '2026-08-06T00:01:00.000Z',
      cases: [{
        caseId: 'case-one', title: 'Agent host contract', outcome: 'passed', summary: 'Observed the portable fixture.',
        evidence: [{ kind: 'observation', description: 'Portable host produced host-neutral evidence.' }],
      }],
      mutations: [], environmentRequirements: [], blockers: [], productDefects: [], nextActions: [],
    }
    let prepared: AgentHostProviderPrepareOptions | undefined
    let launched: AgentHostLaunchOptions | undefined
    let receivedExecutionInput: AgentInputPart[] | undefined
    let turn = 0
    const session = {
      id: 'portable-session',
      async run(input: AgentInputPart[]) {
        if (input[0]?.type === 'text' && input[0].text.includes('capability preflight')) {
          return {
            events: (async function* () {
              yield { type: 'thread_started' as const, threadId: 'portable-session' }
              yield { type: 'tool_completed' as const, server: 'auto-test-control', tool: 'test_contract', status: 'completed' as const }
              yield { type: 'agent_message' as const, text: 'preflight complete' }
            })(),
          }
        }
        if (turn === 0) receivedExecutionInput = input
        const text = turn++ === 0 ? 'Portable execution completed.' : JSON.stringify(delivered)
        return {
          events: (async function* () {
            yield { type: 'thread_started' as const, threadId: 'portable-session' }
            if (text.startsWith('{')) {
              yield { type: 'tool_completed' as const, server: 'playwright', tool: 'browser_storage_state', arguments: { filename: 'replay-storage-state.json' }, status: 'completed' as const }
              yield { type: 'tool_completed' as const, server: 'playwright', tool: 'browser_evaluate', arguments: { filename: 'replay-session-storage.json' }, status: 'completed' as const }
              yield { type: 'tool_completed' as const, server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'case-one' }, status: 'completed' as const }
              yield { type: 'tool_completed' as const, server: 'playwright', tool: 'browser_navigate', arguments: {}, status: 'completed' as const, result: { content: [{ type: 'text', text: "### Ran Playwright code\n```js\nawait page.goto('data:text/html,<div>Ready</div>');\n```" }] } }
              yield { type: 'tool_completed' as const, server: 'playwright', tool: 'browser_verify_text_visible', arguments: {}, status: 'completed' as const, result: { content: [{ type: 'text', text: "### Ran Playwright code\n```js\nawait expect(page.getByText('Ready')).toBeVisible();\n```" }] } }
              yield { type: 'tool_completed' as const, server: 'auto-test-control', tool: 'case_execution_end', arguments: { caseId: 'case-one' }, status: 'completed' as const }
            }
            yield { type: 'agent_message' as const, text }
          })(),
        }
      },
    }
    const host = {
      id: 'portable',
      displayName: 'Portable fixture host',
      capabilities: {
        streaming: true, sessionResume: true, structuredOutput: false, localImages: true, mcp: true,
        shell: true, network: true, workspaceIsolation: 'prompt_only' as const, restrictedMode: false,
      },
      modelProvider: {
        supportedApis: ['openai-responses'] as const,
        async prepare(options: AgentHostProviderPrepareOptions) {
          prepared = options
          if (!options.provider || options.provider.credential.type !== 'environment') {
            throw new Error('portable fixture requires an environment-backed provider')
          }
          const model = options.model ?? options.provider.model
          const credentialName = options.provider.credential.name
          return {
            agentHome: options.agentHome,
            environment: { [credentialName]: options.environment[credentialName]! },
            mcpEnvironment: {},
            model: `portable/${model}`,
            provider: {
              profileId: options.provider.profileId,
              providerId: options.provider.providerId,
              baseUrl: options.provider.baseUrl,
              api: options.provider.api,
              model,
              modelSelector: `portable/${model}`,
              credentialEnvironmentVariable: credentialName,
              ...(options.provider.inputModalities ? { inputModalities: [...options.provider.inputModalities] } : {}),
              ...(options.provider.supportsParallelToolCalls !== undefined
                ? { supportsParallelToolCalls: options.provider.supportsParallelToolCalls }
                : {}),
            },
          }
        },
      },
      async probe(options: AgentHostLaunchOptions) {
        launched = options
        return { ok: true, hostId: 'portable', executable: options.executable! }
      },
      async start(options: AgentHostLaunchOptions) {
        launched = options
        return session
      },
      async resume(options: AgentHostLaunchOptions & { resumeId: string }) {
        launched = options
        return session
      },
    } satisfies AgentHost
    const outputDirectory = resolve(directory, 'run')
    const run = await runAgentTest({
      outputDirectory,
      manifest,
      profile: { id: 'fixture', origins: ['https://agent.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [inputImagePath], headed: false,
      model: 'deepseek-v4-flash-override',
      modelProfile: {
        id: 'deepseek', model: 'deepseek-v4-flash', providerId: 'deepseek', baseUrl: 'https://api.deepseek.com',
        api: 'openai-responses', envKey: 'DEEPSEEK_API_KEY',
        supportsParallelToolCalls: true,
      },
      environment: { DEEPSEEK_API_KEY: 'portable-provider-secret' },
      agentHost: host,
      agentSourceHome: sourceAgentHome,
      agentExecutable,
    }, { browserExecutablePath: browserPath })

    expect(run.state.agentHost).toBe('portable')
    expect(run.result?.outcome).toBe('passed')
    expect(prepared).toMatchObject({ sourceAgentHome, model: 'deepseek-v4-flash-override' })
    expect(prepared?.provider).toMatchObject({ profileId: 'deepseek', api: 'openai-responses' })
    expect(launched).toMatchObject({ executable: agentExecutable })
    expect(launched?.runtime).toMatchObject({
      model: 'portable/deepseek-v4-flash-override',
      provider: {
        model: 'deepseek-v4-flash-override', baseUrl: 'https://api.deepseek.com',
        supportsParallelToolCalls: true,
      },
    })
    expect(receivedExecutionInput?.some((part) => part.type === 'local_image')).toBe(false)
    expect(receivedExecutionInput?.[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('cannot receive inline image parts'),
    })
    const selection = await readFile(resolve(outputDirectory, 'agent-host-selection.json'), 'utf8')
    expect(JSON.parse(selection)).toMatchObject({
      id: 'portable',
      modelProvider: { binding: { profileId: 'deepseek', modelSelector: 'portable/deepseek-v4-flash-override' } },
    })
    expect(selection).not.toContain('portable-provider-secret')
  })

  it('fails closed when OMP is asked to impersonate the restricted opaque mode', async () => {
    const host = new OmpAgentHost()
    await expect(host.probe({
      workspaceDirectory: '/tmp/workspace', runtime: { agentHome: '/tmp/home', environment: {}, mcpEnvironment: {} }, executable: '/tmp/omp',
      playwrightConfigPath: '/tmp/playwright.json', playwrightSecretsPath: '/tmp/secrets.env', controlConfigPath: '/tmp/control.json',
      fullAgentAccess: false,
    })).resolves.toMatchObject({ ok: false, hostId: 'omp' })
  })

  it('classifies AgentHost transport failures as infrastructure blocks', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-host-failure-'))
    directories.push(directory)
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const ompHome = resolve(directory, 'omp-home')
    await mkdir(ompHome)
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
      modelProvider: createAgentHost('omp').modelProvider,
      async probe(): Promise<{ ok: true; hostId: 'omp'; executable: string }> {
        return { ok: true, hostId: 'omp', executable: '/fixture/omp' }
      },
      async start(): Promise<never> {
        throw new AgentHostError('omp', 'OMP RPC connection lost', 'transport')
      },
      async resume(): Promise<never> {
        throw new AgentHostError('omp', 'OMP RPC connection lost', 'transport')
      },
    } satisfies AgentHost
    const run = await runAgentTest({
      outputDirectory: resolve(directory, 'run'),
      manifest: oneCaseManifest(),
      profile: { id: 'fixture', origins: ['https://agent.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false,
      agentSourceHome: ompHome,
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
    const workspaceDirectory = resolve(directory, 'workspace')
    await mkdir(workspaceDirectory, { recursive: true })
    let spawnedArguments: readonly string[] = []
    const processFactory = (_command: string, args: readonly string[]): ChildProcessWithoutNullStreams => {
      spawnedArguments = args
      return fakeOmpProcess(directory, (send) => {
      send({ type: 'extension_ui_request', id: 'widget-1', method: 'setWidget', widgetKey: 'status', widgetLines: ['working'] })
      send({ type: 'extension_ui_request', id: 'notice-1', method: 'notify', message: 'fixture notice' })
      send({ type: 'agent_start' })
      send({ type: 'message_start', message: { role: 'assistant', content: [] } })
      for (let index = 1; index <= 32; index += 1) {
        send({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(index * 4096) }] } })
      }
      send({ type: 'tool_execution_start', toolCallId: 'click-1', toolName: 'browser_click', args: { label: 'fixture' } })
      send({ type: 'tool_execution_update', toolCallId: 'click-1', toolName: 'browser_click', partialResult: { progress: 'x'.repeat(128 * 1024) } })
      send({ type: 'tool_execution_end', toolCallId: 'click-1', toolName: 'browser_click', result: { ok: true } })
      const assistant = { role: 'assistant', content: [{ type: 'text', text: 'fixture completed' }] }
      send({ type: 'message_end', message: assistant })
      send({ type: 'agent_end', messages: [assistant] })
      })
    }
    const spawnProcess = processFactory as unknown as typeof spawn
    const host = new OmpAgentHost({ spawnProcess })
    const options = ompLaunchOptions(directory, workspaceDirectory)
    options.runtime.model = 'volcengine_coding/glm-5.2'
    options.runtime.provider = {
      profileId: 'volcengine',
      providerId: 'volcengine_coding',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      api: 'openai-responses',
      model: 'glm-5.2',
      modelSelector: 'volcengine_coding/glm-5.2',
      configurationPath: resolve(options.runtime.agentHome, 'models.yml'),
      reasoningEffort: 'high',
    }
    await expect(host.probe(options)).resolves.toMatchObject({ ok: true, hostId: 'omp' })
    const session = await host.start(options)
    expect(spawnedArguments).toEqual(expect.arrayContaining([
      '--model', 'volcengine_coding/glm-5.2', '--thinking', 'high',
    ]))
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

  it('fails closed when OMP requests actual user input in headless mode', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-omp-interactive-ui-'))
    directories.push(directory)
    const processFactory = (() => fakeOmpProcess(directory, (send) => {
      send({
        type: 'extension_ui_request',
        id: 'confirm-1',
        method: 'confirm',
        title: 'Interactive confirmation',
        message: 'Continue?',
      })
    })) as unknown as typeof spawn
    const host = new OmpAgentHost({ spawnProcess: processFactory })
    const root = resolve(directory, 'workspace')
    await mkdir(root, { recursive: true })
    const session = await host.start(ompLaunchOptions(directory, root))
    const stream = await session.run([{ type: 'text', text: 'interactive fixture' }])
    await expect(async () => {
      for await (const _event of stream.events) {
        // Consume until the adapter rejects the interactive request.
      }
    }).rejects.toThrow('interactive RPC UI input')
    await session.close?.()
  })

  it('maps OMP-prefixed MCP tool names to the same safe progress categories', () => {
    const progress = progressFromAgentEvent({
      type: 'tool_execution_start',
      toolCallId: 'omp-tool-1',
      toolName: 'mcp__playwright_browser_snapshot',
      args: { password: 'must-not-be-printed', phone: '13800000000' },
    })
    expect(progress?.message).toContain('读取页面结构 [playwright.browser_snapshot]')
    expect(progress?.action).toMatchObject({
      phase: 'started', category: 'browser', server: 'playwright', tool: 'browser_snapshot',
    })
    expect(JSON.stringify(progress)).not.toMatch(/must-not-be-printed|13800000000/)
    expect(progressFromAgentEvent({
      type: 'tool_execution_end',
      toolCallId: 'omp-tool-2',
      toolName: 'mcp__auto_test_control_mutation_list',
      result: {},
    })?.message).toContain('核对未完成的业务写入')
    const unknown = progressFromAgentEvent({
      type: 'tool_started', server: 'sk-secret-server', tool: 'token-secret-tool',
    })
    expect(unknown).toMatchObject({
      message: '正在调用受控测试工具',
      action: { category: 'tool', label: '调用受控测试工具' },
    })
    expect(JSON.stringify(unknown)).not.toMatch(/sk-secret-server|token-secret-tool/)
  })

  it('reports contextual action lifecycles, heartbeats, failures, and duplicate events safely', () => {
    vi.useFakeTimers()
    try {
      const progress: AgentTestProgress[] = []
      const reporter = new AgentTestProgressReporter((event) => progress.push(event), 1_000)
      reporter.setContext({ hostId: 'codex', epochIndex: 1, epochTotal: 2, threadGeneration: 3 })
      reporter.startHeartbeat()
      const started = {
        type: 'item.started',
        item: {
          id: 'click-1', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_click',
          arguments: { password: 'must-not-leak', element: 'sensitive form value' },
        },
      }
      reporter.observe(started)
      reporter.observe(started)
      vi.advanceTimersByTime(1_500)
      reporter.observe({
        type: 'item.completed',
        item: { id: 'click-1', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_click', result: { ok: true } },
      })
      reporter.setContext({ threadGeneration: 4 })
      reporter.observe(started)
      reporter.observe({
        type: 'item.completed',
        item: { id: 'command-1', type: 'command_execution', status: 'failed', command: 'echo must-not-leak' },
      })
      reporter.close()

      const output = progress.map((event) => event.message).join('\n')
      expect(progress.filter((event) => event.kind === 'activity' && event.action?.phase === 'started' && event.action.tool === 'browser_click')).toHaveLength(2)
      expect(output).toContain('[Host=Codex | epoch=1/2 | thread generation=3]')
      expect(output).toContain('[Host=Codex | epoch=1/2 | thread generation=4]')
      expect(output).toContain('当前动作：点击页面控件 [playwright.browser_click]')
      expect(output).toContain('动作 #1，状态=完成，耗时 1 秒')
      expect(output).toContain('运行测试辅助命令或脚本返回失败')
      expect(output).toContain('[command_execution]')
      expect(output).toContain('状态=失败')
      expect(output).not.toMatch(/must-not-leak|sensitive form value/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('normalizes native OMP MCP calls for the shared control preflight', () => {
    expect(normalizeAgentEvent({
      type: 'tool_execution_end',
      toolCallId: 'contract-1',
      toolName: 'mcp__auto_test_control_test_contract',
      result: {
        details: { serverName: 'auto-test-control', mcpToolName: 'test_contract' },
        isError: false,
      },
      isError: false,
    })).toMatchObject({
      type: 'tool_completed',
      server: 'auto-test-control',
      tool: 'test_contract',
      status: 'completed',
    })
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
    const session = await host.start(ompLaunchOptions(directory, root))
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
      if (promptIndex === 0) {
        send({ type: 'tool_completed', server: 'auto-test-control', tool: 'test_contract', status: 'completed' })
      }
      if (promptIndex > 1) {
        send({ type: 'tool_completed', server: 'playwright', tool: 'browser_storage_state', arguments: { filename: 'replay-storage-state.json' }, status: 'completed' })
        send({ type: 'tool_completed', server: 'playwright', tool: 'browser_evaluate', arguments: { filename: 'replay-session-storage.json' }, status: 'completed' })
        send({ type: 'tool_completed', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'case-one' }, status: 'completed' })
        send({ type: 'tool_completed', server: 'playwright', tool: 'browser_navigate', arguments: {}, result: { content: [{ type: 'text', text: "### Ran Playwright code\n```js\nawait page.goto('data:text/html,<div>Ready</div>');\n```" }] }, status: 'completed' })
        send({ type: 'tool_completed', server: 'playwright', tool: 'browser_verify_text_visible', arguments: {}, result: { content: [{ type: 'text', text: "### Ran Playwright code\n```js\nawait expect(page.getByText('Ready')).toBeVisible();\n```" }] }, status: 'completed' })
        send({ type: 'tool_completed', server: 'auto-test-control', tool: 'case_execution_end', arguments: { caseId: 'case-one' }, status: 'completed' })
      }
      const text = promptIndex <= 1 ? 'fixture execution complete' : JSON.stringify(result)
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
      agentSourceHome: sourceHome,
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
