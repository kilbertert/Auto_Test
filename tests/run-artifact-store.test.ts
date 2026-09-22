import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EnvironmentProfile } from '../src/workflow/environment-profile.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'
import { prepareAgentWorkspace, type AgentWorkspace } from '../src/agent/workspace.js'
import { caseResultPath } from '../src/agent/case-result-store.js'
import { openRunArtifactStore, runArtifactLayout, type RunArtifactStore } from '../src/agent/run-artifact-store.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const manifest: WorkflowIntakeManifest = {
  version: '1.0',
  kind: 'workflow-intake',
  workflowId: 'journal-fixture',
  source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'a'.repeat(64) },
  targetUrls: ['https://journal.example.test/app'],
  requiredCapabilities: [],
  phases: [
    {
      id: 'inspect-board',
      title: 'Inspect board',
      sourceRow: 2,
      risk: 'read',
      steps: [{ id: 'step-1', sourceText: 'Open the board', confidence: 1 }],
      resources: [],
      secretBindings: [],
      imageIds: [],
      review: { status: 'draft', ambiguities: [] },
    },
    {
      id: 'place-order',
      title: 'Place order',
      sourceRow: 3,
      risk: 'write',
      steps: [{ id: 'step-2', sourceText: 'Place one order', confidence: 1 }],
      resources: [],
      secretBindings: [],
      imageIds: [],
      review: { status: 'draft', ambiguities: [] },
    },
  ],
  embeddedImages: [],
  supplementalImages: [],
  review: { status: 'draft', reasons: [] },
}

const profile: EnvironmentProfile = {
  id: 'journal-fixture',
  origins: ['https://journal.example.test'],
  auth: [],
  policy: { allowWrite: true, allowDestructive: false },
}

async function tempRunRoot(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-run-artifact-store-'))
  directories.push(directory)
  return resolve(directory, 'run')
}

async function prepareRun(): Promise<{ runRoot: string; workspace: AgentWorkspace }> {
  const runRoot = await tempRunRoot()
  const workspace = await prepareAgentWorkspace({
    outputDirectory: runRoot,
    manifest,
    profile,
    secrets: {},
    headed: false,
    browserExecutablePath: '/verified/chromium',
    environment: { PATH: '/usr/bin' },
  })
  return { runRoot, workspace }
}

async function openPreparedStore(): Promise<{ store: RunArtifactStore; runRoot: string; workspace: AgentWorkspace }> {
  const { runRoot, workspace } = await prepareRun()
  return { store: openRunArtifactStore({ runRoot, manifest }), runRoot, workspace }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2))
}

function ledgerEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mutation-1',
    caseId: 'place-order',
    description: 'Create one business record',
    risk: 'write',
    status: 'pending',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    evidence: [],
    ...overrides,
  }
}

function caseResult(caseId: string): Record<string, unknown> {
  return {
    version: '1.0',
    workflowId: manifest.workflowId,
    sourceSha256: manifest.source.sha256,
    epochId: 'epoch-0001',
    recordedAt: '2026-09-01T00:00:00.000Z',
    result: {
      caseId,
      title: caseId,
      outcome: 'product_failed',
      summary: 'Observed total was wrong',
      failureSource: 'product',
      failureKind: 'assertion',
      evidence: [{ kind: 'observation', description: 'Observed total' }],
    },
  }
}

describe('RunArtifactStore journal paths', () => {
  it('answers the canonical path of every run journal artifact under one run root', async () => {
    const { store, runRoot, workspace } = await openPreparedStore()

    expect(store.runRoot).toBe(runRoot)
    expect(store.layout.mutationLedgerPath).toBe(workspace.mutationLedgerPath)
    expect(store.layout.environmentRequirementsPath).toBe(workspace.environmentRequirementsPath)
    expect(store.layout.executionReceiptsPath).toBe(workspace.executionReceiptsPath)
    expect(store.layout.fieldCompositionsPath).toBe(workspace.fieldCompositionPath)
    expect(store.layout.caseResultsPath).toBe(workspace.caseResultsPath)
    expect(store.layout.manifestPath).toBe(workspace.manifestPath)
    expect(store.layout.caseResultRecordsDirectory).toBe(resolve(runRoot, '.agent-private', 'case-results'))
    expect(runArtifactLayout(runRoot)).toEqual(store.layout)
    expect(store.caseResultRecordPath('inspect-board')).toBe(caseResultPath(store.layout.caseResultRecordsDirectory, 'inspect-board'))
  })

  it('resolves a run root that is not already normalized', () => {
    expect(runArtifactLayout(`${manifest.workflowId}/../run/`)).toEqual(runArtifactLayout(resolve(manifest.workflowId, '..', 'run')))
  })

  it('derives the run identity every read is checked against', () => {
    const store = openRunArtifactStore({ runRoot: resolve('/tmp', 'run'), manifest })

    expect(store.identity).toEqual({
      workflowId: 'journal-fixture',
      sourceSha256: 'a'.repeat(64),
      caseIds: ['inspect-board', 'place-order'],
    })
  })
})

describe('RunArtifactStore initialization', () => {
  it('initializes a new run with empty journal artifacts at private file permissions', async () => {
    const runRoot = await tempRunRoot()
    const store = openRunArtifactStore({ runRoot, manifest })

    await store.initialize({ resume: false })

    for (const path of [
      store.layout.mutationLedgerPath,
      store.layout.environmentRequirementsPath,
      store.layout.executionReceiptsPath,
      store.layout.fieldCompositionsPath,
      store.layout.caseResultsPath,
    ]) {
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([])
    }
    if (process.platform !== 'win32') {
      expect((await stat(store.layout.mutationLedgerPath)).mode & 0o777).toBe(0o600)
    }
    expect(await store.readCaseResultRecords()).toEqual({ missing: true, missingMeans: 'empty', entries: [], problems: [] })
  })

  it('keeps persisted run journal entries when a resume reinitializes the store', async () => {
    const { store } = await openPreparedStore()
    await writeJson(store.layout.mutationLedgerPath, [ledgerEntry()])
    await writeJson(store.layout.caseResultsPath, [{ caseId: 'inspect-board', outcome: 'passed', summary: 'Board rendered', blockers: [], productDefects: [], recordedAt: '2026-09-01T00:00:00.000Z' }])
    await rm(store.layout.executionReceiptsPath, { force: true })
    await rm(store.layout.fieldCompositionsPath, { force: true })

    await store.initialize({ resume: true })

    expect(JSON.parse(await readFile(store.layout.mutationLedgerPath, 'utf8'))).toEqual([ledgerEntry()])
    expect(JSON.parse(await readFile(store.layout.caseResultsPath, 'utf8'))).toHaveLength(1)
    expect(JSON.parse(await readFile(store.layout.executionReceiptsPath, 'utf8'))).toEqual([])
    expect(JSON.parse(await readFile(store.layout.fieldCompositionsPath, 'utf8'))).toEqual([])
  })

  it('refuses to initialize a resume whose run identity does not match the persisted run', async () => {
    const { store } = await openPreparedStore()
    await writeJson(store.layout.manifestPath, { ...manifest, workflowId: 'another-run' })

    await expect(store.initialize({ resume: true })).rejects.toThrow(/workflow identity/)
    expect(await store.readMutationLedger()).toMatchObject({ missing: false, entries: [] })
  })

  it('refuses to initialize a resume whose source hash does not match the persisted run', async () => {
    const { store } = await openPreparedStore()
    await writeJson(store.layout.manifestPath, { ...manifest, source: { ...manifest.source, sha256: 'b'.repeat(64) } })

    await expect(store.initialize({ resume: true })).rejects.toThrow(/workflow identity/)
  })
})

describe('RunArtifactStore missing artifact meaning', () => {
  it('separates a missing artifact that means an empty journal from one that means an error', async () => {
    const runRoot = await tempRunRoot()
    const store = openRunArtifactStore({ runRoot, manifest })

    const ledger = await store.readMutationLedger()
    expect(ledger.missing).toBe(true)
    expect(ledger.missingMeans).toBe('error')
    expect(ledger.entries).toEqual([])
    expect(ledger.problems).toHaveLength(1)
    expect(ledger.problems[0]).toMatch(/Mutation Ledger is missing/)

    for (const read of [
      store.readEnvironmentRequirements(),
      store.readExecutionReceipts(),
      store.readFieldCompositionGates(),
      store.readCaseResultDecisions(),
      store.readCaseResultRecords(),
    ]) {
      expect(await read).toEqual({ missing: true, missingMeans: 'empty', entries: [], problems: [] })
    }
  })
})

describe('RunArtifactStore read-back identity', () => {
  it('returns identity-checked entries for a run journal written by the run itself', async () => {
    const { store } = await openPreparedStore()
    await writeJson(store.layout.mutationLedgerPath, [ledgerEntry({ status: 'compensated' })])
    await writeJson(store.layout.environmentRequirementsPath, [{
      id: 'environment-origin-1',
      caseIds: ['place-order'],
      kind: 'origin',
      origin: 'https://pay.example.test',
      condition: 'Payment provider origin is not registered',
      evidence: [],
      status: 'pending',
      requestedAt: '2026-09-01T00:00:00.000Z',
    }])
    await writeJson(store.layout.executionReceiptsPath, [{
      id: 'epoch-0001:turn-0001:event-1',
      caseId: 'place-order',
      tool: 'browser_click',
      kind: 'interaction',
      status: 'completed',
      recordedAt: '2026-09-01T00:00:00.000Z',
    }])
    await writeJson(store.layout.fieldCompositionsPath, [{
      id: 'place-order:amount',
      caseId: 'place-order',
      fieldId: 'amount',
      logicalValueRef: 'order.amount',
      purpose: 'Verify one composite value',
      status: 'passed',
    }])
    await writeJson(store.layout.caseResultsPath, [{
      caseId: 'inspect-board',
      outcome: 'passed',
      summary: 'Board rendered',
      blockers: [],
      productDefects: [],
      recordedAt: '2026-09-01T00:00:00.000Z',
    }])
    await writeJson(store.caseResultRecordPath('inspect-board'), caseResult('inspect-board'))

    expect((await store.readMutationLedger()).entries).toEqual([ledgerEntry({ status: 'compensated' })])
    expect((await store.readMutationLedger()).problems).toEqual([])
    const requirements = await store.readEnvironmentRequirements()
    expect(requirements.missing).toBe(false)
    expect(requirements.entries.map((item) => item.id)).toEqual(['environment-origin-1'])
    expect(requirements.problems).toEqual([])
    const receipts = await store.readExecutionReceipts()
    expect(receipts.entries.map((item) => item.id)).toEqual(['epoch-0001:turn-0001:event-1'])
    expect(receipts.problems).toEqual([])
    expect((await store.readFieldCompositionGates()).entries).toHaveLength(1)
    expect((await store.readFieldCompositionGates()).problems).toEqual([])
    expect((await store.readCaseResultDecisions()).entries).toHaveLength(1)
    expect((await store.readCaseResultDecisions()).problems).toEqual([])
    expect((await store.readCaseResultRecords()).entries.map((record) => record.result.caseId)).toEqual(['inspect-board'])
    expect((await store.readCaseResultRecords()).problems).toEqual([])
  })

  it('rejects journal entries that name a case outside the immutable run', async () => {
    const { store } = await openPreparedStore()
    await writeJson(store.layout.mutationLedgerPath, [ledgerEntry({ caseId: 'retired-case' })])
    await writeJson(store.layout.executionReceiptsPath, [{
      id: 'epoch-0001:turn-0001:event-2', caseId: 'retired-case', tool: 'browser_click', kind: 'interaction', status: 'completed', recordedAt: '2026-09-01T00:00:00.000Z',
    }])
    await writeJson(store.layout.fieldCompositionsPath, [{ id: 'retired-case:amount', caseId: 'retired-case', fieldId: 'amount' }])
    await writeJson(store.layout.caseResultsPath, [{ caseId: 'retired-case', outcome: 'passed', summary: 'Ignored', recordedAt: '2026-09-01T00:00:00.000Z' }])
    await writeJson(store.layout.environmentRequirementsPath, [{
      id: 'environment-origin-2', caseIds: ['retired-case'], kind: 'permission', condition: 'Geolocation is missing', evidence: [], status: 'pending', requestedAt: '2026-09-01T00:00:00.000Z',
    }])

    const ledger = await store.readMutationLedger()
    expect(ledger.entries).toEqual([])
    expect(ledger.problems).toEqual(['Mutation Ledger entry mutation-1 references an unknown case retired-case'])
    expect((await store.readExecutionReceipts()).problems).toEqual(['Execution receipt epoch-0001:turn-0001:event-2 references an unknown case retired-case'])
    expect((await store.readFieldCompositionGates()).problems).toEqual(['Field composition gate retired-case:amount references an unknown case retired-case'])
    expect((await store.readCaseResultDecisions()).problems).toEqual(['Case result decision references an unknown case retired-case'])
    expect((await store.readEnvironmentRequirements()).problems).toEqual(['Environment requirement environment-origin-2 references an unknown case retired-case'])
  })

  it('rejects per-case records whose run identity does not match the current run', async () => {
    const { store } = await openPreparedStore()
    await writeJson(store.caseResultRecordPath('inspect-board'), { ...caseResult('inspect-board'), workflowId: 'another-run' })

    const record = await store.readCaseResultRecords()
    expect(record.missing).toBe(false)
    expect(record.entries).toEqual([])
    expect(record.problems.join(' ')).toMatch(/identity does not match the current run/)
  })

  it('rejects per-case records that name a case outside the immutable run', async () => {
    const { store } = await openPreparedStore()
    await writeJson(store.caseResultRecordPath('retired-case'), caseResult('retired-case'))

    const record = await store.readCaseResultRecords()
    expect(record.entries).toEqual([])
    expect(record.problems.join(' ')).toMatch(/unknown case/)
  })

  it('rejects per-case records whose storage identity does not match their case', async () => {
    const { store } = await openPreparedStore()
    await writeJson(resolve(store.layout.caseResultRecordsDirectory, 'plain-name.json'), caseResult('inspect-board'))

    const record = await store.readCaseResultRecords()
    expect(record.entries).toEqual([])
    expect(record.problems.join(' ')).toMatch(/storage identity is invalid/)
  })

  it('rejects duplicate Mutation Ledger entry identities instead of accepting both', async () => {
    const { store } = await openPreparedStore()
    await writeJson(store.layout.mutationLedgerPath, [ledgerEntry(), ledgerEntry({ status: 'compensated' })])

    const ledger = await store.readMutationLedger()
    expect(ledger.entries).toEqual([])
    expect(ledger.problems).toEqual(['Mutation Ledger contains a duplicate entry id mutation-1'])
  })

  it('reports malformed journal content as a problem instead of throwing', async () => {
    const { store } = await openPreparedStore()
    await writeFile(store.layout.mutationLedgerPath, '{"entries": []}')
    await writeFile(store.layout.caseResultsPath, 'not json')

    const ledger = await store.readMutationLedger()
    expect(ledger.entries).toEqual([])
    expect(ledger.problems).toEqual(['Mutation Ledger is invalid: expected a JSON array of entries'])
    const decisions = await store.readCaseResultDecisions()
    expect(decisions.entries).toEqual([])
    expect(decisions.problems[0]).toMatch(/^Case results is not valid JSON: /)
  })
  it('rejects Mutation Ledger entries that do not match the run contract', async () => {
    const { store } = await openPreparedStore()
    await writeJson(store.layout.mutationLedgerPath, [ledgerEntry({ risk: 'read' }), ledgerEntry({ id: 'mutation-2', createdAt: 'not-a-timestamp' })])

    const ledger = await store.readMutationLedger()
    expect(ledger.entries).toEqual([])
    expect(ledger.problems).toHaveLength(2)
    expect(ledger.problems[0]).toBe('Mutation Ledger entry 0 does not match the run contract')
    expect(ledger.problems[1]).toBe('Mutation Ledger entry 1 does not match the run contract')
  })
})
