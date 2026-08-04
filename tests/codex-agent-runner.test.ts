import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Input, ThreadEvent } from '@openai/codex-sdk'
import { CodexTestProgressReporter, progressFromThreadEvent } from '../src/agent/progress.js'
import { runCodexTestAgent } from '../src/agent/runner.js'
import type { CodexTestAgentResult } from '../src/agent/types.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'

const directories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function manifest(origin: string, risk: 'read' | 'write' = 'read'): WorkflowIntakeManifest {
  return {
    version: '1.0', kind: 'workflow-intake', workflowId: 'runner-fixture',
    source: { format: 'xlsx', fileName: 'runner.xlsx', sheetName: 'Cases', sha256: 'c'.repeat(64) },
    targetUrls: [`${origin}/tasks`], requiredCapabilities: [],
    phases: [{
      id: 'inspect-task', title: 'Inspect task', sourceRow: 2, risk,
      steps: [{ id: 'step-1', sourceText: 'Open task details', confidence: 1 }],
      resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] },
    }],
    embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
  }
}

function twoCaseManifest(origin: string): WorkflowIntakeManifest {
  const workflow = manifest(origin)
  workflow.phases.push({
    id: 'inspect-second-task', title: 'Inspect second task', sourceRow: 3, risk: 'read',
    steps: [{ id: 'step-2', sourceText: 'Open second task details', confidence: 1 }],
    resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] },
  })
  return workflow
}

function streamedResponse(
  response: string,
  options: { threadId?: string; includeCaseBookkeeping?: boolean } = {},
): { events: AsyncGenerator<ThreadEvent> } {
  const threadId = options.threadId ?? 'thread-fixture'
  const includeCaseBookkeeping = options.includeCaseBookkeeping ?? true
  const interactionId = includeCaseBookkeeping ? 'receipt-interaction' : 'unattributed-interaction'
  const observationId = includeCaseBookkeeping ? 'receipt-observation' : 'unattributed-observation'
  return {
    events: (async function* () {
      yield { type: 'thread.started', thread_id: threadId } as ThreadEvent
      yield { type: 'turn.started' } as ThreadEvent
      if (includeCaseBookkeeping) {
        yield { type: 'item.completed', item: { id: 'case-begin', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'inspect-task' }, result: {}, status: 'completed' } } as ThreadEvent
      }
      yield { type: 'item.completed', item: { id: interactionId, type: 'mcp_tool_call', server: 'playwright', tool: 'browser_click', arguments: {}, result: {}, status: 'completed' } } as ThreadEvent
      yield { type: 'item.completed', item: { id: observationId, type: 'mcp_tool_call', server: 'playwright', tool: 'browser_snapshot', arguments: {}, result: {}, status: 'completed' } } as ThreadEvent
      if (includeCaseBookkeeping) {
        yield { type: 'item.completed', item: { id: 'case-end', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_end', arguments: { caseId: 'inspect-task' }, result: {}, status: 'completed' } } as ThreadEvent
      }
      yield { type: 'item.completed', item: { id: 'message', type: 'agent_message', text: response } } as ThreadEvent
      yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } } as ThreadEvent
    })(),
  }
}

function failedStream(message: string, threadId = 'thread-fixture'): { events: AsyncGenerator<ThreadEvent> } {
  return {
    events: (async function* () {
      yield { type: 'thread.started', thread_id: threadId } as ThreadEvent
      yield { type: 'error', message } as ThreadEvent
    })(),
  }
}

function reconnectingStreamText(response: string): { events: AsyncGenerator<ThreadEvent> } {
  return {
    events: (async function* () {
      yield { type: 'thread.started', thread_id: 'thread-fixture' } as ThreadEvent
      yield { type: 'turn.started' } as ThreadEvent
      yield { type: 'error', message: 'Reconnecting... 1/5 (temporary upstream issue)' } as ThreadEvent
      yield { type: 'item.completed', item: { id: 'case-begin', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'inspect-task' }, result: {}, status: 'completed' } } as ThreadEvent
      yield { type: 'item.completed', item: { id: 'receipt-interaction', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_click', arguments: {}, result: {}, status: 'completed' } } as ThreadEvent
      yield { type: 'item.completed', item: { id: 'receipt-observation', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_snapshot', arguments: {}, result: {}, status: 'completed' } } as ThreadEvent
      yield { type: 'item.completed', item: { id: 'case-end', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_end', arguments: { caseId: 'inspect-task' }, result: {}, status: 'completed' } } as ThreadEvent
      yield { type: 'item.completed', item: { id: 'message', type: 'agent_message', text: response } } as ThreadEvent
      yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } } as ThreadEvent
    })(),
  }
}

function twoCaseExecutionResponse(response: string): { events: AsyncGenerator<ThreadEvent> } {
  return {
    events: (async function* () {
      yield { type: 'thread.started', thread_id: 'thread-fixture' } as ThreadEvent
      yield { type: 'turn.started' } as ThreadEvent
      for (const [caseId, suffix] of [['inspect-task', 'first'], ['inspect-second-task', 'second']] as const) {
        yield { type: 'item.completed', item: { id: `case-begin-${suffix}`, type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId }, result: {}, status: 'completed' } } as ThreadEvent
        yield { type: 'item.completed', item: { id: `receipt-interaction-${suffix}`, type: 'mcp_tool_call', server: 'playwright', tool: 'browser_click', arguments: {}, result: {}, status: 'completed' } } as ThreadEvent
        yield { type: 'item.completed', item: { id: `receipt-observation-${suffix}`, type: 'mcp_tool_call', server: 'playwright', tool: 'browser_snapshot', arguments: {}, result: {}, status: 'completed' } } as ThreadEvent
        yield { type: 'item.completed', item: { id: `case-end-${suffix}`, type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_end', arguments: { caseId }, result: {}, status: 'completed' } } as ThreadEvent
      }
      yield { type: 'item.completed', item: { id: 'message', type: 'agent_message', text: response } } as ThreadEvent
      yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } } as ThreadEvent
    })(),
  }
}

function singleCaseExecutionResponse(response: string, caseId: string, suffix: string): { events: AsyncGenerator<ThreadEvent> } {
  return {
    events: (async function* () {
      yield { type: 'thread.started', thread_id: `thread-${suffix}` } as ThreadEvent
      yield { type: 'turn.started' } as ThreadEvent
      yield { type: 'item.completed', item: { id: `case-begin-${suffix}`, type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId }, result: {}, status: 'completed' } } as ThreadEvent
      yield { type: 'item.completed', item: { id: `receipt-interaction-${suffix}`, type: 'mcp_tool_call', server: 'playwright', tool: 'browser_click', arguments: {}, result: {}, status: 'completed' } } as ThreadEvent
      yield { type: 'item.completed', item: { id: `receipt-observation-${suffix}`, type: 'mcp_tool_call', server: 'playwright', tool: 'browser_snapshot', arguments: {}, result: {}, status: 'completed' } } as ThreadEvent
      yield { type: 'item.completed', item: { id: `case-end-${suffix}`, type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_end', arguments: { caseId }, result: {}, status: 'completed' } } as ThreadEvent
      yield { type: 'item.completed', item: { id: `message-${suffix}`, type: 'agent_message', text: response } } as ThreadEvent
      yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } } as ThreadEvent
    })(),
  }
}

function receiptId(id: string, namespace = 'single-thread', turn = 1): string {
  return `${namespace}:turn-${String(turn).padStart(4, '0')}:${id}`
}

function finalResult(workflow: WorkflowIntakeManifest, overrides: Partial<CodexTestAgentResult> = {}): CodexTestAgentResult {
  return {
    version: '1.0',
    workflowId: workflow.workflowId,
    sourceSha256: workflow.source.sha256,
    outcome: 'passed',
    summary: 'The requested operation and observable result were verified.',
    startedAt: '2026-08-03T00:00:00.000Z',
    finishedAt: '2026-08-03T00:01:00.000Z',
    cases: workflow.phases.map((phase) => ({
      caseId: phase.id,
      title: phase.title,
      outcome: 'passed',
      summary: 'Expected business state was observed.',
      executionReceiptIds: [receiptId('receipt-interaction'), receiptId('receipt-observation')],
      evidence: [{ kind: 'observation', description: 'Live page and business state were verified.' }],
    })),
    mutations: [],
    environmentRequirements: [],
    blockers: [],
    productDefects: [],
    nextActions: [],
    ...overrides,
  }
}

async function fakeCodexExecutable(directory: string): Promise<string> {
  const path = resolve(directory, process.platform === 'win32' ? 'codex.exe' : 'codex')
  await writeFile(path, '', { mode: 0o700 })
  return path
}

describe('Codex test agent runner', () => {
  it('reports safe live progress without exposing tool arguments or agent text', () => {
    const secret = 'private-form-value'
    const started = progressFromThreadEvent({
      type: 'item.started',
      item: {
        id: 'fill', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_fill_form',
        arguments: { value: secret }, status: 'in_progress',
      },
    } as ThreadEvent)
    const completed = progressFromThreadEvent({
      type: 'item.completed',
      item: {
        id: 'plan', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'test_plan_update',
        arguments: { summary: secret }, result: { content: [], structured_content: { secret } }, status: 'completed',
      },
    } as ThreadEvent)
    const agentMessage = progressFromThreadEvent({
      type: 'item.completed', item: { id: 'message', type: 'agent_message', text: secret },
    } as ThreadEvent)
    const command = progressFromThreadEvent({
      type: 'item.started', item: { id: 'command', type: 'command_execution', command: `inspect ${secret}`, aggregated_output: '', status: 'in_progress' },
    } as ThreadEvent)

    expect(started?.message).toContain('填写页面表单')
    expect(completed?.message).toContain('Execution Plan')
    expect(agentMessage?.message).toContain('本轮执行说明')
    expect(command?.message).toContain('测试辅助命令')
    expect(JSON.stringify([started, completed, agentMessage, command])).not.toContain(secret)
  })

  it('emits a heartbeat while a long-running model turn is quiet', async () => {
    vi.useFakeTimers()
    const messages: string[] = []
    const reporter = new CodexTestProgressReporter((progress) => messages.push(progress.message), 20_000)
    reporter.report('activity', '正在读取页面结构')
    reporter.startHeartbeat()

    await vi.advanceTimersByTimeAsync(20_000)
    reporter.close()
    vi.useRealTimers()

    expect(messages).toContain('框架仍在运行（已持续 20 秒）；最近进度：正在读取页面结构')
  })

  it('prefers the explicitly configured current Codex CLI executable', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-current-cli-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const configuredCodex = resolve(directory, 'current-codex')
    await writeFile(configuredCodex, '', { mode: 0o700 })
    vi.stubEnv('AUTO_TEST_CODEX_BIN', configuredCodex)
    let receivedCodexExecutable = ''

    await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'),
      manifest: manifest('https://tasks.example.test'),
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome,
    }, {
      browserExecutablePath: browserPath,
      startThread: (options) => {
        receivedCodexExecutable = options.codexExecutable ?? ''
        throw new Error('stop after thread configuration')
      },
    })

    expect(receivedCodexExecutable).toBe(configuredCodex)
  })

  it('resolves the user Codex CLI instead of the npm dependency shim', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-path-cli-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const dependencyBin = resolve(directory, 'node_modules', '.bin')
    const userBin = resolve(directory, 'user-bin')
    await mkdir(dependencyBin, { recursive: true })
    await mkdir(userBin)
    const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex'
    await writeFile(resolve(dependencyBin, executableName), '', { mode: 0o700 })
    const userCodex = resolve(userBin, executableName)
    await writeFile(userCodex, '', { mode: 0o700 })
    vi.stubEnv('AUTO_TEST_CODEX_BIN', '')
    vi.stubEnv('PATH', `${dependencyBin}${delimiter}${userBin}`)
    if (process.platform === 'win32') vi.stubEnv('PATHEXT', '.EXE;.CMD')
    let receivedCodexExecutable = ''

    await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'),
      manifest: manifest('https://tasks.example.test'),
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome,
    }, {
      browserExecutablePath: browserPath,
      startThread: (options) => {
        receivedCodexExecutable = options.codexExecutable
        throw new Error('stop after thread configuration')
      },
    })

    expect(receivedCodexExecutable).toBe(userCodex)
  })

  it('keeps the legacy restricted Codex configuration behind opaque test-data mode', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-restricted-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)
    let fullAgentAccess = true

    await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'),
      manifest: manifest('https://tasks.example.test'),
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
      testDataAccess: 'opaque',
    }, {
      browserExecutablePath: browserPath,
      startThread: (options) => {
        fullAgentAccess = options.fullAgentAccess
        throw new Error('stop after restricted thread configuration')
      },
    })

    expect(fullAgentAccess).toBe(false)
  })

  it('keeps execution and incomplete-delivery repair in the same persistent thread', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-runner-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)
    const executionInputs: Input[] = []
    const progressMessages: string[] = []
    const workflow = manifest('https://tasks.example.test')
    const sourceFilePath = resolve(directory, 'runner.xlsx')
    await writeFile(sourceFilePath, 'raw workbook')
    let structuredTurn = 0
    const executionRunStreamed = vi.fn(async (input: Input, options?: { outputSchema?: unknown }) => {
      executionInputs.push(input)
      if (!options?.outputSchema) return streamedResponse('Execution and assertions complete.')
      structuredTurn += 1
      if (structuredTurn === 1) return streamedResponse(JSON.stringify(finalResult(workflow, { cases: [] })))
      return streamedResponse(JSON.stringify(finalResult(workflow)))
    })

    const run = await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'),
      manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', sourceFilePath, imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
      onProgress: (progress) => progressMessages.push(progress.message),
    }, {
      browserExecutablePath: browserPath,
      startThread: (options) => {
        expect(options.fullAgentAccess).toBe(true)
        return { id: 'thread-fixture', runStreamed: executionRunStreamed }
      },
    })

    expect(run.result?.outcome).toBe('passed')
    expect(run.result?.cases[0]?.failureSource).toBeUndefined()
    expect(run.result?.cases[0]?.failureKind).toBeUndefined()
    expect(executionRunStreamed).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(executionInputs[0])).toContain('primary test engineer')
    expect(JSON.stringify(executionInputs[0])).toContain('runner.xlsx')
    expect(JSON.stringify(executionInputs[1])).toContain('Produce the final structured result')
    expect(JSON.stringify(executionInputs[2])).toContain('missing final case result')
    expect(progressMessages).toContain('Codex 测试线程已建立；中断后可以从本次结果目录恢复')
    expect(progressMessages).toContain('结构化测试结果已生成：passed')
    const events = await readFile(resolve(directory, 'run', 'codex-agent.events.jsonl'), 'utf8')
    expect(events.trim().split('\n')).toHaveLength(24)
  })

  it('rejects an environment conclusion without a recorded case-scoped prerequisite and corrects it in the same thread', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-environment-audit-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)
    const workflow = manifest('https://tasks.example.test')
    const inputs: Input[] = []
    let finalization = 0
    const unsupportedEnvironment = finalResult(workflow, {
      outcome: 'blocked',
      cases: [{
        caseId: 'inspect-task', title: 'Inspect task', outcome: 'blocked', summary: 'The agent did not use the available filter.',
        failureSource: 'environment', failureKind: 'data',
        evidence: [{ kind: 'observation', description: 'The unattempted filter was visible.' }],
      }],
      blockers: ['The agent did not use the available filter.'],
    })
    const corrected = finalResult(workflow, {
      outcome: 'blocked',
      cases: [{
        caseId: 'inspect-task', title: 'Inspect task', outcome: 'blocked', summary: 'The available read-only interaction was not completed.',
        failureSource: 'agent_execution', failureKind: 'execution',
        evidence: [{ kind: 'observation', description: 'The available filter was not exercised.' }],
      }],
      blockers: ['The available read-only interaction was not completed.'],
    })

    const run = await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'),
      manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
      maxFinalizationTurns: 1,
    }, {
      browserExecutablePath: browserPath,
      startThread: () => ({
        id: 'thread-environment-audit',
        runStreamed: async (input, options) => {
          inputs.push(input)
          if (!options?.outputSchema) return streamedResponse('Execution or audit complete.')
          finalization += 1
          return streamedResponse(JSON.stringify(finalization === 1 ? unsupportedEnvironment : corrected))
        },
      }),
    })

    expect(run.result?.cases[0]).toMatchObject({ failureSource: 'agent_execution', failureKind: 'execution' })
    expect(JSON.stringify(inputs[2])).toContain('environment-blocked case inspect-task has no recorded environment requirement reference')
  })

  it('rejects a generic browser receipt reused to bulk-generate conclusions for multiple cases', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-receipt-batch-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)
    const workflow = twoCaseManifest('https://tasks.example.test')
    const caseResult = (caseId: string, title: string, receiptIds: string[]) => ({
      caseId, title, outcome: 'passed' as const, summary: 'The observable state was verified.',
      executionReceiptIds: receiptIds,
      evidence: [{ kind: 'observation' as const, description: 'Live state was observed.' }],
    })
    const batch = finalResult(workflow, {
      cases: [
        caseResult('inspect-task', 'Inspect task', [receiptId('receipt-interaction-first'), receiptId('receipt-observation-first')]),
        caseResult('inspect-second-task', 'Inspect second task', [receiptId('receipt-interaction-first'), receiptId('receipt-observation-first')]),
      ],
    })
    const corrected = finalResult(workflow, {
      cases: [
        caseResult('inspect-task', 'Inspect task', [receiptId('receipt-interaction-first'), receiptId('receipt-observation-first')]),
        caseResult('inspect-second-task', 'Inspect second task', [receiptId('receipt-interaction-second'), receiptId('receipt-observation-second')]),
      ],
    })
    const inputs: Input[] = []
    let finalization = 0

    const run = await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'), manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable, maxFinalizationTurns: 1,
    }, {
      browserExecutablePath: browserPath,
      startThread: () => ({
        id: 'thread-receipt-batch',
        runStreamed: async (input, options) => {
          inputs.push(input)
          if (!options?.outputSchema) return twoCaseExecutionResponse('Both case episodes completed.')
          finalization += 1
          return streamedResponse(JSON.stringify(finalization === 1 ? batch : corrected))
        },
      }),
    })

    expect(run.result?.outcome).toBe('passed')
    expect(run.result?.cases.map((item) => item.executionReceiptIds)).toEqual([
      [receiptId('receipt-interaction-first'), receiptId('receipt-observation-first')],
      [receiptId('receipt-interaction-second'), receiptId('receipt-observation-second')],
    ])
    expect(JSON.stringify(inputs[2])).toContain('execution receipt belonging to another case')
  })

  it('delivers model infrastructure failures as a structured blocked result', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-blocked-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)

    const run = await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'),
      manifest: manifest('https://tasks.example.test'),
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
    }, {
      browserExecutablePath: browserPath,
      startThread: () => ({ id: 'thread-fixture', runStreamed: async () => failedStream('429 usage limit reached') }),
    })

    expect(run.state).toMatchObject({ status: 'completed', stage: 'completed', outcome: 'blocked', threadId: 'thread-fixture' })
    expect(run.result?.blockers).toContain('模型服务额度不足或调用频率受限。')
    expect(run.result?.blockers.join(' ')).not.toContain('429 usage limit reached')
    expect(run.result?.nextActions.join(' ')).toContain('原结果目录')
    expect(run.result?.cases[0]).toMatchObject({ failureSource: 'infrastructure', failureKind: 'execution' })
    expect(run.result?.cases[0]?.evidence).not.toHaveLength(0)
  })

  it('recovers a complete same-thread delivery artifact after final JSON transport fails', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-delivery-recovery-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)
    const outputDirectory = resolve(directory, 'run')
    const workflow = manifest('https://tasks.example.test')

    const run = await runCodexTestAgent({
      outputDirectory,
      manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
    }, {
      browserExecutablePath: browserPath,
      startThread: () => ({
        id: 'thread-fixture',
        runStreamed: async (_input, options) => {
          if (options?.outputSchema) return failedStream('stream disconnected before completion')
          const workspace = resolve(outputDirectory, 'agent-workspace')
          await mkdir(resolve(workspace, 'evidence'), { recursive: true })
          await writeFile(resolve(workspace, 'evidence', 'observed.md'), 'observed')
          await writeFile(resolve(workspace, 'case-results.json'), JSON.stringify({
            version: '1.0',
            kind: 'case-results',
            workflowId: workflow.workflowId,
            sourceSha256: workflow.source.sha256,
            generatedAt: '2026-08-03T00:01:00.000Z',
            cases: [{
              caseId: 'inspect-task', title: 'Inspect task', outcome: 'passed', summary: 'Observed.', evidencePaths: ['evidence/observed.md'], executionReceiptIds: [receiptId('receipt-interaction'), receiptId('receipt-observation')],
            }],
            mutationLedger: { state: 'terminal', pendingCount: 0, entries: [] },
          }))
          return streamedResponse('Execution complete.')
        },
      }),
    })

    expect(run.result).toMatchObject({ outcome: 'passed', summary: expect.stringContaining('Recovered Codex delivery artifact') })
    expect(run.result?.cases[0]?.evidence[0]?.path).toBe('evidence/observed.md')
  })

  it('executes a long suite in isolated case windows and aggregates only validated case facts', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-case-windows-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)
    const workflow = twoCaseManifest('https://tasks.example.test')
    const initialPrompts: string[] = []
    let startedThreads = 0

    const run = await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'),
      manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
      caseBatchSize: 1,
    }, {
      browserExecutablePath: browserPath,
      startThread: () => {
        const batchIndex = startedThreads++
        const phase = workflow.phases[batchIndex]!
        const suffix = batchIndex === 0 ? 'first' : 'second'
        let turn = 0
        return {
          id: null,
          runStreamed: async (input, options) => {
            turn++
            if (turn === 1) initialPrompts.push(typeof input === 'string'
              ? input
              : input.filter((item) => item.type === 'text').map((item) => item.text).join('\n'))
            if (options?.outputSchema) {
              const scoped = { ...workflow, phases: [phase] }
              return singleCaseExecutionResponse(JSON.stringify(finalResult(scoped, {
                cases: [{
                  caseId: phase.id,
                  title: phase.title,
                  outcome: 'passed',
                  summary: `Observed ${phase.id}.`,
                  executionReceiptIds: [receiptId(`receipt-interaction-${suffix}`, `batch-${String(batchIndex + 1).padStart(4, '0')}`), receiptId(`receipt-observation-${suffix}`, `batch-${String(batchIndex + 1).padStart(4, '0')}`)],
                  evidence: [{ kind: 'observation', description: `Observed ${phase.id}.` }],
                }],
              })), phase.id, suffix)
            }
            return singleCaseExecutionResponse('Window work complete.', phase.id, suffix)
          },
        }
      },
    })

    expect(startedThreads).toBe(2)
    expect(initialPrompts[0]).toContain('"id": "inspect-task"')
    expect(initialPrompts[0]).not.toContain('"id": "inspect-second-task"')
    expect(initialPrompts[1]).toContain('"id": "inspect-second-task"')
    expect(initialPrompts[1]).not.toContain('"id": "inspect-task"')
    expect(run.state).toMatchObject({
      status: 'completed', executionMode: 'case_windows', caseBatchSize: 1, caseBatchCount: 2,
      completedBatchIds: ['batch-0001', 'batch-0002'],
    })
    expect(run.result?.cases.map((item) => [item.caseId, item.outcome])).toEqual([
      ['inspect-task', 'passed'],
      ['inspect-second-task', 'passed'],
    ])
    expect(run.result?.cases[0]?.executionReceiptIds).toEqual([receiptId('receipt-interaction-first', 'batch-0001'), receiptId('receipt-observation-first', 'batch-0001')])
    expect(run.result?.cases[1]?.executionReceiptIds).toEqual([receiptId('receipt-interaction-second', 'batch-0002'), receiptId('receipt-observation-second', 'batch-0002')])
  })

  it('keeps a multi-case suite in one native Codex thread by default', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-native-suite-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)
    const workflow = twoCaseManifest('https://tasks.example.test')
    const prompts: string[] = []
    let startedThreads = 0

    const run = await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'),
      manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
    }, {
      browserExecutablePath: browserPath,
      startThread: () => {
        startedThreads += 1
        return {
          id: 'thread-native-suite',
          runStreamed: async (input) => {
            prompts.push(typeof input === 'string'
              ? input
              : input.filter((item) => item.type === 'text').map((item) => item.text).join('\n'))
            return twoCaseExecutionResponse(JSON.stringify(finalResult(workflow, {
              cases: [
                {
                  caseId: 'inspect-task', title: 'Inspect task', outcome: 'passed', summary: 'Observed first case.',
                  executionReceiptIds: [receiptId('receipt-interaction-first'), receiptId('receipt-observation-first')],
                  evidence: [{ kind: 'observation', description: 'Observed first case.' }],
                },
                {
                  caseId: 'inspect-second-task', title: 'Inspect second task', outcome: 'passed', summary: 'Observed second case.',
                  executionReceiptIds: [receiptId('receipt-interaction-second'), receiptId('receipt-observation-second')],
                  evidence: [{ kind: 'observation', description: 'Observed second case.' }],
                },
              ],
            })))
          },
        }
      },
    })

    expect(startedThreads).toBe(1)
    expect(prompts[0]).toContain('native persistent Codex context')
    expect(prompts[0]).toContain('inspect-task')
    expect(prompts[0]).toContain('inspect-second-task')
    expect(run.state).toMatchObject({ status: 'completed', executionMode: 'single_thread' })
    expect(run.result?.cases.map((item) => item.outcome)).toEqual(['passed', 'passed'])
  })

  it('does not require case bookkeeping calls for native Codex delivery', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-native-passive-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)
    const workflow = manifest('https://tasks.example.test')

    const run = await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'),
      manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
      maxFinalizationTurns: 0,
    }, {
      browserExecutablePath: browserPath,
      startThread: () => ({
        id: 'thread-native-no-bookkeeping',
        runStreamed: async (_input, options) => options?.outputSchema
          ? streamedResponse(JSON.stringify(finalResult(workflow, {
              cases: [{
                caseId: 'inspect-task', title: 'Inspect task', outcome: 'passed', summary: 'Observed without journal calls.',
                evidence: [{ kind: 'observation', description: 'Case-specific live state was observed.' }],
              }],
            })), { threadId: 'thread-native-no-bookkeeping', includeCaseBookkeeping: false })
          : streamedResponse('Native execution complete.', { threadId: 'thread-native-no-bookkeeping', includeCaseBookkeeping: false }),
      }),
    })

    expect(run.result?.outcome).toBe('passed')
    expect(run.result?.cases[0]?.executionReceiptIds).toBeUndefined()
  })

  it('resumes only the interrupted case window without replaying completed windows', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-case-window-resume-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)
    const outputDirectory = resolve(directory, 'run')
    const workflow = twoCaseManifest('https://tasks.example.test')
    let startedThreads = 0

    const interrupted = await runCodexTestAgent({
      outputDirectory,
      manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
      caseBatchSize: 1,
    }, {
      browserExecutablePath: browserPath,
      startThread: () => {
        const batchIndex = startedThreads++
        const phase = workflow.phases[batchIndex]!
        if (batchIndex === 1) {
          return { id: null, runStreamed: async () => failedStream('network connection lost', 'thread-second-window') }
        }
        let turn = 0
        return {
          id: null,
          runStreamed: async (_input, options) => {
            turn++
            if (options?.outputSchema) {
              const scoped = { ...workflow, phases: [phase] }
              return singleCaseExecutionResponse(JSON.stringify(finalResult(scoped, {
                cases: [{
                  caseId: phase.id, title: phase.title, outcome: 'passed', summary: 'Observed first window.',
                  executionReceiptIds: [receiptId('receipt-interaction-first-resume', 'batch-0001'), receiptId('receipt-observation-first-resume', 'batch-0001')],
                  evidence: [{ kind: 'observation', description: 'Observed first window.' }],
                }],
              })), phase.id, 'first-resume')
            }
            return singleCaseExecutionResponse(`First window turn ${turn}.`, phase.id, 'first-resume')
          },
        }
      },
    })

    expect(interrupted.result?.outcome).toBe('blocked')
    expect(interrupted.state).toMatchObject({
      executionMode: 'case_windows', completedBatchIds: ['batch-0001'],
      activeBatch: { id: 'batch-0002', stage: 'executing', threadId: 'thread-second-window' },
    })
    const savedFirstBatch = JSON.parse(await readFile(resolve(outputDirectory, '.agent-private', 'case-batches', 'batch-0001.result.json'), 'utf8')) as CodexTestAgentResult
    expect(savedFirstBatch.cases).toHaveLength(1)
    expect(savedFirstBatch.environmentRequirements).toEqual([])

    const startThread = vi.fn(() => { throw new Error('completed windows must not restart') })
    const resumeThread = vi.fn((options: { threadId: string }) => {
      const phase = workflow.phases[1]!
      return {
        id: options.threadId,
        runStreamed: async (_input: Input, turnOptions?: { outputSchema?: unknown }) => {
          if (turnOptions?.outputSchema) {
            const scoped = { ...workflow, phases: [phase] }
            return singleCaseExecutionResponse(JSON.stringify(finalResult(scoped, {
              cases: [{
                caseId: phase.id, title: phase.title, outcome: 'passed', summary: 'Observed resumed window.',
                executionReceiptIds: [receiptId('receipt-interaction-second-resume', 'batch-0002'), receiptId('receipt-observation-second-resume', 'batch-0002')],
                evidence: [{ kind: 'observation', description: 'Observed resumed window.' }],
              }],
            })), phase.id, 'second-resume')
          }
          return singleCaseExecutionResponse('Resumed window complete.', phase.id, 'second-resume')
        },
      }
    })
    const resumed = await runCodexTestAgent({
      outputDirectory,
      manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
      caseBatchSize: 1,
      resume: true,
    }, { browserExecutablePath: browserPath, startThread, resumeThread })

    expect(resumed.state.error).toBeUndefined()
    expect(startThread).not.toHaveBeenCalled()
    expect(resumeThread).toHaveBeenCalledOnce()
    expect(resumeThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-second-window' }))
    expect(resumed.state).toMatchObject({ status: 'completed', completedBatchIds: ['batch-0001', 'batch-0002'] })
    expect(resumed.result?.cases.map((item) => item.outcome)).toEqual(['passed', 'passed'])
  })

  it('finalizes a complete blocked run artifact on resume without restarting Codex or Chromium', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-fast-resume-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)
    const outputDirectory = resolve(directory, 'run')
    const workflow = manifest('https://tasks.example.test')
    const profile = {
      id: 'fixture', origins: ['https://tasks.example.test'], auth: [],
      policy: { allowWrite: false, allowDestructive: false },
    }

    await runCodexTestAgent({
      outputDirectory,
      manifest: workflow,
      profile,
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
    }, {
      browserExecutablePath: browserPath,
      startThread: () => ({ id: 'thread-resume-artifact', runStreamed: async () => failedStream('network connection lost', 'thread-resume-artifact') }),
    })

    const workspace = resolve(outputDirectory, 'agent-workspace')
    await mkdir(resolve(workspace, 'evidence'), { recursive: true })
    await writeFile(resolve(workspace, 'evidence', 'observed.md'), 'observed')
    await writeFile(resolve(workspace, 'execution-receipts.json'), JSON.stringify([
      { id: 'receipt-interaction', caseId: 'inspect-task', tool: 'browser_click', kind: 'interaction', status: 'completed', recordedAt: '2026-08-03T00:00:00.000Z' },
      { id: 'receipt-observation', caseId: 'inspect-task', tool: 'browser_snapshot', kind: 'observation', status: 'completed', recordedAt: '2026-08-03T00:00:01.000Z' },
    ]))
    await writeFile(resolve(workspace, 'case-results.json'), JSON.stringify({
      version: '1.0',
      kind: 'case-results',
      workflowId: workflow.workflowId,
      sourceSha256: workflow.source.sha256,
      generatedAt: '2026-08-03T00:01:00.000Z',
      cases: [{
        caseId: 'inspect-task', title: 'Inspect task', outcome: 'passed', summary: 'Observed.',
        evidencePaths: ['evidence/observed.md'], executionReceiptIds: ['receipt-interaction', 'receipt-observation'],
      }],
      mutationLedger: { state: 'terminal', pendingCount: 0, entries: [] },
    }))

    const resumeThread = vi.fn(() => {
      throw new Error('resumeThread must not be called for a complete delivery artifact')
    })
    const resumed = await runCodexTestAgent({
      outputDirectory,
      manifest: workflow,
      profile,
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
      resume: true,
    }, {
      browserExecutablePath: resolve(directory, 'missing-chromium'),
      resumeThread,
    })

    expect(resumeThread).not.toHaveBeenCalled()
    expect(resumed.state).toMatchObject({ status: 'completed', stage: 'completed', outcome: 'passed', threadId: 'thread-resume-artifact' })
    expect(resumed.result).toMatchObject({ outcome: 'passed', summary: expect.stringContaining('Recovered Codex delivery artifact') })
    expect(resumed.result?.cases[0]?.executionReceiptIds).toEqual(['receipt-interaction', 'receipt-observation'])
  })

  it('resumes the same persistent thread and preserves pending mutation recovery state', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-resume-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)
    const outputDirectory = resolve(directory, 'run')
    const workflow = manifest('https://tasks.example.test', 'write')
    const profile = {
      id: 'fixture', origins: ['https://tasks.example.test'], auth: [],
      policy: { allowWrite: true, allowDestructive: false },
    }

    const interrupted = await runCodexTestAgent({
      outputDirectory,
      manifest: workflow,
      profile,
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
    }, {
      browserExecutablePath: browserPath,
      startThread: () => ({ id: 'thread-resume', runStreamed: async () => failedStream('network connection lost', 'thread-resume') }),
    })
    expect(interrupted.result?.outcome).toBe('blocked')

    const statePath = resolve(outputDirectory, 'codex-agent.state.json')
    const interruptedState = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
    delete interruptedState.threadId
    await writeFile(statePath, JSON.stringify(interruptedState))

    const ledgerPath = resolve(outputDirectory, '.agent-private', 'mutation-ledger.json')
    const evidencePath = resolve(outputDirectory, 'agent-workspace', 'evidence-index.json')
    const planPath = resolve(outputDirectory, 'agent-workspace', 'execution-plan.json')
    const caseResultsPath = resolve(outputDirectory, 'agent-workspace', 'case-results.json')
    await writeFile(ledgerPath, JSON.stringify([{
      id: 'pending-action', caseId: 'inspect-task', description: 'Recover exact task update', risk: 'write', status: 'pending',
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', evidence: [],
    }]))
    await writeFile(evidencePath, JSON.stringify([{
      caseId: 'inspect-task', kind: 'observation', description: 'Evidence recorded before interruption.',
    }]))
    await writeFile(planPath, JSON.stringify({
      summary: 'Recover pending action',
      steps: [{ id: 'recover', title: 'Recover pending action', status: 'in_progress', evidenceRequired: 'Terminal state' }],
    }))

    let resumedThreadId = ''
    let recoveryPrompt = ''
    const resumed = await runCodexTestAgent({
      outputDirectory,
      manifest: workflow,
      profile,
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
      resume: true,
    }, {
      browserExecutablePath: browserPath,
      resumeThread: (options) => {
        resumedThreadId = options.threadId
        return {
          id: options.threadId,
          runStreamed: async (input, turnOptions) => {
            if (turnOptions?.outputSchema) return streamedResponse(JSON.stringify(finalResult(workflow)))
            if (!recoveryPrompt) recoveryPrompt = JSON.stringify(input)
            await writeFile(ledgerPath, JSON.stringify([{
              id: 'pending-action', caseId: 'inspect-task', description: 'Recover exact task update', risk: 'write', status: 'compensated',
              createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:01:00.000Z', evidence: ['Verified restored state'],
            }]))
            await writeFile(evidencePath, JSON.stringify([
              { caseId: 'inspect-task', kind: 'observation', description: 'Evidence recorded before interruption.' },
              { caseId: 'inspect-task', kind: 'mutation', description: 'Verified restored state.' },
            ]))
            await writeFile(planPath, JSON.stringify({
              summary: 'Recovered',
              steps: [{ id: 'recover', title: 'Recover pending action', status: 'passed', evidenceRequired: 'Terminal state' }],
            }))
            return streamedResponse('Recovery complete.')
          },
        }
      },
    })

    expect(resumedThreadId).toBe('thread-resume')
    expect(recoveryPrompt).toContain('Resume the interrupted Auto-Test execution')
    expect(recoveryPrompt).not.toContain('initial evidence-driven plan')
    expect(resumed.result?.outcome).toBe('passed')
    expect(resumed.result?.mutations).toContainEqual(expect.objectContaining({ id: 'pending-action', status: 'compensated' }))
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as Array<{ description: string }>
    expect(evidence.map((item) => item.description)).toContain('Evidence recorded before interruption.')
  })

  it('resumes a case-batch-size run that crashed before its execution mode was persisted', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-resume-prep-crash-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)
    const outputDirectory = resolve(directory, 'run')
    const workflow = manifest('https://tasks.example.test')
    const profile = { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } }

    // A missing codex executable makes the first run fail during preparation,
    // before executionMode is ever persisted. State is left with executionMode undefined.
    const crashed = await runCodexTestAgent({
      outputDirectory,
      manifest: workflow,
      profile,
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome,
      codexExecutable: resolve(directory, 'missing-codex'),
      caseBatchSize: 1,
    }, { browserExecutablePath: browserPath })
    expect(crashed.state.status).toBe('failed')
    expect(crashed.state.executionMode).toBeUndefined()

    // Resuming with the original --case-batch-size must not trip the
    // "cannot switch to case-window mode" guard.
    let startedThreads = 0
    const resumed = await runCodexTestAgent({
      outputDirectory,
      manifest: workflow,
      profile,
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
      caseBatchSize: 1,
      resume: true,
    }, {
      browserExecutablePath: browserPath,
      startThread: () => {
        const batchIndex = startedThreads++
        const phase = workflow.phases[batchIndex]!
        let turn = 0
        return {
          id: null,
          runStreamed: async (_input, options) => {
            turn++
            if (options?.outputSchema) {
              const scoped = { ...workflow, phases: [phase] }
              return singleCaseExecutionResponse(JSON.stringify(finalResult(scoped, {
                cases: [{
                  caseId: phase.id,
                  title: phase.title,
                  outcome: 'passed',
                  summary: `Observed ${phase.id}.`,
                  evidence: [{ kind: 'observation', description: `Observed ${phase.id}.` }],
                }],
              })), phase.id, 'resume-prep')
            }
            return singleCaseExecutionResponse('Window work complete.', phase.id, 'resume-prep')
          },
        }
      },
    })

    expect(startedThreads).toBe(1)
    expect(resumed.state).toMatchObject({ status: 'completed', executionMode: 'case_windows', caseBatchSize: 1 })
    expect(resumed.result?.outcome).toBe('passed')
  })

  it('recovers pending business writes on the native single-thread path before final delivery', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-native-mutation-recovery-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)
    const outputDirectory = resolve(directory, 'run')
    const workflow = manifest('https://tasks.example.test', 'write')
    const profile = { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: true, allowDestructive: false } }
    const ledgerPath = resolve(outputDirectory, '.agent-private', 'mutation-ledger.json')

    let recoveryPrompt = ''
    let nonSchemaTurn = 0
    const run = await runCodexTestAgent({
      outputDirectory,
      manifest: workflow,
      profile,
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
      maxFinalizationTurns: 0,
    }, {
      browserExecutablePath: browserPath,
      startThread: () => ({
        id: 'thread-native-mutation',
        runStreamed: async (input, options) => {
          if (options?.outputSchema) {
            return streamedResponse(JSON.stringify(finalResult(workflow, {
              cases: [{
                caseId: 'inspect-task', title: 'Inspect task', outcome: 'passed', summary: 'Observed after recovery.',
                evidence: [{ kind: 'observation', description: 'Live state verified after write recovery.' }],
              }],
            })))
          }
          nonSchemaTurn += 1
          if (nonSchemaTurn === 1) {
            // Execution turn: leave a pending business write.
            await writeFile(ledgerPath, JSON.stringify([{
              id: 'pending-write', caseId: 'inspect-task', description: 'Created a test record', risk: 'write', status: 'pending',
              createdAt: '2026-08-04T00:00:00.000Z', updatedAt: '2026-08-04T00:00:00.000Z', evidence: [],
            }]))
            return streamedResponse('Execution complete with a pending write.')
          }
          // Second non-schema turn is the recovery turn fired by the harness
          // because the Mutation Ledger still has a pending entry.
          recoveryPrompt = typeof input === 'string'
            ? input
            : input.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
          await writeFile(ledgerPath, JSON.stringify([{
            id: 'pending-write', caseId: 'inspect-task', description: 'Created a test record', risk: 'write', status: 'compensated',
            createdAt: '2026-08-04T00:00:00.000Z', updatedAt: '2026-08-04T00:01:00.000Z', evidence: ['Verified restored state'],
          }]))
          return streamedResponse('Recovery complete.')
        },
      }),
    })

    expect(recoveryPrompt).toContain('Resume the interrupted Auto-Test execution')
    expect(run.state).toMatchObject({ status: 'completed', executionMode: 'single_thread' })
    expect(run.result?.outcome).toBe('passed')
    expect(run.result?.mutations).toContainEqual(expect.objectContaining({ id: 'pending-write', status: 'compensated' }))
  })

  it('lets the Codex CLI finish its own reconnect sequence', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-reconnect-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)
    let turn = 0
    const workflow = manifest('https://tasks.example.test')

    const run = await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'),
      manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
    }, {
      browserExecutablePath: browserPath,
      startThread: () => ({
        id: 'thread-fixture',
        runStreamed: async (_input, options) => {
          turn += 1
          return options?.outputSchema
            ? streamedResponse(JSON.stringify(finalResult(workflow)))
            : reconnectingStreamText('Execution complete.')
        },
      }),
    })

    expect(run.result?.outcome).toBe('passed')
  })

  it('accepts a valid Codex result without framework plans, field gates, case checkpoints, or mandatory ledger entries', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-field-gate-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)
    const workflow = manifest('https://tasks.example.test', 'write')

    const run = await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'),
      manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: true, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
      maxFinalizationTurns: 0,
    }, {
      browserExecutablePath: browserPath,
      startThread: () => ({
        id: 'thread-thin-harness',
        runStreamed: async (_input, options) => options?.outputSchema
          ? streamedResponse(JSON.stringify(finalResult(workflow)))
          : streamedResponse('Execution complete.'),
      }),
    })

    expect(run.result?.outcome).toBe('passed')
    expect(run.result?.mutations).toEqual([])
  })

  it('keeps unknown framework exceptions as failed instead of misclassifying them as a business block', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-failed-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)

    const run = await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'),
      manifest: manifest('https://tasks.example.test'),
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
    }, {
      browserExecutablePath: browserPath,
      startThread: () => { throw new Error('unexpected invariant violation') },
    })

    expect(run.state).toMatchObject({ status: 'failed', stage: 'failed', error: 'unexpected invariant violation' })
    expect(run.result).toBeUndefined()
  })

  it('refuses to overwrite a prior run directory', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-existing-'))
    directories.push(directory)
    const outputDirectory = resolve(directory, 'run')
    await mkdir(outputDirectory)
    await writeFile(resolve(outputDirectory, 'codex-agent.state.json'), '{}')

    await expect(runCodexTestAgent({
      outputDirectory,
      manifest: manifest('https://tasks.example.test'),
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false,
    })).rejects.toThrow(/already contains Codex agent state/i)
  })
})
