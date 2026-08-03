import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recoverCodexDeliveryResult } from '../src/agent/delivery-recovery.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function manifest(): WorkflowIntakeManifest {
  return {
    version: '1.0',
    kind: 'workflow-intake',
    workflowId: 'fixture-workflow',
    source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'a'.repeat(64) },
    targetUrls: ['https://fixture.example.test/'],
    requiredCapabilities: [],
    phases: [
      { id: 'case-1', sourceCaseId: 'case-1', title: 'Read', sourceRow: 2, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
      { id: 'case-2', sourceCaseId: 'case-2', title: 'Write', sourceRow: 3, risk: 'write', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
    ],
    embeddedImages: [],
    supplementalImages: [],
    review: { status: 'draft', reasons: [] },
  }
}

describe('Codex delivery recovery', () => {
  it('accepts a complete same-run artifact after structured response transport failure', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-delivery-recovery-'))
    directories.push(directory)
    await mkdir(resolve(directory, 'evidence'))
    await writeFile(resolve(directory, 'evidence', 'case-1.md'), 'observed')
    await writeFile(resolve(directory, 'test-manifest.json'), '{}')
    const artifactPath = resolve(directory, 'case-results.json')
    await writeFile(artifactPath, JSON.stringify({
      version: '1.0',
      kind: 'case-results',
      workflowId: 'fixture-workflow',
      sourceSha256: 'a'.repeat(64),
      generatedAt: '2026-08-03T00:01:00.000Z',
      cases: [
        { caseId: 'case-1', outcome: 'passed', summary: 'Observed', evidencePaths: ['evidence/case-1.md', 'test-manifest.json'] },
        { caseId: 'case-2', outcome: 'blocked', summary: 'Write was not authorized', blockers: ['allowedRisk=read'], failureSource: 'input', failureKind: 'validation', evidencePaths: [] },
      ],
      mutationLedger: { state: 'terminal', pendingCount: 0, entries: [] },
    }))

    const recovered = await recoverCodexDeliveryResult({ artifactPath, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z' })

    expect(recovered.problems).toEqual([])
    expect(recovered.result?.outcome).toBe('blocked')
    expect(recovered.result?.cases).toHaveLength(2)
    expect(recovered.result?.cases[0]).toMatchObject({ caseId: 'case-1', outcome: 'passed' })
    expect(recovered.result?.cases[1]).toMatchObject({ caseId: 'case-2', outcome: 'blocked', failureSource: 'input', failureKind: 'validation' })
    expect(recovered.result?.cases[1]?.evidence).not.toHaveLength(0)
    expect(recovered.result?.cases[0]?.evidence.map((item) => item.path)).toContain('test-manifest.json')
  })

  it('rejects stale or incomplete artifacts instead of guessing a result', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-delivery-recovery-invalid-'))
    directories.push(directory)
    const artifactPath = resolve(directory, 'case-results.json')
    await writeFile(artifactPath, JSON.stringify({
      version: '1.0',
      kind: 'case-results',
      workflowId: 'other-workflow',
      sourceSha256: 'b'.repeat(64),
      generatedAt: '2026-08-03T00:01:00.000Z',
      cases: [],
      mutationLedger: { state: 'terminal', pendingCount: 1, entries: [{}] },
    }))

    const recovered = await recoverCodexDeliveryResult({ artifactPath, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z' })

    expect(recovered.result).toBeUndefined()
    expect(recovered.problems).toEqual(expect.arrayContaining([
      expect.stringContaining('workflowId'),
      expect.stringContaining('sourceSha256'),
      expect.stringContaining('missing case case-1'),
      expect.stringContaining('unresolved mutations'),
    ]))
  })

  it('rejects an unclassified delivery artifact instead of inferring a business failure source', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-delivery-recovery-unclassified-'))
    directories.push(directory)
    const artifactPath = resolve(directory, 'case-results.json')
    await writeFile(artifactPath, JSON.stringify({
      version: '1.0',
      kind: 'case-results',
      workflowId: 'fixture-workflow',
      sourceSha256: 'a'.repeat(64),
      generatedAt: '2026-08-03T00:01:00.000Z',
      cases: [
        { caseId: 'case-1', outcome: 'passed', summary: 'Observed', evidencePaths: [] },
        { caseId: 'case-2', outcome: 'blocked', summary: 'A dependency was unavailable', evidencePaths: [] },
      ],
      mutationLedger: { state: 'terminal', pendingCount: 0, entries: [] },
    }))

    const recovered = await recoverCodexDeliveryResult({ artifactPath, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z' })

    expect(recovered.result).toBeUndefined()
    expect(recovered.problems).toContain('Codex delivery artifact non-passed case case-2 has no explicit failure classification')
  })

  it('preserves an explicit infrastructure classification from the Codex artifact', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-delivery-recovery-infrastructure-'))
    directories.push(directory)
    const artifactPath = resolve(directory, 'case-results.json')
    await writeFile(artifactPath, JSON.stringify({
      version: '1.0',
      kind: 'case-results',
      workflowId: 'fixture-workflow',
      sourceSha256: 'a'.repeat(64),
      generatedAt: '2026-08-03T00:01:00.000Z',
      cases: [
        { caseId: 'case-1', outcome: 'passed', summary: 'Observed', evidencePaths: [] },
        { caseId: 'case-2', outcome: 'blocked', summary: 'Browser transport disconnected', failureSource: 'infrastructure', failureKind: 'execution', evidencePaths: [] },
      ],
      mutationLedger: { state: 'terminal', pendingCount: 0, entries: [] },
    }))

    const recovered = await recoverCodexDeliveryResult({ artifactPath, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z' })

    expect(recovered.problems).toEqual([])
    expect(recovered.result?.cases[1]).toMatchObject({ failureSource: 'infrastructure', failureKind: 'execution' })
  })

  it('rejects an evidence path that escapes the Codex workspace', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-delivery-recovery-escape-'))
    directories.push(directory)
    const artifactPath = resolve(directory, 'case-results.json')
    await writeFile(artifactPath, JSON.stringify({
      version: '1.0', kind: 'case-results', workflowId: 'fixture-workflow', sourceSha256: 'a'.repeat(64), generatedAt: '2026-08-03T00:01:00.000Z',
      cases: [
        { caseId: 'case-1', outcome: 'passed', summary: 'Observed', evidencePaths: ['../outside.md'] },
        { caseId: 'case-2', outcome: 'blocked', summary: 'No target permission', failureSource: 'environment', failureKind: 'environment', blockers: ['permission'], evidencePaths: [] },
      ],
      mutationLedger: { state: 'terminal', pendingCount: 0, entries: [] },
    }))

    const recovered = await recoverCodexDeliveryResult({ artifactPath, manifest: manifest(), startedAt: '2026-08-03T00:00:00.000Z' })

    expect(recovered.result).toBeUndefined()
    expect(recovered.problems).toContain('Codex delivery artifact case case-1 references missing evidence ../outside.md')
  })
})
