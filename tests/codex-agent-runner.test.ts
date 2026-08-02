import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Input, ThreadEvent } from '@openai/codex-sdk'
import { CodexTestProgressReporter, progressFromThreadEvent } from '../src/agent/progress.js'
import { runCodexTestAgent } from '../src/agent/runner.js'
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

function streamedResponse(response: string): { events: AsyncGenerator<ThreadEvent> } {
  return {
    events: (async function* () {
      yield { type: 'thread.started', thread_id: 'thread-fixture' } as ThreadEvent
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
      yield { type: 'error', message: 'Reconnecting... 1/5 (temporary upstream issue)' } as ThreadEvent
      yield { type: 'item.completed', item: { id: 'message', type: 'agent_message', text: response } } as ThreadEvent
      yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } } as ThreadEvent
    })(),
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

    expect(started?.message).toContain('填写页面表单')
    expect(completed?.message).toContain('Execution Plan')
    expect(agentMessage?.message).toContain('本轮执行说明')
    expect(JSON.stringify([started, completed, agentMessage])).not.toContain(secret)
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
    let turn = 0
    let controlConfigPath = ''
    const executionRunStreamed = vi.fn(async (input: Input, options?: { outputSchema?: unknown }) => {
      executionInputs.push(input)
      expect(options?.outputSchema).toBeUndefined()
      const control = JSON.parse(await readFile(controlConfigPath, 'utf8')) as { planPath: string; evidencePath: string; caseResultsPath: string }
      await writeFile(control.planPath, JSON.stringify({
        summary: 'Inspect task evidence',
        steps: [{ id: 'inspect', title: 'Inspect task', status: 'passed', evidenceRequired: 'Task details' }],
      }))
      await writeFile(control.evidencePath, JSON.stringify([{
        caseId: 'inspect-task', kind: 'observation', description: 'The expected owner and state were visible.',
      }]))
      if (turn++ > 0) {
        await writeFile(control.caseResultsPath, JSON.stringify([{
          caseId: 'inspect-task', outcome: 'passed', summary: 'Expected details were visible.',
          blockers: [], productDefects: [], recordedAt: '2026-08-01T00:01:00.000Z',
        }]))
      }
      return streamedResponse('Execution delivery updated.')
    })

    const run = await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'),
      manifest: manifest('https://tasks.example.test'),
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
      onProgress: (progress) => progressMessages.push(progress.message),
    }, {
      browserExecutablePath: browserPath,
      startThread: (options) => {
        controlConfigPath = options.controlConfigPath
        return { id: 'thread-fixture', runStreamed: executionRunStreamed }
      },
    })

    expect(run.result?.outcome).toBe('passed')
    expect(run.result?.cases[0]?.failureSource).toBeUndefined()
    expect(run.result?.cases[0]?.failureKind).toBeUndefined()
    expect(executionRunStreamed).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(executionInputs[0])).toContain('Do not produce the structured final result')
    expect(JSON.stringify(executionInputs[1])).toContain('missing final case decision')
    expect(progressMessages).toContain('Codex 测试线程已建立；中断后可以从本次结果目录恢复')
    expect(progressMessages).toContain('结构化测试结果已生成：passed')
    const events = await readFile(resolve(directory, 'run', 'codex-agent.events.jsonl'), 'utf8')
    expect(events.trim().split('\n')).toHaveLength(6)
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
    expect(run.result?.blockers).toContain('429 usage limit reached')
    expect(run.result?.cases[0]).toMatchObject({ failureSource: 'environment', failureKind: 'environment' })
    expect(run.result?.cases[0]?.evidence).not.toHaveLength(0)
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
          runStreamed: async (input) => {
            recoveryPrompt = JSON.stringify(input)
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
            await writeFile(caseResultsPath, JSON.stringify([{
              caseId: 'inspect-task', outcome: 'passed', summary: 'Recovered and verified.', blockers: [], productDefects: [],
              recordedAt: '2026-08-01T00:01:00.000Z',
            }]))
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

  it('lets the Codex CLI finish its own reconnect sequence', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-reconnect-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)
    let controlConfigPath = ''

    const run = await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'),
      manifest: manifest('https://tasks.example.test'),
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
    }, {
      browserExecutablePath: browserPath,
      startThread: (options) => {
        controlConfigPath = options.controlConfigPath
        return {
          id: 'thread-fixture',
          runStreamed: async () => {
            const control = JSON.parse(await readFile(controlConfigPath, 'utf8')) as { planPath: string; evidencePath: string; caseResultsPath: string }
            await writeFile(control.planPath, JSON.stringify({ steps: [{ id: 'inspect', status: 'passed' }] }))
            await writeFile(control.evidencePath, JSON.stringify([{ caseId: 'inspect-task', kind: 'observation', description: 'Evidence' }]))
            await writeFile(control.caseResultsPath, JSON.stringify([{
              caseId: 'inspect-task', outcome: 'passed', summary: 'Expected details were visible.',
              blockers: [], productDefects: [], recordedAt: '2026-08-01T00:01:00.000Z',
            }]))
            return reconnectingStreamText('Execution complete.')
          },
        }
      },
    })

    expect(run.result?.outcome).toBe('passed')
  })

  it('downgrades an unverified product validation claim to blocked', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-field-gate-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const browserPath = resolve(directory, 'chromium')
    await writeFile(browserPath, '')
    const codexExecutable = await fakeCodexExecutable(directory)
    let controlConfigPath = ''

    const run = await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'),
      manifest: manifest('https://tasks.example.test'),
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, codexHome: sourceHome, codexExecutable,
      maxFinalizationTurns: 0,
    }, {
      browserExecutablePath: browserPath,
      startThread: (options) => {
        controlConfigPath = options.controlConfigPath
        return {
          id: 'thread-field-gate',
          runStreamed: async () => {
            const control = JSON.parse(await readFile(controlConfigPath, 'utf8')) as {
              planPath: string; evidencePath: string; caseResultsPath: string; fieldCompositionPath: string
            }
            await writeFile(control.planPath, JSON.stringify({ steps: [{ id: 'submit', status: 'failed' }] }))
            await writeFile(control.evidencePath, JSON.stringify([{ caseId: 'inspect-task', kind: 'observation', description: 'Validation error visible.' }]))
            await writeFile(control.fieldCompositionPath, JSON.stringify([{
              id: 'inspect-task:value', caseId: 'inspect-task', fieldId: 'value', status: 'blocked',
            }]))
            await writeFile(control.caseResultsPath, JSON.stringify([{
              caseId: 'inspect-task', outcome: 'product_failed', summary: 'The application rejected the value.',
              blockers: [], productDefects: ['Validation rejected the value.'], failureSource: 'product', failureKind: 'validation',
              fieldGateIds: ['inspect-task:value'], recordedAt: '2026-08-01T00:01:00.000Z',
            }]))
            return streamedResponse('Execution complete.')
          },
        }
      },
    })

    expect(run.result?.outcome).toBe('blocked')
    expect(run.result?.cases[0]?.outcome).toBe('blocked')
    expect(run.result?.cases[0]?.failureSource).toBe('agent_execution')
    expect(run.result?.productDefects).toEqual([])
    expect(run.result?.blockers.join(' ')).toContain('lacks a passed composite-field gate')
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
