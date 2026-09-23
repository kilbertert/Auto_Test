import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { relative, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EnvironmentProfile } from '../src/workflow/environment-profile.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'
import { prepareAgentWorkspace, type AgentWorkspace } from '../src/agent/workspace.js'
import {
  caseResultRecordFileName,
  openRunArtifactStore,
  openRunArtifactStoreForRun,
  runArtifactLayout,
  type EnvironmentRequirementInput,
  type RunArtifactStore,
} from '../src/agent/run-artifact-store.js'
import type { CodexTestCaseDecision, CodexTestCaseResult, CodexTestFieldCompositionGate } from '../src/agent/types.js'

const directories: string[] = []

const root = resolve(import.meta.dirname, '..')

async function readSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(resolve(root, directory), { recursive: true })
  return entries
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => resolve(root, directory, entry))
}

/** Repo-relative path with forward slashes, so assertions hold on Windows too. */
function repoRelative(file: string): string {
  return relative(root, file).split(sep).join('/')
}

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
    expect(store.caseResultRecordPath('inspect-board')).toBe(
      resolve(store.layout.caseResultRecordsDirectory, caseResultRecordFileName('inspect-board')),
    )
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
    expect(await store.readCaseResultRecords()).toEqual({ entries: [], problems: [] })
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
    expect(await store.readMutationLedger()).toEqual({ entries: [], problems: [] })
  })

  it('refuses to initialize a resume whose source hash does not match the persisted run', async () => {
    const { store } = await openPreparedStore()
    await writeJson(store.layout.manifestPath, { ...manifest, source: { ...manifest.source, sha256: 'b'.repeat(64) } })

    await expect(store.initialize({ resume: true })).rejects.toThrow(/workflow identity/)
  })
})

/**
 * Journal layout ownership. A consumer that re-derives where a journal artifact
 * lives, or re-implements what a stored entry means, is the shallow coupling
 * this module exists to remove, so the layout is pinned from the outside.
 */
describe('RunArtifactStore journal layout ownership', () => {
  it('leaves no journal artifact path derivation outside the store', async () => {
    const sources = await Promise.all(
      (await readSourceFiles('src')).map(async (file) => ({ file, text: await readFile(file, 'utf8') })),
    )

    for (const artifactName of [
      'mutation-ledger.json',
      'environment-requirements.json',
      'field-compositions.json',
      'execution-receipts.json',
    ]) {
      const owners = sources.filter(({ text }) => text.includes(`'${artifactName}'`) || text.includes(`"${artifactName}"`))
      expect(owners.map(({ file }) => repoRelative(file)).sort(), artifactName).toEqual(['src/agent/run-artifact-store.ts'])
    }
  })

  it('removes the compatibility delegates that only forwarded to the store', async () => {
    for (const module of ['case-result-store.ts', 'environment-requirements.ts']) {
      await expect(access(resolve(root, 'src/agent', module)), module).rejects.toThrow()
    }
    const sources = await Promise.all(
      (await readSourceFiles('src')).map(async (file) => ({ file, text: await readFile(file, 'utf8') })),
    )
    for (const module of ['case-result-store.js', 'environment-requirements.js']) {
      const importers = sources.filter(({ text }) => new RegExp(`from '(\\.\\.?/)+${module.replace('.', '\\.')}'`).test(text))
      expect(importers.map(({ file }) => repoRelative(file))).toEqual([])
    }
  })
})

describe('RunArtifactStore missing artifact meaning', () => {
  it('separates a missing artifact that means an empty journal from one that means an error', async () => {
    const runRoot = await tempRunRoot()
    const store = openRunArtifactStore({ runRoot, manifest })

    // The Mutation Ledger is the one artifact whose absence means the run root
    // does not hold an initialized run, so the store reports it as a problem
    // instead of handing back an empty ledger as if nothing had been recorded.
    const ledger = await store.readMutationLedger()
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
      expect(await read).toEqual({ entries: [], problems: [] })
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

describe('RunArtifactStore case result records', () => {
  function deliveredResult(caseId: string, summary: string): CodexTestCaseResult {
    return {
      caseId,
      title: caseId,
      outcome: 'passed',
      summary,
      evidence: [{ kind: 'observation', description: summary }],
    }
  }

  it('appends one record per recorded case and re-records a case without duplicating it', async () => {
    const { store } = await openPreparedStore()

    const first = await store.recordCaseResults({ epochId: 'epoch-0001', cases: [deliveredResult('inspect-board', 'Board rendered')] })
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      version: '1.0',
      workflowId: manifest.workflowId,
      sourceSha256: manifest.source.sha256,
      epochId: 'epoch-0001',
      result: { caseId: 'inspect-board' },
    })

    await store.recordCaseResults({ epochId: 'epoch-0002', cases: [deliveredResult('inspect-board', 'Board rendered again')] })
    const records = await store.readCaseResultRecords()
    expect(records.problems).toEqual([])
    expect(records.entries.map((record) => record.result.summary)).toEqual(['Board rendered again'])
    expect(records.entries[0]?.epochId).toBe('epoch-0002')
  })

  it('rejects a result for a case outside the immutable run instead of storing it', async () => {
    const { store } = await openPreparedStore()

    await expect(store.recordCaseResults({ epochId: 'epoch-0001', cases: [deliveredResult('retired-case', 'Ignored')] }))
      .rejects.toThrow(/unknown case retired-case/)
    expect(await store.readCaseResultRecords()).toEqual({ entries: [], problems: [] })
  })

  it('rejects two results for one case in a single append', async () => {
    const { store } = await openPreparedStore()

    await expect(store.recordCaseResults({
      epochId: 'epoch-0001',
      cases: [deliveredResult('inspect-board', 'first'), deliveredResult('inspect-board', 'second')],
    })).rejects.toThrow(/duplicate result for case inspect-board/)
  })

  it('rejects a stored record whose run identity does not match the current run', async () => {
    const { store } = await openPreparedStore()
    await writeJson(store.caseResultRecordPath('inspect-board'), { ...caseResult('inspect-board'), workflowId: 'another-run' })

    const records = await store.readCaseResultRecords()
    expect(records.entries).toEqual([])
    expect(records.problems.join(' ')).toMatch(/identity does not match the current run/)
  })

  it('rejects a stored record whose storage identity does not match its case', async () => {
    const { store } = await openPreparedStore()
    await writeJson(resolve(store.layout.caseResultRecordsDirectory, 'plain-name.json'), caseResult('inspect-board'))

    const records = await store.readCaseResultRecords()
    expect(records.entries).toEqual([])
    expect(records.problems.join(' ')).toMatch(/storage identity is invalid/)
  })
})

/**
 * Composite-field gates and published case decisions are the optional
 * diagnostic journal of a run: the store still owns where each one lives, that a
 * Case keeps exactly one of each, and that a write never overwrites a journal it
 * cannot attribute to this run.
 */
describe('RunArtifactStore field composition gates and case result decisions', () => {
  function fieldGate(caseId: string, fieldId: string, status: 'passed' | 'blocked' = 'passed'): CodexTestFieldCompositionGate {
    return {
      id: `${caseId}:${fieldId}`,
      caseId,
      fieldId,
      logicalValueRef: `workflow.${fieldId}`,
      purpose: 'Represent one logical value across two controls',
      components: [],
      rendered: [],
      evidence: ['evidence/live-note.md'],
      status,
      reasons: [],
      checkedAt: '2026-09-01T00:00:00.000Z',
    }
  }

  function decision(caseId: string, outcome: 'passed' | 'product_failed' | 'blocked'): CodexTestCaseDecision {
    return {
      caseId,
      outcome,
      summary: `${caseId} ${outcome}`,
      blockers: outcome === 'blocked' ? ['The board needs one hardware key plugged in'] : [],
      productDefects: outcome === 'product_failed' ? ['The expected total was not retained'] : [],
      recordedAt: '2026-09-01T00:00:00.000Z',
    }
  }

  it('records one gate per case and re-records the same gate without duplicating it', async () => {
    const { store } = await openPreparedStore()

    await store.recordFieldCompositionGate(fieldGate('inspect-board', 'budget-value'))
    await store.recordFieldCompositionGate(fieldGate('place-order', 'budget-value', 'blocked'))
    await store.recordFieldCompositionGate(fieldGate('inspect-board', 'budget-value', 'blocked'))

    const gates = await store.readFieldCompositionGates()
    expect(gates.problems).toEqual([])
    expect(gates.entries.map((gate) => [gate.id, gate.status])).toEqual([
      ['inspect-board:budget-value', 'blocked'],
      ['place-order:budget-value', 'blocked'],
    ])
  })

  it('publishes one decision per case and replaces that case earlier decision', async () => {
    const { store } = await openPreparedStore()

    await store.recordCaseResultDecision(decision('inspect-board', 'blocked'))
    await store.recordCaseResultDecision(decision('place-order', 'passed'))
    await store.recordCaseResultDecision(decision('inspect-board', 'passed'))

    const decisions = await store.readCaseResultDecisions()
    expect(decisions.problems).toEqual([])
    expect(decisions.entries.map((item) => [item.caseId, item.outcome])).toEqual([
      ['inspect-board', 'passed'],
      ['place-order', 'passed'],
    ])
  })

  it('rejects a diagnostic write for a case outside the immutable run instead of storing it', async () => {
    const { store } = await openPreparedStore()

    await expect(store.recordFieldCompositionGate(fieldGate('retired-case', 'budget-value')))
      .rejects.toThrow(/unknown case retired-case/)
    await expect(store.recordCaseResultDecision(decision('retired-case', 'passed')))
      .rejects.toThrow(/unknown case retired-case/)
    expect((await store.readFieldCompositionGates()).entries).toEqual([])
    expect((await store.readCaseResultDecisions()).entries).toEqual([])
  })

  it('refuses to overwrite a diagnostic journal it cannot attribute to this run', async () => {
    const { store } = await openPreparedStore()
    await writeJson(store.layout.caseResultsPath, [decision('retired-case', 'passed')])

    await expect(store.recordCaseResultDecision(decision('place-order', 'passed')))
      .rejects.toThrow(/unknown case retired-case/)
    expect(JSON.parse(await readFile(store.layout.caseResultsPath, 'utf8'))).toHaveLength(1)
  })
})

describe('RunArtifactStore execution receipts', () => {  function event(item: Record<string, unknown>): unknown {
    return { type: 'item.completed', item }
  }

  it('records receipts through the canonical receipt artifact of the run', async () => {
    const { store, workspace } = await openPreparedStore()
    const recorder = await store.openExecutionReceiptRecorder({ caseIds: ['place-order'] })

    await recorder.observe({ type: 'turn.started' })
    await recorder.observe(event({ id: 'begin', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'place-order' }, status: 'completed' }))
    await recorder.observe(event({ id: 'click', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_click', arguments: {}, result: {}, status: 'completed' }))

    const receipts = await store.readExecutionReceipts()
    expect(receipts.problems).toEqual([])
    expect(receipts.entries.map((receipt) => receipt.id)).toEqual(['single-thread:turn-0001:click'])
    expect(workspace.executionReceiptsPath).toBe(store.layout.executionReceiptsPath)
    expect(JSON.parse(await readFile(store.layout.executionReceiptsPath, 'utf8'))).toHaveLength(1)
  })

  it('rejects a case episode outside the immutable run before recording anything', async () => {
    const { store } = await openPreparedStore()
    const recorder = await store.openExecutionReceiptRecorder({ caseIds: ['inspect-board'] })

    await expect(recorder.observe(event({
      id: 'begin', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'retired-case' }, status: 'completed',
    }))).rejects.toThrow(/unknown case/i)
    expect((await store.readExecutionReceipts()).entries).toEqual([])
  })
})

describe('RunArtifactStore environment requirements', () => {
  function requirementInput(caseIds: string[], condition: string): EnvironmentRequirementInput {
    return { caseIds, kind: 'test_data', condition, evidence: ['evidence/fixture.md'] }
  }

  it('appends an observed prerequisite and merges a repeat observation into the same entry', async () => {
    const { store } = await openPreparedStore()

    const first = await store.recordEnvironmentRequirement(requirementInput(['place-order'], 'The fixture is unavailable.'))
    expect(first).toMatchObject({ id: expect.stringMatching(/^environment-test_data-/), caseIds: ['place-order'], status: 'pending' })

    const merged = await store.recordEnvironmentRequirement(requirementInput(['inspect-board'], 'The fixture is unavailable.'))
    expect(merged.id).toBe(first.id)
    expect(merged.caseIds).toEqual(['place-order', 'inspect-board'])
    const read = await store.readEnvironmentRequirements()
    expect(read.problems).toEqual([])
    expect(read.entries).toHaveLength(1)
  })

  it('transitions a pending prerequisite to satisfied and keeps the evidence of both observations', async () => {
    const { store } = await openPreparedStore()
    const recorded = await store.recordEnvironmentRequirement(requirementInput(['place-order'], 'The fixture is unavailable.'))

    const satisfied = await store.satisfyEnvironmentRequirement({ id: recorded.id, evidence: ['evidence/resolved.md'] })
    expect(satisfied).toMatchObject({
      status: 'satisfied',
      evidence: ['evidence/fixture.md', 'evidence/resolved.md'],
    })
    expect((await store.readEnvironmentRequirements()).entries[0]?.status).toBe('satisfied')
    await expect(store.satisfyEnvironmentRequirement({ id: recorded.id, evidence: [] })).rejects.toThrow(/saved evidence/)
  })

  it('rejects an observation for a case outside the immutable run', async () => {
    const { store } = await openPreparedStore()

    await expect(store.recordEnvironmentRequirement(requirementInput(['retired-case'], 'The fixture is unavailable.')))
      .rejects.toThrow(/unknown case retired-case/)
  })

  it('refuses to append to a journal the read path rejects, instead of preserving a foreign entry', async () => {
    const { store } = await openPreparedStore()
    // A requirement naming a Case outside the immutable run is exactly what the read path rejects.
    await writeFile(store.layout.environmentRequirementsPath, JSON.stringify([{
      id: 'environment-origin-foreign',
      caseIds: ['case-from-another-run'],
      kind: 'origin',
      origin: 'https://foreign.example.test',
      condition: 'observed on another run',
      evidence: ['evidence/foreign.md'],
      status: 'pending',
      requestedAt: new Date(0).toISOString(),
    }]), 'utf8')
    expect((await store.readEnvironmentRequirements()).problems).toHaveLength(1)

    // The write path must answer identity the same way the read path does: a write that appends
    // beside a rejected entry would leave the journal permanently unreadable, and the run would be
    // blamed for a journal it did not corrupt.
    await expect(store.recordEnvironmentRequirement(requirementInput(['place-order'], 'The fixture is unavailable.')))
      .rejects.toThrow(/unknown case case-from-another-run/)
  })

  it('reports a malformed stored entry as a problem instead of throwing the whole read', async () => {
    const { store } = await openPreparedStore()
    await writeFile(store.layout.environmentRequirementsPath, JSON.stringify([{
      id: 'environment-origin-schemaless',
      caseIds: ['place-order'],
      kind: 'origin',
      origin: 'pay.example.test',
      condition: 'stored without a URL scheme',
      evidence: ['evidence/pay.md'],
      status: 'pending',
      requestedAt: new Date(0).toISOString(),
    }]), 'utf8')

    // Every other malformed journal reports a problem list; the prerequisite journal must not be the
    // one that turns a bad row into a hard failure of the surrounding read.
    const read = await store.readEnvironmentRequirements()
    expect(read.entries).toEqual([])
    expect(read.problems).toHaveLength(1)
    expect(read.problems[0]).toMatch(/malformed/)
  })

  it('records an unregistered origin as a resumable requirement and reconciles it once the origin is registered', async () => {
    const { store } = await openPreparedStore()

    const blocked = await store.requestEnvironmentAccess({
      allowedOrigins: ['https://journal.example.test'],
      origin: 'https://pay.example.test/checkout',
      reason: 'page evidence linked to a payment provider',
      evidence: ['evidence/pay.png'],
      caseIds: ['place-order'],
    })
    expect(blocked).toMatchObject({ status: 'blocked', origin: 'https://pay.example.test' })
    expect(await readFile(store.layout.environmentRequirementsPath, 'utf8')).not.toContain('/checkout')

    const allowed = await store.requestEnvironmentAccess({
      allowedOrigins: ['https://pay.example.test'],
      origin: 'https://pay.example.test/checkout',
      reason: 'page evidence linked to a payment provider',
      evidence: [],
      caseIds: ['place-order'],
    })
    expect(allowed).toMatchObject({ status: 'allowed' })

    const reconciled = await store.reconcileEnvironmentRequirements(['https://pay.example.test'])
    expect(reconciled).toEqual([expect.objectContaining({ status: 'satisfied' })])
    expect((await store.readEnvironmentRequirements()).entries[0]?.status).toBe('satisfied')
  })

  it('supersedes an orphaned prerequisite once none of its cases are environment-blocked', async () => {
    const { store } = await openPreparedStore()
    const recorded = await store.recordEnvironmentRequirement({
      caseIds: ['place-order'],
      kind: 'test_data',
      condition: 'The fixture is unavailable.',
      evidence: ['evidence/fixture.md'],
    })

    const reconciled = await store.reconcileEnvironmentRequirementCaseLinks([
      { caseId: 'place-order', failureSource: 'product' },
    ])
    expect(reconciled).toEqual([{ ...recorded, status: 'superseded' }])
  })
})

describe('RunArtifactStore mutation ledger transitions', () => {
  it('registers a pending mutation and returns the same entry when the same id is registered again', async () => {
    const { store } = await openPreparedStore()

    const pending = await store.recordMutationLedgerEntry({
      id: 'mutation-create', caseId: 'place-order', description: 'Create one business record', risk: 'write',
    })
    expect(pending).toMatchObject({
      id: 'mutation-create', caseId: 'place-order', risk: 'write', status: 'pending', evidence: [],
    })

    expect(await store.recordMutationLedgerEntry({
      id: 'mutation-create', caseId: 'place-order', description: 'Create one business record', risk: 'write',
    })).toEqual(pending)
    const ledger = await store.readMutationLedger()
    expect(ledger.entries).toEqual([pending])
    expect(ledger.problems).toEqual([])
  })

  it('transitions a pending mutation to compensated and merges the verification evidence', async () => {
    const { store } = await openPreparedStore()
    const pending = await store.recordMutationLedgerEntry({
      id: 'mutation-create', caseId: 'place-order', description: 'Create one business record', risk: 'write',
    })

    const compensated = await store.transitionMutationLedgerEntry({
      id: 'mutation-create', status: 'compensated', evidence: ['evidence/compensated.md'],
    })
    expect(compensated).toMatchObject({ status: 'compensated', evidence: ['evidence/compensated.md'] })
    expect(compensated.updatedAt >= pending.updatedAt).toBe(true)

    const recompensated = await store.transitionMutationLedgerEntry({
      id: 'mutation-create', status: 'compensated', evidence: ['evidence/compensated-again.md'],
    })
    expect(recompensated.evidence).toEqual(['evidence/compensated.md', 'evidence/compensated-again.md'])
  })

  it('transitions a pending mutation to an explicitly accepted retained state', async () => {
    const { store } = await openPreparedStore()
    await store.recordMutationLedgerEntry({
      id: 'mutation-create', caseId: 'place-order', description: 'Create one business record', risk: 'write',
    })

    const accepted = await store.transitionMutationLedgerEntry({
      id: 'mutation-create', status: 'accepted', evidence: ['evidence/retained.png'],
    })
    expect(accepted).toMatchObject({ status: 'accepted', evidence: ['evidence/retained.png'] })
    expect((await store.readMutationLedger()).entries[0]?.status).toBe('accepted')
  })

  it('merges a repeat resolution into the resolved entry but never reopens it for a new action', async () => {
    const { store } = await openPreparedStore()
    await store.recordMutationLedgerEntry({
      id: 'mutation-create', caseId: 'place-order', description: 'Create one business record', risk: 'write',
    })
    await store.transitionMutationLedgerEntry({ id: 'mutation-create', status: 'compensated', evidence: ['evidence/compensated.md'] })

    const rerased = await store.transitionMutationLedgerEntry({
      id: 'mutation-create', status: 'accepted', evidence: ['evidence/retained.png'],
    })
    expect(rerased).toMatchObject({
      status: 'accepted',
      evidence: ['evidence/compensated.md', 'evidence/retained.png'],
    })
    await expect(store.recordMutationLedgerEntry({
      id: 'mutation-create', caseId: 'place-order', description: 'Create another business record', risk: 'write',
    })).rejects.toThrow(/terminal/)
  })

  it('rejects a mutation for an unknown mutation id or for a case outside the immutable run', async () => {
    const { store } = await openPreparedStore()

    await expect(store.transitionMutationLedgerEntry({ id: 'missing-mutation', status: 'compensated', evidence: ['evidence/compensated.md'] }))
      .rejects.toThrow(/Unknown mutation id/)
    await expect(store.recordMutationLedgerEntry({
      id: 'mutation-create', caseId: 'retired-case', description: 'Create one business record', risk: 'write',
    })).rejects.toThrow(/unknown case retired-case/)
    expect((await store.readMutationLedger()).entries).toEqual([])
  })

  it('keeps recorded mutations across a resume instead of starting an empty ledger', async () => {
    const { store, runRoot } = await openPreparedStore()
    await store.recordMutationLedgerEntry({
      id: 'mutation-create', caseId: 'place-order', description: 'Create one business record', risk: 'write',
    })

    await openRunArtifactStore({ runRoot, manifest }).initialize({ resume: true })

    const ledger = await store.readMutationLedger()
    expect(ledger.entries.map((entry) => entry.id)).toEqual(['mutation-create'])
    expect(ledger.problems).toEqual([])
  })
})

describe('RunArtifactStore persisted run identity', () => {
  it('opens the journal of a run that persisted its own manifest', async () => {
    const { store, runRoot } = await openPreparedStore()
    await writeJson(store.layout.mutationLedgerPath, [ledgerEntry()])

    const reopened = await openRunArtifactStoreForRun(runRoot)

    expect(reopened.identity).toEqual(store.identity)
    expect((await reopened.readMutationLedger()).entries).toHaveLength(1)
  })

  it('refuses a persisted manifest whose phases name no case instead of opening an identity with an undefined case', async () => {
    const { store, runRoot } = await openPreparedStore()
    await writeJson(store.layout.mutationLedgerPath, [ledgerEntry()])
    const persisted = JSON.parse(await readFile(store.layout.manifestPath, 'utf8')) as WorkflowIntakeManifest
    await writeJson(store.layout.manifestPath, {
      ...persisted,
      phases: persisted.phases.map((phase) => ({ ...phase, id: undefined })),
    })

    await expect(openRunArtifactStoreForRun(runRoot)).rejects.toThrow(/not a valid run identity/)
  })

  it('refuses a business write to a Mutation Ledger the run no longer holds instead of restarting it', async () => {
    const { store } = await openPreparedStore()
    await store.recordMutationLedgerEntry({
      id: 'mutation-create', caseId: 'place-order', description: 'Create one business record', risk: 'write',
    })
    await rm(store.layout.mutationLedgerPath, { force: true })

    // A half-lost ledger must not be recreated as an empty one: that would drop
    // the recorded mutations while the read path reports the run as broken.
    await expect(store.recordMutationLedgerEntry({
      id: 'mutation-next', caseId: 'place-order', description: 'Create one more business record', risk: 'write',
    })).rejects.toThrow(/Mutation Ledger is missing/)
    await expect(store.transitionMutationLedgerEntry({ id: 'mutation-create', status: 'compensated', evidence: ['evidence/compensated.md'] }))
      .rejects.toThrow(/Mutation Ledger is missing/)
    expect(await access(store.layout.mutationLedgerPath).then(() => true, () => false)).toBe(false)
    expect((await store.readMutationLedger()).problems).toHaveLength(1)
  })
})

describe('RunArtifactStore unreadable journal artifacts', () => {
  it('reports a receipts or requirements artifact that is not a JSON array with the same problem shape as the other journals', async () => {
    const { store } = await openPreparedStore()
    await writeFile(store.layout.executionReceiptsPath, '{"entries": []}')
    await writeFile(store.layout.environmentRequirementsPath, '{"entries": []}')

    expect((await store.readExecutionReceipts()).problems)
      .toEqual(['Execution receipts is invalid: expected a JSON array of entries'])
    expect((await store.readExecutionReceipts()).entries).toEqual([])
    expect((await store.readEnvironmentRequirements()).problems)
      .toEqual(['Environment requirements is invalid: expected a JSON array of entries'])
    expect((await store.readEnvironmentRequirements()).entries).toEqual([])
  })

  it('reports an artifact that is not valid JSON as unreadable instead of empty', async () => {
    const { store } = await openPreparedStore()
    await writeFile(store.layout.executionReceiptsPath, 'not json')
    await writeFile(store.layout.environmentRequirementsPath, 'not json')

    expect((await store.readExecutionReceipts()).problems[0]).toMatch(/^Execution receipts is not valid JSON: /)
    expect((await store.readEnvironmentRequirements()).problems[0]).toMatch(/^Environment requirements is not valid JSON: /)
  })
})
