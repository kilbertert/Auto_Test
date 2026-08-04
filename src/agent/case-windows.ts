import type { WorkflowIntakeManifest } from '../workflow/types.js'

// Keep the default context bounded for complex cases; callers can opt into a
// larger window explicitly, and resume always preserves the original value.
export const DEFAULT_CODEX_CASE_BATCH_SIZE = 8

export interface CodexCaseWindow {
  id: string
  index: number
  total: number
  caseIds: string[]
}

export function buildCodexCaseWindows(
  manifest: WorkflowIntakeManifest,
  batchSize = DEFAULT_CODEX_CASE_BATCH_SIZE,
): CodexCaseWindow[] {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('Codex case batch size must be a positive integer')
  const groups: string[][] = []
  for (let index = 0; index < manifest.phases.length; index += batchSize) {
    groups.push(manifest.phases.slice(index, index + batchSize).map((phase) => phase.id))
  }
  return groups.map((caseIds, index) => ({
    id: `batch-${String(index + 1).padStart(4, '0')}`,
    index,
    total: groups.length,
    caseIds,
  }))
}

export function manifestForCaseWindow(
  manifest: WorkflowIntakeManifest,
  window: CodexCaseWindow,
): WorkflowIntakeManifest {
  const required = new Set(window.caseIds)
  const phases = manifest.phases.filter((phase) => required.has(phase.id))
  if (phases.length !== required.size) throw new Error(`Case window ${window.id} contains case IDs outside the immutable manifest`)
  const imageIds = new Set(phases.flatMap((phase) => phase.imageIds))
  return {
    ...manifest,
    phases,
    embeddedImages: manifest.embeddedImages.filter((image) => imageIds.has(image.id)),
  }
}
