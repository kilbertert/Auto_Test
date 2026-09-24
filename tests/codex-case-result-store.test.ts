import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EnvironmentProfile } from '../src/workflow/environment-profile.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'
import { prepareAgentWorkspace } from '../src/agent/workspace.js'
import { openRunArtifactStore, type RunArtifactStore } from '../src/agent/run-artifact-store.js'
import type { CodexTestCaseResult } from '../src/agent/types.js'

/**
 * The per-case result journal as seen at the store seam: one hashed record per
 * recorded Case, whose read-back identity and storage identity the store owns.
 */
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const manifest: WorkflowIntakeManifest = {
  version: '1.0', kind: 'workflow-intake', workflowId: 'store-fixture',
  source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'b'.repeat(64) },
  targetUrls: ['https://example.test/'], requiredCapabilities: [],
  phases: [{ id: 'case-one', title: 'Case one', sourceRow: 2, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } }],
  embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
}

const profile: EnvironmentProfile = {
  id: 'store-fixture',
  origins: ['https://example.test'],
  auth: [],
  policy: { allowWrite: false, allowDestructive: false },
}

async function openStore(): Promise<{ store: RunArtifactStore; runRoot: string }> {
  const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-case-store-'))
  directories.push(directory)
  const runRoot = resolve(directory, 'run')
  await prepareAgentWorkspace({
    outputDirectory: runRoot,
    manifest,
    profile,
    secrets: {},
    headed: false,
    browserExecutablePath: '/verified/chromium',
    environment: { PATH: '/usr/bin' },
  })
  return { store: openRunArtifactStore({ runRoot, manifest }), runRoot }
}

function result(summary: string): CodexTestCaseResult {
  return { caseId: 'case-one', title: 'Case one', outcome: 'passed', summary, evidence: [{ kind: 'observation', description: summary }] }
}

describe('per-case result store', () => {
  it('writes idempotent case records and validates run identity', async () => {
    const { store } = await openStore()

    await store.recordCaseResults({ epochId: 'epoch-0001', cases: [result('first')] })
    await store.recordCaseResults({ epochId: 'epoch-0001', cases: [result('updated')] })

    const records = await store.readCaseResultRecords()
    expect(records.problems).toEqual([])
    expect(records.entries).toHaveLength(1)
    expect(records.entries[0]?.result.summary).toBe('updated')
    expect(await readdir(store.layout.caseResultRecordsDirectory)).toHaveLength(1)
    expect((await readFile(store.caseResultRecordPath('case-one'), 'utf8')).length).toBeGreaterThan(0)
  })

  it('rejects a record whose run identity does not match the current run', async () => {
    const { store, runRoot } = await openStore()
    await store.recordCaseResults({ epochId: 'epoch-0001', cases: [result('first')] })
    const stored = JSON.parse(await readFile(store.caseResultRecordPath('case-one'), 'utf8')) as Record<string, unknown>

    const otherRun = openRunArtifactStore({ runRoot, manifest: { ...manifest, workflowId: 'different-run' } })
    const records = await otherRun.readCaseResultRecords()

    expect(records.entries).toEqual([])
    expect(records.problems.join(' ')).toMatch(/identity does not match/)
    expect(JSON.parse(await readFile(store.caseResultRecordPath('case-one'), 'utf8'))).toEqual(stored)
  })
})
