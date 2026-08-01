import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Input, ThreadEvent } from '@openai/codex-sdk'
import { runCodexTestAgent } from '../src/agent/runner.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'

const directories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function manifest(origin: string): WorkflowIntakeManifest {
  return {
    version: '1.0', kind: 'workflow-intake', workflowId: 'runner-fixture',
    source: { format: 'xlsx', fileName: 'runner.xlsx', sheetName: 'Cases', sha256: 'c'.repeat(64) },
    targetUrls: [`${origin}/tasks`], requiredCapabilities: [],
    phases: [{
      id: 'inspect-task', title: 'Inspect task', sourceRow: 2, risk: 'read',
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

function failedStream(message: string): { events: AsyncGenerator<ThreadEvent> } {
  return {
    events: (async function* () {
      yield { type: 'thread.started', thread_id: 'thread-fixture' } as ThreadEvent
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
    }, {
      browserExecutablePath: browserPath,
      startThread: (options) => {
        controlConfigPath = options.controlConfigPath
        return { id: 'thread-fixture', runStreamed: executionRunStreamed }
      },
    })

    expect(run.result?.outcome).toBe('passed')
    expect(executionRunStreamed).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(executionInputs[0])).toContain('Do not produce the structured final result')
    expect(JSON.stringify(executionInputs[1])).toContain('missing final case decision')
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

    expect(run.state).toMatchObject({ status: 'completed', stage: 'completed', outcome: 'blocked' })
    expect(run.result?.blockers).toContain('429 usage limit reached')
    expect(run.result?.cases[0]?.evidence).not.toHaveLength(0)
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
