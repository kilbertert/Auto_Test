import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentProfile } from '../src/workflow/environment-profile.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'
import { prepareAgentWorkspace } from '../src/agent/workspace.js'
import { runArtifactLayout, type OpenRunArtifactStoreOptions, type RunArtifactStore } from '../src/agent/run-artifact-store.js'

/**
 * Every run journal initialization the workspace performs, as seen at the store
 * seam. A workspace that still derives paths or writes journal files itself
 * never appears here.
 */
const { initializations } = vi.hoisted(() => ({
  initializations: [] as Array<{ runRoot: string; resume: boolean }>,
}))

vi.mock('../src/agent/run-artifact-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/run-artifact-store.js')>()
  return {
    ...actual,
    openRunArtifactStore: (options: OpenRunArtifactStoreOptions): RunArtifactStore => {
      const store = actual.openRunArtifactStore(options)
      const initialize = store.initialize.bind(store)
      return Object.assign(store, {
        initialize: async (input: { resume: boolean }): Promise<void> => {
          initializations.push({ runRoot: store.runRoot, resume: input.resume })
          await initialize(input)
        },
      })
    },
  }
})

const directories: string[] = []

beforeEach(() => initializations.splice(0))
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const manifest: WorkflowIntakeManifest = {
  version: '1.0',
  kind: 'workflow-intake',
  workflowId: 'workspace-journal-fixture',
  source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'c'.repeat(64) },
  targetUrls: ['https://journal.example.test/app'],
  requiredCapabilities: [],
  phases: [{
    id: 'inspect-board',
    title: 'Inspect board',
    sourceRow: 2,
    risk: 'read',
    steps: [{ id: 'step-1', sourceText: 'Open the board', confidence: 1 }],
    resources: [],
    secretBindings: [],
    imageIds: [],
    review: { status: 'draft', ambiguities: [] },
  }],
  embeddedImages: [],
  supplementalImages: [],
  review: { status: 'draft', reasons: [] },
}

const profile: EnvironmentProfile = {
  id: 'workspace-journal-fixture',
  origins: ['https://journal.example.test'],
  auth: [],
  policy: { allowWrite: false, allowDestructive: false },
}

function prepare(runRoot: string, resume = false) {
  return prepareAgentWorkspace({
    outputDirectory: runRoot,
    manifest,
    profile,
    secrets: {},
    headed: false,
    browserExecutablePath: '/verified/chromium',
    environment: { PATH: '/usr/bin' },
    ...(resume ? { resume: true } : {}),
  })
}

function journalLayout(runRoot: string): string[] {
  const layout = runArtifactLayout(runRoot)
  return [
    layout.mutationLedgerPath,
    layout.environmentRequirementsPath,
    layout.executionReceiptsPath,
    layout.fieldCompositionsPath,
    layout.caseResultsPath,
  ]
}

async function tempRunRoot(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-workspace-journal-'))
  directories.push(directory)
  return resolve(directory, 'run')
}

describe('workspace run journal storage', () => {
  it('initializes a new run journal through the RunArtifactStore', async () => {
    const runRoot = await tempRunRoot()

    const workspace = await prepare(runRoot)

    expect(initializations).toEqual([{ runRoot: resolve(runRoot), resume: false }])
    const layout = runArtifactLayout(runRoot)
    expect(workspace.mutationLedgerPath).toBe(layout.mutationLedgerPath)
    expect(workspace.environmentRequirementsPath).toBe(layout.environmentRequirementsPath)
    expect(workspace.executionReceiptsPath).toBe(layout.executionReceiptsPath)
    expect(workspace.fieldCompositionPath).toBe(layout.fieldCompositionsPath)
    expect(workspace.caseResultsPath).toBe(layout.caseResultsPath)
    expect(workspace.manifestPath).toBe(layout.manifestPath)
  })

  it('initializes a resumed run journal through the RunArtifactStore', async () => {
    const runRoot = await tempRunRoot()
    const initial = await prepare(runRoot)
    await writeFile(initial.mutationLedgerPath, JSON.stringify([{
      id: 'pending-action', caseId: 'inspect-board', description: 'Create one record', risk: 'write', status: 'pending',
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', evidence: [],
    }]))
    await rm(resolve(runRoot, 'agent-workspace', 'execution-receipts.json'), { force: true })

    const resumed = await prepare(runRoot, true)

    expect(initializations).toEqual([
      { runRoot: resolve(runRoot), resume: false },
      { runRoot: resolve(runRoot), resume: true },
    ])
    expect(JSON.parse(await readFile(resumed.mutationLedgerPath, 'utf8'))).toHaveLength(1)
    expect(JSON.parse(await readFile(resumed.executionReceiptsPath, 'utf8'))).toEqual([])
  })

  it('keeps the private permissions and atomic journal writes the store already guarantees', async () => {
    const runRoot = await tempRunRoot()

    const workspace = await prepare(runRoot)

    for (const path of journalLayout(runRoot)) {
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([])
    }
    if (process.platform !== 'win32') {
      expect((await stat(workspace.privateDirectory)).mode & 0o777).toBe(0o700)
      for (const path of journalLayout(runRoot)) {
        expect((await stat(path)).mode & 0o777).toBe(0o600)
      }
    }
    expect((await readdir(workspace.privateDirectory)).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('still refuses a resume whose run identity does not match the persisted run', async () => {
    const runRoot = await tempRunRoot()
    const initial = await prepare(runRoot)
    await writeFile(initial.manifestPath, JSON.stringify({ ...manifest, workflowId: 'another-run' }))

    await expect(prepare(runRoot, true)).rejects.toThrow(/workflow identity/)
  })
})
