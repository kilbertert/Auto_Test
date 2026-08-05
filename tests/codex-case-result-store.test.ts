import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { caseResultDirectory, readCaseResultRecords, writeCaseResultRecords } from '../src/agent/case-result-store.js'
import type { CodexTestCaseResult } from '../src/agent/types.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'

function manifest(): WorkflowIntakeManifest {
  return {
    version: '1.0', kind: 'workflow-intake', workflowId: 'store-fixture',
    source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'b'.repeat(64) },
    targetUrls: ['https://example.test/'], requiredCapabilities: [],
    phases: [{ id: 'case-one', title: 'Case one', sourceRow: 2, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } }],
    embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
  }
}

function result(summary: string): CodexTestCaseResult {
  return { caseId: 'case-one', title: 'Case one', outcome: 'passed', summary, evidence: [{ kind: 'observation', description: summary }] }
}

describe('Codex per-case result store', () => {
  it('writes idempotent case records and validates run identity', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-case-store-'))
    try {
      const store = caseResultDirectory(directory)
      await writeCaseResultRecords(store, manifest(), 'epoch-0001', [result('first')])
      await writeCaseResultRecords(store, manifest(), 'epoch-0001', [result('updated')])
      const records = await readCaseResultRecords(store, manifest())
      expect(records).toHaveLength(1)
      expect(records[0]?.result.summary).toBe('updated')

      const incompatible = { ...manifest(), workflowId: 'different-run' }
      await expect(readCaseResultRecords(store, incompatible)).rejects.toThrow(/identity does not match/)
      expect((await readFile(resolve(store, (await readdir(store))[0]!), 'utf8')).length).toBeGreaterThan(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
