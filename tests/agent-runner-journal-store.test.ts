import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ThreadEvent } from '@openai/codex-sdk'
import { runAgentTest } from '../src/agent/runner.js'
import { openRunArtifactStore, runArtifactLayout } from '../src/agent/run-artifact-store.js'
import type { ModelProfile } from '../src/workflow/model-profile.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/**
 * One write-risk Case. The independent Playwright replay gate only runs for
 * read-only environments, so a write-risk Case keeps these assertions about the
 * run journal instead of about a browser this suite cannot launch.
 */
function manifest(): WorkflowIntakeManifest {
  return {
    version: '1.0', kind: 'workflow-intake', workflowId: 'journal-runner-fixture',
    source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'b'.repeat(64) },
    targetUrls: ['https://tasks.example.test/'], requiredCapabilities: [],
    phases: [
      { id: 'place-order', title: '下单', sourceRow: 2, risk: 'write', steps: [{ id: 'step-one', sourceText: '下一单', confidence: 1 }], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
    ],
    embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
  }
}

const writeProfile = { id: 'fixture', origins: ['https://tasks.example.test'], auth: [], policy: { allowWrite: true, allowDestructive: false } }

function modelProfile(): ModelProfile {
  return {
    id: 'fixture', model: 'fixture', providerId: 'fixture', baseUrl: 'https://provider.example.test', api: 'openai-responses', envKey: 'FIXTURE_KEY', envKeyAliases: ['FIXTURE_ALIAS_KEY'],
    reasoningEffort: 'high', supportsWebsockets: false,
    contextWindowTokens: 1_000, maxOutputTokens: 100, caseOutputTokens: 100, targetContextRatio: 0.5, targetOutputRatio: 0.5,
  }
}

function eventStream(text: string, threadId: string): { events: AsyncGenerator<ThreadEvent> } {
  return {
    events: (async function* () {
      yield { type: 'thread.started', thread_id: threadId } as ThreadEvent
      yield { type: 'item.completed', item: { id: `message-${threadId}`, type: 'agent_message', text } } as ThreadEvent
      yield { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 8 } } as ThreadEvent
    })(),
  }
}

function failedEventStream(message: string, threadId: string): { events: AsyncGenerator<ThreadEvent> } {
  return {
    events: (async function* () {
      yield { type: 'thread.started', thread_id: threadId } as ThreadEvent
      yield { type: 'error', message } as ThreadEvent
    })(),
  }
}

/** One structured delivery, the shape the AgentHost returns for the whole epoch. */
function resultFor(workflow: WorkflowIntakeManifest, caseIds: string[]): string {
  return JSON.stringify({
    version: '1.0', workflowId: workflow.workflowId, sourceSha256: workflow.source.sha256,
    outcome: 'passed', summary: '完成',
    startedAt: '2026-09-01T00:00:00.000Z', finishedAt: '2026-09-01T00:01:00.000Z',
    cases: caseIds.map((caseId) => ({
      caseId, title: '下单', outcome: 'passed', summary: `已验证 ${caseId}`,
      evidence: [{ kind: 'observation', description: `现场观察 ${caseId}` }],
    })),
    mutations: [], environmentRequirements: [], blockers: [], productDefects: [], nextActions: [],
  })
}

async function fixtureFiles(directory: string): Promise<{ sourceHome: string; browserPath: string; codexExecutable: string }> {
  const sourceHome = resolve(directory, 'source-home')
  await mkdir(sourceHome)
  await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
  const browserPath = resolve(directory, 'chromium')
  await writeFile(browserPath, '')
  const codexPackage = createRequire(import.meta.url).resolve('@openai/codex/package.json')
  return { sourceHome, browserPath, codexExecutable: resolve(dirname(codexPackage), 'bin', 'codex.js') }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2))
}

/** The first epoch's recovery delivery artifact, the path the harness prompts for. */
function epochDeliveryPath(outputDirectory: string): string {
  return resolve(outputDirectory, 'agent-workspace', 'case-results.epoch-0001.json')
}

const compensatedLedger = [{
  id: 'mutation-recovered', caseId: 'place-order', description: 'Created one business record', risk: 'write',
  status: 'compensated', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:05:00.000Z',
  evidence: ['evidence/device-state.png'],
}]

const pendingRequirement = {
  id: 'environment-physical-place-order', caseIds: ['place-order'], kind: 'physical',
  condition: '需要可控制测试设备状态', evidence: ['evidence/device-state.png'],
  status: 'pending', requestedAt: '2026-09-01T00:00:00.000Z',
}

const interactionReceipt = {
  id: 'epoch-0001:turn-0001:event-1', caseId: 'place-order', tool: 'browser_click',
  kind: 'interaction', status: 'completed', recordedAt: '2026-09-01T00:00:10.000Z',
}

/**
 * One receipt artifact read straight from its file. The store is the only reader
 * of the run journal in production; this test keeps an independent read so the
 * store's identity-checked view is compared against the bytes the run wrote.
 */
async function readReceiptFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

/** What settlement reports for one ledger entry: the ledger's own fields minus its timestamps. */
function settledMutations(): Array<Omit<(typeof compensatedLedger)[number], 'createdAt' | 'updatedAt'>> {
  return compensatedLedger.map(({ createdAt: _createdAt, updatedAt: _updatedAt, ...entry }) => entry)
}

/**
 * One blocked, environment-sourced delivery that cites the seeded ledger entry,
 * prerequisite, and receipt, as an AgentHost that finished the epoch wrote it.
 */
function blockedDeliveryArtifact(workflow: WorkflowIntakeManifest): unknown {
  return {
    version: '1.0', kind: 'case-results', workflowId: workflow.workflowId, sourceSha256: workflow.source.sha256,
    generatedAt: '2026-09-01T00:10:00.000Z',
    cases: [{
      caseId: 'place-order', title: '下单', outcome: 'blocked', summary: '需要可控制测试设备状态',
      evidencePaths: ['evidence/device-state.png'], failureSource: 'environment', failureKind: 'environment',
      environmentRequirementIds: ['environment-physical-place-order'],
      executionReceiptIds: ['epoch-0001:turn-0001:event-1'],
    }],
    mutationLedger: { state: 'terminal', pendingCount: 0, entries: [] },
  }
}

/** Representative journal entries, written straight into the artifacts the store owns. */
async function seedJournal(
  outputDirectory: string,
  overrides: { requirement?: unknown; receipt?: unknown } = {},
): Promise<void> {
  const layout = runArtifactLayout(outputDirectory)
  await mkdir(resolve(outputDirectory, 'agent-workspace', 'evidence'), { recursive: true })
  await writeFile(resolve(outputDirectory, 'agent-workspace', 'evidence', 'device-state.png'), 'fixture')
  await writeJson(layout.mutationLedgerPath, compensatedLedger)
  await writeJson(layout.environmentRequirementsPath, [overrides.requirement ?? pendingRequirement])
  await writeJson(layout.executionReceiptsPath, [overrides.receipt ?? interactionReceipt])
}


async function interruptExecution(
  directory: string,
  workflow: WorkflowIntakeManifest,
  files: Awaited<ReturnType<typeof fixtureFiles>>,
): Promise<string> {
  const outputDirectory = resolve(directory, 'run')
  const interrupted = await runAgentTest({
    outputDirectory, manifest: workflow, profile: writeProfile,
    secrets: {}, environmentContext: '', imagePaths: [], headed: false,
    agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable,
    modelProfile: modelProfile(), environment: { FIXTURE_KEY: 'fixture-key' },
  }, {
    browserExecutablePath: files.browserPath,
    startThread: () => ({ id: 'thread-old', runStreamed: async () => failedEventStream('network connection lost', 'thread-old') }),
  })
  expect(interrupted.result?.outcome).toBe('blocked')
  expect(interrupted.state.activeEpoch).toMatchObject({ id: 'epoch-0001', stage: 'executing', threadId: 'thread-old' })
  return outputDirectory
}

describe('runner journal reads through RunArtifactStore', () => {
  it('reads settlement journal entries through the store exactly as a direct file read returns them', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-runner-journal-parity-'))
    directories.push(directory)
    const workflow = manifest()
    const files = await fixtureFiles(directory)
    const outputDirectory = resolve(directory, 'run')
    const layout = runArtifactLayout(outputDirectory)
    const run = await runAgentTest({
      outputDirectory, manifest: workflow, profile: writeProfile,
      secrets: {}, environmentContext: '', imagePaths: [], headed: false,
      agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable,
      modelProfile: modelProfile(), environment: { FIXTURE_KEY: 'fixture-key' },
    }, {
      browserExecutablePath: files.browserPath,
      startThread: () => ({
        id: 'thread-journal',
        runStreamed: async () => {
          // Representative journal entries written straight into the canonical
          // artifacts the store owns, plus the epoch delivery that cites them.
          await seedJournal(outputDirectory)
          await writeJson(epochDeliveryPath(outputDirectory), blockedDeliveryArtifact(workflow))
          return eventStream('execution complete', 'thread-journal')
        },
      }),
    })

    expect(run.result?.outcome).toBe('blocked')
    expect(run.result?.mutations).toEqual(settledMutations())
    expect(run.result?.environmentRequirements).toEqual([pendingRequirement])
    const directReceipts = await readReceiptFile(layout.executionReceiptsPath)
    expect(directReceipts).toEqual([interactionReceipt])
    const storeReceipts = await openRunArtifactStore({ runRoot: outputDirectory, manifest: workflow }).readExecutionReceipts()
    expect(storeReceipts.problems).toEqual([])
    expect(storeReceipts.entries).toEqual(directReceipts)
  }, 30_000)

  it('recovers a verified delivery from the store-read journal without starting another AgentHost session', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-runner-recovery-parity-'))
    directories.push(directory)
    const workflow = manifest()
    const files = await fixtureFiles(directory)
    const outputDirectory = await interruptExecution(directory, workflow, files)
    const layout = runArtifactLayout(outputDirectory)
    await seedJournal(outputDirectory)
    await writeJson(layout.caseResultsPath, blockedDeliveryArtifact(workflow))

    let sessions = 0
    const resumed = await runAgentTest({
      outputDirectory, manifest: workflow, profile: writeProfile,
      secrets: {}, environmentContext: '', imagePaths: [], headed: false,
      agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable,
      modelProfile: modelProfile(), environment: { FIXTURE_KEY: 'fixture-key' }, resume: true,
    }, {
      browserExecutablePath: files.browserPath,
      startThread: () => { throw new Error('a verified delivery must not start a new AgentHost session') },
      resumeThread: ({ threadId }) => {
        sessions += 1
        return { id: threadId, runStreamed: async () => failedEventStream('network connection lost', threadId) }
      },
    })

    expect(sessions).toBe(0)
    expect(resumed.result?.outcome).toBe('blocked')
    expect(resumed.result?.cases[0]).toMatchObject({ caseId: 'place-order', failureSource: 'environment' })
    expect(resumed.result?.mutations).toEqual(settledMutations())
    expect(resumed.result?.environmentRequirements).toEqual([pendingRequirement])
    const directReceipts = await readReceiptFile(layout.executionReceiptsPath)
    expect(directReceipts).toEqual([interactionReceipt])
    expect((await openRunArtifactStore({ runRoot: outputDirectory, manifest: workflow }).readExecutionReceipts()).entries)
      .toEqual(directReceipts)
  }, 30_000)

  it('refuses a resumed delivery whose journal holds entries from another run or workflow', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-runner-recovery-foreign-'))
    directories.push(directory)
    const workflow = manifest()
    const files = await fixtureFiles(directory)
    const outputDirectory = await interruptExecution(directory, workflow, files)
    await seedJournal(outputDirectory, {
      requirement: { ...pendingRequirement, caseIds: ['retired-case'] },
      receipt: { ...interactionReceipt, caseId: 'retired-case' },
    })
    await writeJson(runArtifactLayout(outputDirectory).caseResultsPath, blockedDeliveryArtifact(workflow))

    let sessions = 0
    const resumed = await runAgentTest({
      outputDirectory, manifest: workflow, profile: writeProfile,
      secrets: {}, environmentContext: '', imagePaths: [], headed: false,
      agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable,
      modelProfile: modelProfile(), environment: { FIXTURE_KEY: 'fixture-key' }, resume: true,
    }, {
      browserExecutablePath: files.browserPath,
      startThread: () => { throw new Error('a rejected journal must not start a new AgentHost session') },
      resumeThread: ({ threadId }) => {
        sessions += 1
        return { id: threadId, runStreamed: async () => failedEventStream('network connection lost', threadId) }
      },
    })

    expect(sessions).toBe(0)
    expect(resumed.result).toBeUndefined()
    expect(resumed.state.status).toBe('failed')
    expect(resumed.state.error).toMatch(/references an unknown case retired-case/)
  }, 30_000)

  it('reports an absent Mutation Ledger as an uninitialized run and an absent prerequisite journal as empty', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-runner-journal-missing-'))
    directories.push(directory)
    const workflow = manifest()
    const files = await fixtureFiles(directory)
    const outputDirectory = resolve(directory, 'run')
    const layout = runArtifactLayout(outputDirectory)
    const run = await runAgentTest({
      outputDirectory, manifest: workflow, profile: writeProfile,
      secrets: {}, environmentContext: '', imagePaths: [], headed: false,
      agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable,
      modelProfile: modelProfile(), environment: { FIXTURE_KEY: 'fixture-key' },
    }, {
      browserExecutablePath: files.browserPath,
      startThread: () => ({
        id: 'thread-missing',
        runStreamed: async () => {
          await rm(layout.mutationLedgerPath, { force: true })
          await rm(layout.environmentRequirementsPath, { force: true })
          return failedEventStream('network connection lost', 'thread-missing')
        },
      }),
    })

    expect(run.result?.outcome).toBe('blocked')
    expect(run.result?.blockers[0]).toMatch(/Mutation Ledger is missing under .*the run root is not an initialized Auto-Test run/)
    expect(run.result?.environmentRequirements).toEqual([])
  }, 30_000)

  it('re-reads an unresolved mutation before a resumed delivery may skip real execution', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-runner-journal-pending-'))
    directories.push(directory)
    const workflow = manifest()
    const files = await fixtureFiles(directory)
    const outputDirectory = await interruptExecution(directory, workflow, files)
    const layout = runArtifactLayout(outputDirectory)
    await seedJournal(outputDirectory)
    await writeJson(layout.caseResultsPath, blockedDeliveryArtifact(workflow))
    await writeJson(layout.mutationLedgerPath, [{
      ...compensatedLedger[0], id: 'mutation-unresolved', status: 'pending',
      updatedAt: '2026-09-01T00:06:00.000Z',
    }])

    let sessions = 0
    const resumed = await runAgentTest({
      outputDirectory, manifest: workflow, profile: writeProfile,
      secrets: {}, environmentContext: '', imagePaths: [], headed: false,
      agentSourceHome: files.sourceHome, agentExecutable: files.codexExecutable,
      modelProfile: modelProfile(), environment: { FIXTURE_KEY: 'fixture-key' }, resume: true,
    }, {
      browserExecutablePath: files.browserPath,
      startThread: () => { throw new Error('a pending mutation must be reconciled on the existing session') },
      resumeThread: ({ threadId }) => {
        sessions += 1
        return {
          id: threadId,
          runStreamed: async (_input, options) => eventStream(
            options?.outputSchema ? resultFor(workflow, ['place-order']) : '重新核对待核销业务写入',
            threadId,
          ),
        }
      },
    })

    expect(sessions).toBeGreaterThan(0)
    expect(resumed.result?.outcome).toBe('blocked')
    expect(resumed.result?.mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'mutation-unresolved', status: 'pending' }),
    ]))
  }, 30_000)
})
