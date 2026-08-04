import { describe, expect, it } from 'vitest'
import { buildCodexCaseWindows, DEFAULT_CODEX_CASE_BATCH_SIZE, manifestForCaseWindow } from '../src/agent/case-windows.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'

function manifest(caseCount: number): WorkflowIntakeManifest {
  return {
    version: '1.0', kind: 'workflow-intake', workflowId: 'case-window-fixture',
    source: { format: 'xlsx', fileName: 'cases.xlsx', sheetName: 'Cases', sha256: 'a'.repeat(64) },
    targetUrls: ['https://example.test'], requiredCapabilities: [],
    phases: Array.from({ length: caseCount }, (_, index) => ({
      id: `case-${String(index + 1).padStart(3, '0')}`,
      title: `Case ${index + 1}`,
      sourceRow: index + 2,
      risk: 'read' as const,
      steps: [{ id: `step-${index + 1}`, sourceText: `Execute case ${index + 1}`, confidence: 1 }],
      resources: [], secretBindings: [], imageIds: [], review: { status: 'draft' as const, ambiguities: [] },
    })),
    embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
  }
}

describe('Codex case windows', () => {
  it('uses a bounded default context window', () => {
    const workflow = manifest(17)
    expect(DEFAULT_CODEX_CASE_BATCH_SIZE).toBe(8)
    expect(buildCodexCaseWindows(workflow).map((window) => window.caseIds.length)).toEqual([8, 8, 1])
  })

  it('partitions a long suite without reordering, dropping, or duplicating cases', () => {
    const workflow = manifest(55)
    const windows = buildCodexCaseWindows(workflow, 24)

    expect(windows.map((item) => item.caseIds.length)).toEqual([24, 24, 7])
    expect(windows.flatMap((item) => item.caseIds)).toEqual(workflow.phases.map((phase) => phase.id))
    expect(new Set(windows.flatMap((item) => item.caseIds)).size).toBe(55)
    expect(windows.map((item) => item.id)).toEqual(['batch-0001', 'batch-0002', 'batch-0003'])
  })

  it('creates a scoped manifest that preserves immutable workflow identity', () => {
    const workflow = manifest(3)
    workflow.phases[0]!.imageIds = ['image-a']
    workflow.phases[2]!.imageIds = ['image-c']
    workflow.embeddedImages = [
      { id: 'image-a', sheetName: 'Cases', sourceCell: 'A2', sourceRow: 2, fileName: 'a.png', mediaType: 'image/png', bytes: 1, sha256: 'b'.repeat(64), reviewStatus: 'required' },
      { id: 'image-c', sheetName: 'Cases', sourceCell: 'A4', sourceRow: 4, fileName: 'c.png', mediaType: 'image/png', bytes: 1, sha256: 'c'.repeat(64), reviewStatus: 'required' },
    ]
    const [window] = buildCodexCaseWindows(workflow, 2)
    const scoped = manifestForCaseWindow(workflow, window!)

    expect(scoped.workflowId).toBe(workflow.workflowId)
    expect(scoped.source.sha256).toBe(workflow.source.sha256)
    expect(scoped.phases.map((phase) => phase.id)).toEqual(['case-001', 'case-002'])
    expect(scoped.embeddedImages.map((image) => image.id)).toEqual(['image-a'])
  })

  it('rejects invalid batch sizes', () => {
    expect(() => buildCodexCaseWindows(manifest(1), 0)).toThrow(/positive integer/i)
  })
})
