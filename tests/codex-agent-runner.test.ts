import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ThreadEvent } from '@openai/codex-sdk'
import { buildCodexExecutionEpochs } from '../src/agent/execution-epochs.js'
import { runCodexTestAgent } from '../src/agent/runner.js'
import type { CodexTestAgentResult } from '../src/agent/types.js'
import type { ModelProfile } from '../src/workflow/model-profile.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function manifest(): WorkflowIntakeManifest {
  return {
    version: '1.0', kind: 'workflow-intake', workflowId: 'adaptive-fixture',
    source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'a'.repeat(64) },
    targetUrls: ['https://tasks.example.test/'], requiredCapabilities: [],
    phases: [
      { id: 'case-one', title: '第一条', sourceRow: 2, risk: 'read', steps: [{ id: 'step-one', sourceText: '观察第一条', confidence: 1 }], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
      { id: 'case-two', title: '第二条', sourceRow: 3, risk: 'read', steps: [{ id: 'step-two', sourceText: '观察第二条', confidence: 1 }], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
    ],
    embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
  }
}

function eventStream(text: string, threadId: string, metadataWarning = false): { events: AsyncGenerator<ThreadEvent> } {
  return {
    events: (async function* () {
      yield { type: 'thread.started', thread_id: threadId } as ThreadEvent
      if (metadataWarning) {
        yield {
          type: 'item.completed',
          item: {
            id: `metadata-${threadId}`,
            type: 'error',
            message: 'Model metadata for `fixture` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
          },
        } as ThreadEvent
      }
      yield { type: 'item.completed', item: { id: `message-${threadId}`, type: 'agent_message', text } } as ThreadEvent
      yield { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 8 } } as ThreadEvent
    })(),
  }
}

function failedEventStream(message: string, threadId: string, artifactText?: string): { events: AsyncGenerator<ThreadEvent> } {
  return {
    events: (async function* () {
      yield { type: 'thread.started', thread_id: threadId } as ThreadEvent
      if (artifactText) yield { type: 'item.completed', item: { id: `artifact-${threadId}`, type: 'agent_message', text: artifactText } } as ThreadEvent
      yield { type: 'error', message } as ThreadEvent
    })(),
  }
}

function resultFor(workflow: WorkflowIntakeManifest, caseIds: string[]): string {
  const cases = caseIds.map((caseId) => {
    const phase = workflow.phases.find((item) => item.id === caseId)!
    return { caseId, title: phase.title, outcome: 'passed' as const, summary: `已验证 ${caseId}`, evidence: [{ kind: 'observation' as const, description: `现场观察 ${caseId}` }] }
  })
  const result: CodexTestAgentResult = {
    version: '1.0', workflowId: workflow.workflowId, sourceSha256: workflow.source.sha256, outcome: 'passed', summary: '完成',
    startedAt: '2026-08-05T00:00:00.000Z', finishedAt: '2026-08-05T00:01:00.000Z', cases, mutations: [], environmentRequirements: [], blockers: [], productDefects: [], nextActions: [],
  }
  return JSON.stringify(result)
}

function profile(): ModelProfile {
  return {
    id: 'fixture', model: 'fixture', providerId: 'fixture', baseUrl: 'https://provider.example.test', api: 'openai-responses', envKey: 'FIXTURE_KEY', envKeyAliases: ['FIXTURE_ALIAS_KEY'],
    reasoningEffort: 'high', supportsWebsockets: false,
    contextWindowTokens: 1_000, maxOutputTokens: 100, caseOutputTokens: 100, targetContextRatio: 0.5, targetOutputRatio: 0.5,
  }
}

async function fixtureFiles(directory: string): Promise<{ sourceHome: string; browserPath: string; codexExecutable: string }> {
  const sourceHome = resolve(directory, 'source-home')
  await mkdir(sourceHome)
  await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
  const browserPath = resolve(directory, 'chromium')
  await writeFile(browserPath, '')
  const codexPackage = createRequire(import.meta.url).resolve('@openai/codex/package.json')
  const codexExecutable = resolve(dirname(codexPackage), 'bin', 'codex.js')
  return { sourceHome, browserPath, codexExecutable }
}

async function createInterruptedExecution(
  directory: string,
  workflow: WorkflowIntakeManifest,
  files: Awaited<ReturnType<typeof fixtureFiles>>,
): Promise<{ outputDirectory: string; threadGeneration: number }> {
  const outputDirectory = resolve(directory, 'run')
  const run = await runCodexTestAgent({
    outputDirectory, manifest: workflow,
    profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: true, allowDestructive: false } },
    secrets: {}, environmentContext: '', imagePaths: [], headed: false,
    agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable,
    modelProfile: profile(), environment: { FIXTURE_KEY: 'fixture-key' },
  }, {
    browserExecutablePath: files.browserPath,
    startThread: () => ({
      id: 'thread-old',
      runStreamed: async () => failedEventStream('network connection lost', 'thread-old'),
    }),
  })
  expect(run.result?.outcome).toBe('blocked')
  expect(run.state.activeEpoch).toMatchObject({ id: 'epoch-0001', stage: 'executing', threadId: 'thread-old' })
  return { outputDirectory, threadGeneration: run.state.threadGeneration }
}

async function removeSessionBindingFingerprint(outputDirectory: string): Promise<void> {
  const statePath = resolve(outputDirectory, 'codex-agent.state.json')
  const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
  delete state.sessionBindingFingerprint
  await writeFile(statePath, JSON.stringify(state))
}

describe('adaptive Codex epochs', () => {
  it('plans capacity-bounded epochs without a fixed case count', () => {
    const workflow = manifest()
    const epochs = buildCodexExecutionEpochs(workflow, {
      contextWindowTokens: 1_000, maxOutputTokens: 100, caseOutputTokens: 100, targetContextRatio: 0.5, targetOutputRatio: 0.5,
    })
    expect(epochs).toHaveLength(2)
    expect(epochs.map((epoch) => epoch.caseIds)).toEqual([['case-one'], ['case-two']])
    expect(epochs.map((epoch) => epoch.id)).toEqual(['epoch-0001', 'epoch-0002'])
  })

  it('persists per-case facts and rotates the physical Codex thread at an epoch boundary', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-adaptive-epochs-'))
    directories.push(directory)
    const workflow = manifest()
    const files = await fixtureFiles(directory)
    const started: string[] = []
    const prompts: string[] = []
    const launches: Array<Record<string, unknown>> = []
    const run = await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'), manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable, modelProfile: profile(), environment: { FIXTURE_ALIAS_KEY: 'fixture-key' },
    }, {
      browserExecutablePath: files.browserPath,
      startThread: (options) => {
        launches.push(options)
        const epochIndex = started.length
        const threadId = `thread-${epochIndex + 1}`
        started.push(threadId)
        let turn = 0
        return {
          id: threadId,
          runStreamed: async (input, options) => {
            turn += 1
            prompts.push(typeof input === 'string' ? input : input.filter((item) => item.type === 'text').map((item) => item.text).join('\n'))
            if (options?.outputSchema) {
              const epochCases = epochIndex === 0 ? ['case-one'] : ['case-two']
              return eventStream(resultFor(workflow, epochCases), threadId, turn === 1)
            }
            return eventStream('执行完成', threadId, turn === 1)
          },
        }
      },
    })

    expect(run.result?.outcome).toBe('passed')
    expect(run.result?.cases.map((item) => item.caseId)).toEqual(['case-one', 'case-two'])
    expect(started).toEqual(['thread-1', 'thread-2'])
    expect(launches[0]).toMatchObject({
      wireApi: 'responses', reasoningEffort: 'high', modelContextWindow: 1_000, supportsWebsockets: false,
    })
    expect(launches[0]?.additionalDirectories).toEqual([resolve(directory, 'run', '.agent-private')])
    expect(prompts.some((prompt) => prompt.includes('checkpoint'))).toBe(true)
    expect(run.state.version).toBe('2.0')
    expect(run.state.threadGeneration).toBe(2)
    expect(run.state.completedCaseIds).toEqual(['case-one', 'case-two'])
    const recordsDirectory = resolve(directory, 'run', '.agent-private', 'case-results')
    expect((await readFile(resolve(recordsDirectory, 'does-not-exist'), 'utf8').catch(() => '')).length).toBe(0)
    expect((await readFile(resolve(directory, 'run', '.agent-private', 'execution-epochs', 'epoch-0001.result.json'), 'utf8')).length).toBeGreaterThan(0)
  })

  it('resumes only the active epoch and does not replay completed case records', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-adaptive-resume-'))
    directories.push(directory)
    const workflow = manifest()
    const files = await fixtureFiles(directory)
    const outputDirectory = resolve(directory, 'run')
    let started = 0
    const interrupted = await runCodexTestAgent({
      outputDirectory, manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable, modelProfile: profile(), environment: { FIXTURE_KEY: 'fixture-key' },
    }, {
      browserExecutablePath: files.browserPath,
      startThread: () => {
        const epochIndex = started++
        const threadId = `thread-${epochIndex + 1}`
        let turn = 0
        return {
          id: threadId,
          runStreamed: async (_input, options) => {
            turn += 1
            if (epochIndex === 1) return failedEventStream('network connection lost', threadId)
            return options?.outputSchema
              ? eventStream(resultFor(workflow, ['case-one']), threadId)
              : eventStream(turn === 3 ? 'checkpoint saved' : 'execution complete', threadId)
          },
        }
      },
    })

    expect(interrupted.result?.outcome).toBe('blocked')
    expect(interrupted.state.completedCaseIds).toEqual(['case-one'])
    expect(interrupted.state.activeEpoch).toMatchObject({ id: 'epoch-0002', caseIds: ['case-two'], threadId: 'thread-2' })
    const storeDirectory = resolve(outputDirectory, '.agent-private', 'case-results')
    const firstRecordPath = resolve(storeDirectory, (await readdir(storeDirectory))[0]!)
    const firstRecordBefore = await readFile(firstRecordPath, 'utf8')

    let resumedThreadId = ''
    const resumed = await runCodexTestAgent({
      outputDirectory, manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable, modelProfile: profile(), environment: { FIXTURE_KEY: 'fixture-key' }, resume: true,
    }, {
      browserExecutablePath: files.browserPath,
      startThread: () => { throw new Error('completed epochs must not restart') },
      resumeThread: ({ threadId }) => {
        resumedThreadId = threadId
        return {
          id: threadId,
          runStreamed: async (_input, options) => options?.outputSchema
            ? eventStream(resultFor(workflow, ['case-two']), threadId)
            : eventStream('resumed execution complete', threadId),
        }
      },
    })

    expect(resumedThreadId).toBe('thread-2')
    expect(resumed.result?.cases.map((item) => item.caseId)).toEqual(['case-one', 'case-two'])
    expect(await readFile(firstRecordPath, 'utf8')).toBe(firstRecordBefore)
  })

  it('rotates one incompatible physical session while preserving the logical run and pending Ledger', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-session-rotation-'))
    directories.push(directory)
    const workflow = manifest()
    workflow.phases = workflow.phases.slice(0, 1)
    workflow.phases[0]!.risk = 'write'
    const files = await fixtureFiles(directory)
    const interrupted = await createInterruptedExecution(directory, workflow, files)
    await removeSessionBindingFingerprint(interrupted.outputDirectory)
    const ledgerPath = resolve(interrupted.outputDirectory, '.agent-private', 'mutation-ledger.json')
    await writeFile(ledgerPath, JSON.stringify([{
      id: 'pending-before-provider-switch', caseId: 'case-one', description: 'Fixture write awaiting live reconciliation',
      risk: 'write', status: 'pending', createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z', evidence: [],
    }]))

    let resumedOld = 0
    let startedNew = 0
    const newThreadPrompts: string[] = []
    let stateObservedByNewThread: Record<string, unknown> | undefined
    let pendingLedgerObserved = false
    let newThreadTurn = 0
    const resumed = await runCodexTestAgent({
      outputDirectory: interrupted.outputDirectory, manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: true, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false,
      agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable,
      modelProfile: profile(), environment: { FIXTURE_KEY: 'fixture-key' }, resume: true,
    }, {
      browserExecutablePath: files.browserPath,
      resumeThread: ({ threadId }) => {
        resumedOld += 1
        expect(threadId).toBe('thread-old')
        return {
          id: threadId,
          runStreamed: async () => failedEventStream(
            'This session was recorded with model deepseek-v4-flash but is resuming with gpt-5.6-sol.',
            threadId,
          ),
        }
      },
      startThread: () => {
        startedNew += 1
        return {
          id: 'thread-new',
          runStreamed: async (input, options) => {
            const prompt = typeof input === 'string'
              ? input
              : input.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
            newThreadPrompts.push(prompt)
            if (newThreadTurn++ === 0) {
              stateObservedByNewThread = JSON.parse(await readFile(resolve(interrupted.outputDirectory, 'codex-agent.state.json'), 'utf8')) as Record<string, unknown>
              const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Array<Record<string, unknown>>
              pendingLedgerObserved = ledger[0]?.status === 'pending'
              await writeFile(ledgerPath, JSON.stringify([{ ...ledger[0], status: 'compensated', updatedAt: '2026-08-08T00:01:00.000Z' }]))
              return eventStream('Recovered the live state and reconciled the pending mutation.', 'thread-new')
            }
            return options?.outputSchema
              ? eventStream(resultFor(workflow, ['case-one']), 'thread-new')
              : eventStream('Recovery complete.', 'thread-new')
          },
        }
      },
    })

    expect(resumedOld).toBe(1)
    expect(startedNew).toBe(1)
    expect(newThreadPrompts[0]).toContain('Resume the interrupted Auto-Test execution')
    expect(pendingLedgerObserved).toBe(true)
    expect(stateObservedByNewThread).toMatchObject({
      threadId: 'thread-new',
      threadGeneration: interrupted.threadGeneration + 1,
      activeEpoch: { id: 'epoch-0001', caseIds: ['case-one'], stage: 'executing', threadId: 'thread-new' },
    })
    expect(resumed.state.threadGeneration).toBe(interrupted.threadGeneration + 1)
    expect(resumed.state.threadId).toBe('thread-new')
    expect(resumed.result?.outcome).toBe('passed')
    expect(resumed.result?.mutations).toContainEqual(expect.objectContaining({
      id: 'pending-before-provider-switch', status: 'compensated',
    }))
  })

  it('starts a recovery generation without touching the old session when the saved binding fingerprint changed', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-session-fingerprint-'))
    directories.push(directory)
    const workflow = manifest()
    workflow.phases = workflow.phases.slice(0, 1)
    const files = await fixtureFiles(directory)
    const interrupted = await createInterruptedExecution(directory, workflow, files)
    let resumedOld = 0
    let startedNew = 0
    const prompts: string[] = []
    let turn = 0
    const replacementProfile: ModelProfile = {
      ...profile(), id: 'replacement', providerId: 'replacement', model: 'replacement-model',
      baseUrl: 'https://replacement-provider.example.test',
    }

    const resumed = await runCodexTestAgent({
      outputDirectory: interrupted.outputDirectory, manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: true, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false,
      agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable,
      modelProfile: replacementProfile, environment: { FIXTURE_KEY: 'fixture-key' }, resume: true,
    }, {
      browserExecutablePath: files.browserPath,
      resumeThread: () => {
        resumedOld += 1
        throw new Error('a known incompatible binding must not resume the old physical session')
      },
      startThread: () => {
        startedNew += 1
        return {
          id: 'thread-fingerprint-replacement',
          runStreamed: async (input, options) => {
            prompts.push(typeof input === 'string'
              ? input
              : input.filter((item) => item.type === 'text').map((item) => item.text).join('\n'))
            if (turn++ === 0) return eventStream('Recovered from the saved run workspace.', 'thread-fingerprint-replacement')
            return options?.outputSchema
              ? eventStream(resultFor(workflow, ['case-one']), 'thread-fingerprint-replacement')
              : eventStream('Recovery complete.', 'thread-fingerprint-replacement')
          },
        }
      },
    })

    expect(resumedOld).toBe(0)
    expect(startedNew).toBe(1)
    expect(prompts[0]).toContain('Resume the interrupted Auto-Test execution')
    expect(resumed.state.threadGeneration).toBe(interrupted.threadGeneration + 1)
    expect(resumed.state.threadId).toBe('thread-fingerprint-replacement')
    expect(resumed.result?.outcome).toBe('passed')
  })

  it('does not rotate a resumed physical session for an ordinary agent execution error', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-session-no-rotation-'))
    directories.push(directory)
    const workflow = manifest()
    workflow.phases = workflow.phases.slice(0, 1)
    const files = await fixtureFiles(directory)
    const interrupted = await createInterruptedExecution(directory, workflow, files)
    await removeSessionBindingFingerprint(interrupted.outputDirectory)
    let startedNew = 0

    const resumed = await runCodexTestAgent({
      outputDirectory: interrupted.outputDirectory, manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: true, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false,
      agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable,
      modelProfile: profile(), environment: { FIXTURE_KEY: 'fixture-key' }, resume: true,
    }, {
      browserExecutablePath: files.browserPath,
      resumeThread: ({ threadId }) => ({
        id: threadId,
        runStreamed: async () => failedEventStream('The requested page assertion failed.', threadId),
      }),
      startThread: () => {
        startedNew += 1
        throw new Error('ordinary execution errors must not create a replacement session')
      },
    })

    expect(startedNew).toBe(0)
    expect(resumed.state.status).toBe('failed')
    expect(resumed.state.threadGeneration).toBe(interrupted.threadGeneration)
    expect(resumed.state.threadId).toBe('thread-old')
  })

  it('attempts at most one replacement when the new physical session is also incompatible', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-session-single-retry-'))
    directories.push(directory)
    const workflow = manifest()
    workflow.phases = workflow.phases.slice(0, 1)
    const files = await fixtureFiles(directory)
    const interrupted = await createInterruptedExecution(directory, workflow, files)
    await removeSessionBindingFingerprint(interrupted.outputDirectory)
    const mismatch = 'This session was recorded with model old-model but is resuming with new-model.'
    let startedNew = 0

    const resumed = await runCodexTestAgent({
      outputDirectory: interrupted.outputDirectory, manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: true, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false,
      agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable,
      modelProfile: profile(), environment: { FIXTURE_KEY: 'fixture-key' }, resume: true,
    }, {
      browserExecutablePath: files.browserPath,
      resumeThread: ({ threadId }) => ({ id: threadId, runStreamed: async () => failedEventStream(mismatch, threadId) }),
      startThread: () => {
        startedNew += 1
        return { id: 'thread-still-incompatible', runStreamed: async () => failedEventStream(mismatch, 'thread-still-incompatible') }
      },
    })

    expect(startedNew).toBe(1)
    expect(resumed.state.status).toBe('completed')
    expect(resumed.result?.outcome).toBe('blocked')
    expect(resumed.state.threadGeneration).toBe(interrupted.threadGeneration + 1)
    expect(resumed.state.threadId).toBe('thread-still-incompatible')
  })

  it('stops later epochs and returns a complete blocked result when a mutation remains pending', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-adaptive-mutation-'))
    directories.push(directory)
    const workflow = manifest()
    workflow.phases[0]!.risk = 'write'
    const files = await fixtureFiles(directory)
    const outputDirectory = resolve(directory, 'run')
    let started = 0
    const run = await runCodexTestAgent({
      outputDirectory, manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: true, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable, modelProfile: profile(), environment: { FIXTURE_KEY: 'fixture-key' },
    }, {
      browserExecutablePath: files.browserPath,
      startThread: () => {
        started += 1
        return {
          id: 'thread-pending',
          runStreamed: async (_input, options) => {
            if (!options?.outputSchema) {
              await writeFile(resolve(outputDirectory, '.agent-private', 'mutation-ledger.json'), JSON.stringify([{
                id: 'pending-write', caseId: 'case-one', description: 'Created test data', risk: 'write', status: 'pending',
                createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:00.000Z', evidence: [],
              }]))
              return eventStream('write still pending', 'thread-pending')
            }
            return eventStream(resultFor(workflow, ['case-one']), 'thread-pending')
          },
        }
      },
    })

    expect(started).toBe(1)
    expect(run.state.status).toBe('completed')
    expect(run.result?.outcome).toBe('blocked')
    expect(run.result?.cases.map((item) => [item.caseId, item.outcome])).toEqual([
      ['case-one', 'blocked'],
      ['case-two', 'blocked'],
    ])
    expect(run.result?.mutations).toContainEqual(expect.objectContaining({ id: 'pending-write', status: 'pending' }))
  })

  it('fails closed with a structured agent-execution block when the Mutation Ledger is malformed', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-malformed-ledger-'))
    directories.push(directory)
    const workflow = manifest()
    workflow.phases = workflow.phases.slice(0, 1)
    const files = await fixtureFiles(directory)
    const outputDirectory = resolve(directory, 'run')
    const run = await runCodexTestAgent({
      outputDirectory,
      manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: true, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false,
      agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable, modelProfile: profile(), environment: { FIXTURE_KEY: 'fixture-key' },
    }, {
      browserExecutablePath: files.browserPath,
      startThread: () => ({
        id: 'thread-malformed-ledger',
        runStreamed: async (_input, options) => {
          if (!options?.outputSchema) {
            await writeFile(resolve(outputDirectory, '.agent-private', 'mutation-ledger.json'), JSON.stringify({ overwritten: true }))
            return failedEventStream('network connection lost', 'thread-malformed-ledger')
          }
          return eventStream(resultFor(workflow, ['case-one']), 'thread-malformed-ledger')
        },
      }),
    })

    expect(run.state.status).toBe('completed')
    expect(run.result?.outcome).toBe('blocked')
    expect(run.result?.cases[0]).toMatchObject({ failureSource: 'agent_execution', failureKind: 'execution' })
    expect(run.result?.blockers[0]).toMatch(/Mutation Ledger is invalid: expected a JSON array/)
    expect(await readFile(resolve(outputDirectory, 'codex-agent.result.json'), 'utf8')).toContain('Mutation Ledger is invalid')
  })

  it('rejects Mutation Ledger entries with invalid timestamps', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-malformed-ledger-time-'))
    directories.push(directory)
    const workflow = manifest()
    workflow.phases = workflow.phases.slice(0, 1)
    const files = await fixtureFiles(directory)
    const outputDirectory = resolve(directory, 'run')
    const run = await runCodexTestAgent({
      outputDirectory, manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: true, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false,
      agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable, modelProfile: profile(), environment: { FIXTURE_KEY: 'fixture-key' },
    }, {
      browserExecutablePath: files.browserPath,
      startThread: () => ({
        id: 'thread-malformed-ledger-time',
        runStreamed: async (_input, options) => {
          if (!options?.outputSchema) {
            await writeFile(resolve(outputDirectory, '.agent-private', 'mutation-ledger.json'), JSON.stringify([{
              id: 'invalid-time', caseId: 'case-one', description: 'Fixture write', risk: 'write', status: 'compensated',
              createdAt: 'not-a-date', updatedAt: '2026-08-08T00:00:00.000Z', evidence: ['evidence/fixture.txt'],
            }]))
            return eventStream('execution complete', 'thread-malformed-ledger-time')
          }
          return eventStream(resultFor(workflow, ['case-one']), 'thread-malformed-ledger-time')
        },
      }),
    })

    expect(run.result?.outcome).toBe('blocked')
    expect(run.result?.cases[0]).toMatchObject({ failureSource: 'agent_execution' })
    expect(run.result?.blockers[0]).toMatch(/entry 0 does not match the run contract/)
  })

  it('resumes finalization without replaying the epoch execution turn', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-finalization-resume-'))
    directories.push(directory)
    const workflow = manifest()
    workflow.phases = workflow.phases.slice(0, 1)
    const files = await fixtureFiles(directory)
    const outputDirectory = resolve(directory, 'run')
    let turn = 0
    const interrupted = await runCodexTestAgent({
      outputDirectory, manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable,
    }, {
      browserExecutablePath: files.browserPath,
      startThread: () => ({
        id: 'thread-finalizing',
        runStreamed: async (_input, options) => {
          turn += 1
          return options?.outputSchema
            ? failedEventStream('network connection lost', 'thread-finalizing')
            : eventStream('execution complete', 'thread-finalizing')
        },
      }),
    })
    expect(turn).toBe(2)
    expect(interrupted.state.activeEpoch).toMatchObject({ id: 'epoch-0001', stage: 'finalizing' })

    let finalizationTurns = 0
    const resumed = await runCodexTestAgent({
      outputDirectory, manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable, resume: true,
    }, {
      browserExecutablePath: files.browserPath,
      startThread: () => { throw new Error('finalization resume must reuse the existing thread') },
      resumeThread: ({ threadId }) => ({
        id: threadId,
        runStreamed: async (_input, options) => {
          if (!options?.outputSchema) throw new Error('business execution was replayed during finalization resume')
          finalizationTurns += 1
          return eventStream(resultFor(workflow, ['case-one']), threadId)
        },
      }),
    })

    expect(finalizationTurns).toBe(1)
    expect(resumed.result?.outcome).toBe('passed')
  })

  it('scrubs evidence transcripts even when the Codex turn fails', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-evidence-redaction-'))
    directories.push(directory)
    const workflow = manifest()
    workflow.phases = workflow.phases.slice(0, 1)
    const files = await fixtureFiles(directory)
    const outputDirectory = resolve(directory, 'run')
    const evidencePath = resolve(outputDirectory, 'agent-workspace', 'evidence', 'session', 'session.md')
    const helperPath = resolve(outputDirectory, 'agent-workspace', 'generated-helper.log')

    const run = await runCodexTestAgent({
      outputDirectory, manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: { 'login.username': 'fixture-user', 'login.password': 'fixture-password' },
      environmentContext: '', imagePaths: [], headed: false, agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable,
      modelProfile: profile(), environment: { FIXTURE_KEY: 'provider-runtime-secret' },
    }, {
      browserExecutablePath: files.browserPath,
      startThread: () => ({
        id: 'thread-redaction',
        runStreamed: async () => {
          await mkdir(resolve(evidencePath, '..'), { recursive: true })
          await writeFile(evidencePath, 'username=fixture-user\npassword=fixture-password\nprovider=provider-runtime-secret\nAuthorization: Bearer abcdefghijklmnop\n')
          await writeFile(helperPath, 'fixture-password')
          return failedEventStream('network connection lost', 'thread-redaction', 'Cookie: session=abcdefghijklmno')
        },
      }),
    })

    expect(run.result?.outcome).toBe('blocked')
    const evidence = await readFile(evidencePath, 'utf8')
    expect(evidence).not.toContain('fixture-user')
    expect(evidence).not.toContain('fixture-password')
    expect(evidence).not.toContain('provider-runtime-secret')
    expect(evidence).not.toContain('abcdefghijklmnop')
    expect(await readFile(helperPath, 'utf8')).toBe('<redacted-secret>')
    const events = await readFile(resolve(outputDirectory, 'codex-agent.events.jsonl'), 'utf8')
    expect(events).not.toContain('session=abcdefghijklmno')
  })

  it('redacts exact secrets from structured delivery artifacts', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-structured-redaction-'))
    directories.push(directory)
    const workflow = manifest()
    workflow.phases = workflow.phases.slice(0, 1)
    const files = await fixtureFiles(directory)
    const result = JSON.parse(resultFor(workflow, ['case-one'])) as { summary: string; cases: Array<{ summary: string }> }
    result.summary = 'fixture-user'
    result.cases[0]!.summary = 'fixture-password'

    const run = await runCodexTestAgent({
      outputDirectory: resolve(directory, 'run'), manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: { 'login.username': 'fixture-user', 'login.password': 'fixture-password' },
      environmentContext: '', imagePaths: [], headed: false, agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable,
    }, { browserExecutablePath: files.browserPath, startThread: () => ({ id: 'thread-structured-redaction', runStreamed: async () => eventStream(JSON.stringify(result), 'thread-structured-redaction') }) })

    expect(run.result?.outcome).toBe('passed')
    for (const path of [
      resolve(directory, 'run', 'codex-agent.result.json'),
      resolve(directory, 'run', 'agent-workspace', 'case-results.json'),
      resolve(directory, 'run', '.agent-private', 'execution-epochs', 'epoch-0001.result.json'),
    ]) {
      expect(await readFile(path, 'utf8')).not.toContain('fixture-user')
      expect(await readFile(path, 'utf8')).not.toContain('fixture-password')
    }
  })

  it('recovers complete epoch delivery without restarting the AgentHost', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-epoch-delivery-resume-'))
    directories.push(directory)
    const workflow = manifest()
    workflow.phases = workflow.phases.slice(0, 1)
    const files = await fixtureFiles(directory)
    const outputDirectory = resolve(directory, 'run')
    const secret = 'fixture-phone-7890'
    const commonOptions = {
      outputDirectory,
      manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: { 'test.phone': secret },
      environmentContext: '', imagePaths: [], headed: false,
      codexHome: files.sourceHome, codexExecutable: files.codexExecutable,
    }
    const initial = await runCodexTestAgent(commonOptions, {
      browserExecutablePath: files.browserPath,
      startThread: () => ({
        id: 'thread-epoch-recovery',
        runStreamed: async (_input, options) => options?.outputSchema
          ? eventStream(resultFor(workflow, ['case-one']), 'thread-epoch-recovery')
          : eventStream('execution complete', 'thread-epoch-recovery'),
      }),
    })
    expect(initial.result?.outcome).toBe('passed')

    const workspaceDirectory = resolve(outputDirectory, 'agent-workspace')
    const evidenceDirectory = resolve(workspaceDirectory, 'evidence')
    await mkdir(evidenceDirectory, { recursive: true })
    await writeFile(resolve(evidenceDirectory, `round-${secret}.png`), 'png')
    await writeFile(resolve(workspaceDirectory, 'case-results.epoch-0001.json'), JSON.stringify({
      version: '1.0',
      kind: 'case-results',
      workflowId: workflow.workflowId,
      sourceSha256: workflow.source.sha256,
      generatedAt: '2026-08-05T00:01:00.000Z',
      cases: [{
        caseId: 'case-one', outcome: 'passed', summary: 'Recovered from observed evidence',
        evidencePaths: ['evidence/round-<redacted-secret>.png'],
      }],
      mutationLedger: { state: 'terminal', pendingCount: 0, entries: [] },
    }))
    const statePath = resolve(outputDirectory, 'codex-agent.state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
    await writeFile(statePath, JSON.stringify({
      ...state,
      status: 'completed',
      stage: 'completed',
      outcome: 'blocked',
      activeEpoch: {
        id: 'epoch-0001', index: 0, total: 1, caseIds: ['case-one'],
        threadId: 'thread-epoch-recovery', stage: 'finalizing',
      },
    }))

    const resumed = await runCodexTestAgent({ ...commonOptions, resume: true }, {
      browserExecutablePath: files.browserPath,
      startThread: () => { throw new Error('resume recovery must not start an AgentHost') },
      resumeThread: () => { throw new Error('resume recovery must not resume an AgentHost') },
    })

    expect(resumed.result?.outcome).toBe('passed')
    expect(resumed.result?.cases.map((item) => item.caseId)).toEqual(['case-one'])
    expect(resumed.state.completedCaseIds).toEqual(['case-one'])
    expect(resumed.state.activeEpoch).toBeUndefined()
    const aggregate = JSON.parse(await readFile(resolve(workspaceDirectory, 'case-results.json'), 'utf8')) as {
      cases: Array<{ caseId: string; outcome: string }>
    }
    expect(aggregate.cases).toEqual([expect.objectContaining({ caseId: 'case-one', outcome: 'passed' })])
    const storedResultPath = resolve(
      outputDirectory,
      '.agent-private',
      'case-results',
      (await readdir(resolve(outputDirectory, '.agent-private', 'case-results')))[0]!,
    )
    const stored = JSON.parse(await readFile(storedResultPath, 'utf8')) as { epochId: string; result: { outcome: string } }
    expect(stored).toMatchObject({ epochId: 'recovered-delivery', result: { outcome: 'passed' } })
    const epochArtifact = JSON.parse(await readFile(resolve(workspaceDirectory, 'case-results.epoch-0001.json'), 'utf8')) as {
      cases: Array<{ evidencePaths: string[] }>
    }
    const evidenceReference = epochArtifact.cases[0]!.evidencePaths[0]!
    expect(evidenceReference).toBe('evidence/round-redacted-secret.png')
    expect(await readFile(resolve(workspaceDirectory, evidenceReference), 'utf8')).toBe('png')
  })

  it('fails closed instead of interpreting legacy execution state', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-legacy-state-'))
    directories.push(directory)
    const workflow = manifest()
    const files = await fixtureFiles(directory)
    const outputDirectory = resolve(directory, 'run')
    await mkdir(resolve(outputDirectory, '.agent-private'), { recursive: true })
    await writeFile(resolve(outputDirectory, '.agent-private', 'mutation-ledger.json'), '[]')
    await writeFile(resolve(outputDirectory, 'codex-agent.state.json'), JSON.stringify({
      version: '1.0', status: 'running', stage: 'executing', workflowId: workflow.workflowId,
      sourceSha256: workflow.source.sha256, startedAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:00.000Z',
      executionMode: 'single_thread',
    }))

    await expect(runCodexTestAgent({
      outputDirectory, manifest: workflow,
      profile: { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: false, allowDestructive: false } },
      secrets: {}, environmentContext: '', imagePaths: [], headed: false, agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable, resume: true,
    }, { browserExecutablePath: files.browserPath })).rejects.toThrow(/旧版 Codex 测试状态不再支持恢复/)
  })
})
