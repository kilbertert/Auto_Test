import type { ModelProfile } from '../workflow/model-profile.js'
import type { WorkflowIntakeManifest, WorkflowPhaseDraft } from '../workflow/types.js'

export interface CodexExecutionCapacity {
  contextWindowTokens: number
  maxOutputTokens: number
  caseOutputTokens: number
  targetContextRatio: number
  targetOutputRatio: number
}

export interface CodexExecutionEpoch {
  id: string
  index: number
  total: number
  caseIds: string[]
  estimatedInputTokens: number
  estimatedOutputTokens: number
}

export const DEFAULT_CODEX_EXECUTION_CAPACITY: CodexExecutionCapacity = {
  contextWindowTokens: 128_000,
  maxOutputTokens: 16_000,
  caseOutputTokens: 900,
  targetContextRatio: 0.55,
  targetOutputRatio: 0.55,
}

export function capacityForModelProfile(profile?: ModelProfile): CodexExecutionCapacity {
  return {
    contextWindowTokens: profile?.contextWindowTokens ?? DEFAULT_CODEX_EXECUTION_CAPACITY.contextWindowTokens,
    maxOutputTokens: profile?.maxOutputTokens ?? DEFAULT_CODEX_EXECUTION_CAPACITY.maxOutputTokens,
    caseOutputTokens: profile?.caseOutputTokens ?? DEFAULT_CODEX_EXECUTION_CAPACITY.caseOutputTokens,
    targetContextRatio: profile?.targetContextRatio ?? DEFAULT_CODEX_EXECUTION_CAPACITY.targetContextRatio,
    targetOutputRatio: profile?.targetOutputRatio ?? DEFAULT_CODEX_EXECUTION_CAPACITY.targetOutputRatio,
  }
}

export function buildCodexExecutionEpochs(
  manifest: WorkflowIntakeManifest,
  capacity: CodexExecutionCapacity,
  completedCaseIds: Iterable<string> = [],
): CodexExecutionEpoch[] {
  const completed = new Set(completedCaseIds)
  const inputBudget = Math.max(1, Math.floor(capacity.contextWindowTokens * capacity.targetContextRatio))
  const outputBudget = Math.max(1, Math.floor(capacity.maxOutputTokens * capacity.targetOutputRatio))
  const epochs: Array<Omit<CodexExecutionEpoch, 'total'>> = []
  let current: Omit<CodexExecutionEpoch, 'total'> | undefined

  for (const phase of manifest.phases) {
    const estimatedInputTokens = estimatePhaseInputTokens(phase)
    const estimatedOutputTokens = capacity.caseOutputTokens
    const exceedsBudget = current && (
      current.estimatedInputTokens + estimatedInputTokens > inputBudget ||
      current.estimatedOutputTokens + estimatedOutputTokens > outputBudget
    )
    if (exceedsBudget && current) {
      epochs.push(current)
      current = undefined
    }
    current ??= {
      id: `epoch-${String(epochs.length + 1).padStart(4, '0')}`,
      index: epochs.length,
      caseIds: [],
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
    }
    current.caseIds.push(phase.id)
    current.estimatedInputTokens += estimatedInputTokens
    current.estimatedOutputTokens += estimatedOutputTokens
  }
  if (current) epochs.push(current)
  const pending = epochs
    .map((epoch) => ({ ...epoch, caseIds: epoch.caseIds.filter((caseId) => !completed.has(caseId)) }))
    .filter((epoch) => epoch.caseIds.length > 0)
  return pending.map((epoch, index) => ({ ...epoch, index, total: pending.length }))
}

export function manifestForExecutionEpoch(
  manifest: WorkflowIntakeManifest,
  epoch: CodexExecutionEpoch,
): WorkflowIntakeManifest {
  const required = new Set(epoch.caseIds)
  const phases = manifest.phases.filter((phase) => required.has(phase.id))
  if (phases.length !== required.size) throw new Error(`Execution epoch ${epoch.id} contains case IDs outside the immutable manifest`)
  const imageIds = new Set(phases.flatMap((phase) => phase.imageIds))
  return {
    ...manifest,
    phases,
    embeddedImages: manifest.embeddedImages.filter((image) => imageIds.has(image.id)),
    supplementalImages: manifest.supplementalImages.filter((image) => imageIds.has(image.id)),
  }
}

export function limitManifestToCases(manifest: WorkflowIntakeManifest, limit: number): WorkflowIntakeManifest {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('case limit must be a positive integer')
  const phases = manifest.phases.slice(0, limit)
  const imageIds = new Set(phases.flatMap((phase) => phase.imageIds))
  return {
    ...manifest,
    phases,
    embeddedImages: manifest.embeddedImages.filter((image) => imageIds.has(image.id)),
    supplementalImages: manifest.supplementalImages.filter((image) => imageIds.has(image.id)),
  }
}

function estimatePhaseInputTokens(phase: WorkflowPhaseDraft): number {
  const bytes = Buffer.byteLength(JSON.stringify(phase), 'utf8')
  return Math.max(256, Math.ceil(bytes / 4) + 256)
}
