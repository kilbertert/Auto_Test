import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EnvironmentProfile } from '../src/workflow/environment-profile.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'
import { prepareAgentWorkspace } from '../src/agent/workspace.js'
import { normalizeEnvironmentOrigin, openRunArtifactStore, type RunArtifactStore } from '../src/agent/run-artifact-store.js'

/**
 * The environment requirement journal as seen at the store seam: recording a
 * prerequisite, satisfying it, and reconciling it against the run's own case
 * results all belong to the artifact the store owns.
 */
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const manifest: WorkflowIntakeManifest = {
  version: '1.0', kind: 'workflow-intake', workflowId: 'environment-fixture',
  source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'd'.repeat(64) },
  targetUrls: ['https://app.example.test/'], requiredCapabilities: [],
  phases: [
    { id: 'case-allowed', title: 'Case allowed', sourceRow: 2, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
    { id: 'case-blocked', title: 'Case blocked', sourceRow: 3, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
    { id: 'case-filter', title: 'Case filter', sourceRow: 4, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
    { id: 'case-environment', title: 'Case environment', sourceRow: 5, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
    { id: 'case-product', title: 'Case product', sourceRow: 6, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
    { id: 'case-input', title: 'Case input', sourceRow: 7, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
    { id: 'case-a', title: 'Case a', sourceRow: 8, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
    { id: 'case-b', title: 'Case b', sourceRow: 9, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
  ],
  embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
}

const profile: EnvironmentProfile = {
  id: 'environment-fixture',
  origins: ['https://app.example.test'],
  auth: [],
  policy: { allowWrite: false, allowDestructive: false },
}

async function openStore(): Promise<RunArtifactStore> {
  const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-origin-gate-'))
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
  return openRunArtifactStore({ runRoot, manifest })
}

describe('environment access requirements', () => {
  it('normalizes allowed origin checks without allowing unregistered navigation', async () => {
    const store = await openStore()

    expect(normalizeEnvironmentOrigin('https://app.example.test/path?next=1')).toBe('https://app.example.test')
    await expect(store.requestEnvironmentAccess({
      allowedOrigins: ['https://app.example.test'],
      origin: 'https://app.example.test/path',
      reason: 'same registered application',
      evidence: [],
      caseIds: ['case-allowed'],
    })).resolves.toMatchObject({ status: 'allowed', origin: 'https://app.example.test' })

    const blocked = await store.requestEnvironmentAccess({
      allowedOrigins: ['https://app.example.test'],
      origin: 'https://admin.example.test/virtual/device',
      reason: 'page evidence linked to an admin console',
      evidence: ['image:device-route'],
      caseIds: ['case-blocked'],
    })
    expect(blocked).toMatchObject({ status: 'blocked', origin: 'https://admin.example.test' })
    const requirements = await store.readEnvironmentRequirements()
    expect(requirements.problems).toEqual([])
    expect(requirements.entries).toHaveLength(1)
    expect(await readFile(store.layout.environmentRequirementsPath, 'utf8')).not.toContain('/virtual/device')

    const reconciled = await store.reconcileEnvironmentRequirements(['https://app.example.test', 'https://admin.example.test'])
    expect(reconciled[0]).toMatchObject({ origin: 'https://admin.example.test', status: 'satisfied' })
    expect((await store.readEnvironmentRequirements()).entries[0]?.status).toBe('satisfied')
  })

  it('records generic environment prerequisites with case linkage and evidence', async () => {
    const store = await openStore()

    const requirement = await store.recordEnvironmentRequirement({
      caseIds: ['case-filter'],
      kind: 'test_data',
      condition: 'The requested historical record was absent after the available read-only controls were applied.',
      evidence: ['evidence/filter-state.png'],
    })

    expect(requirement).toMatchObject({
      id: expect.stringMatching(/^environment-test_data-/),
      caseIds: ['case-filter'], kind: 'test_data', status: 'pending', evidence: ['evidence/filter-state.png'],
    })
    await expect(store.recordEnvironmentRequirement({
      caseIds: ['case-filter'], kind: 'test_data', condition: 'Missing evidence', evidence: [],
    })).rejects.toThrow(/saved evidence/)
    await expect(store.satisfyEnvironmentRequirement({
      id: requirement.id,
      evidence: ['evidence/resolved.png'],
    })).resolves.toMatchObject({ status: 'satisfied', evidence: ['evidence/filter-state.png', 'evidence/resolved.png'] })
  })

  it('removes stale case links from a shared pending requirement after explicit non-environment results', async () => {
    const store = await openStore()
    const requirement = await store.recordEnvironmentRequirement({
      caseIds: ['case-environment', 'case-product', 'case-input'],
      kind: 'test_data',
      condition: 'The shared fixture is unavailable.',
      evidence: ['evidence/shared-fixture.md'],
    })

    const reconciled = await store.reconcileEnvironmentRequirementCaseLinks([
      {
        caseId: 'case-environment',
        failureSource: 'environment',
        environmentRequirementIds: [requirement.id],
      },
      { caseId: 'case-product', failureSource: 'product' },
      { caseId: 'case-input', failureSource: 'input' },
    ])

    expect(reconciled[0]).toMatchObject({ id: requirement.id, status: 'pending', caseIds: ['case-environment'] })
    expect((await store.readEnvironmentRequirements()).entries[0]?.caseIds).toEqual(['case-environment'])
  })

  it('supersedes an orphaned requirement but preserves an environment case missing its reference', async () => {
    const store = await openStore()
    const requirement = await store.recordEnvironmentRequirement({
      caseIds: ['case-a', 'case-b'],
      kind: 'test_data',
      condition: 'The fixture is unavailable.',
      evidence: ['evidence/fixture.md'],
    })

    await expect(store.reconcileEnvironmentRequirementCaseLinks([
      { caseId: 'case-a', failureSource: 'product' },
      { caseId: 'case-b', failureSource: 'input' },
    ])).resolves.toEqual([{ ...requirement, status: 'superseded' }])
    await store.recordEnvironmentRequirement({
      caseIds: ['case-a', 'case-b'],
      kind: 'test_data',
      condition: 'The fixture is unavailable.',
      evidence: ['evidence/fixture-again.md'],
    })
    await expect(store.reconcileEnvironmentRequirementCaseLinks([
      { caseId: 'case-a', failureSource: 'environment', environmentRequirementIds: [] },
      { caseId: 'case-b', failureSource: 'product' },
    ])).resolves.toEqual([{ ...requirement, caseIds: ['case-a'], evidence: ['evidence/fixture.md', 'evidence/fixture-again.md'], requestedAt: expect.any(String) }])
  })

  it('supersedes an older shared requirement when environment cases cite newer requirement ids', async () => {
    const store = await openStore()
    const requirement = await store.recordEnvironmentRequirement({
      caseIds: ['case-a', 'case-b'],
      kind: 'test_data',
      condition: 'The broad fixture is unavailable.',
      evidence: ['evidence/broad.md'],
    })

    await expect(store.reconcileEnvironmentRequirementCaseLinks([
      { caseId: 'case-a', failureSource: 'environment', environmentRequirementIds: ['environment-test_data-new-a'] },
      { caseId: 'case-b', failureSource: 'environment', environmentRequirementIds: ['environment-test_data-new-b'] },
    ])).resolves.toEqual([{ ...requirement, status: 'superseded' }])
  })
})
