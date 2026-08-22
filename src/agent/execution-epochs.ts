import type { ModelProfile } from '../workflow/model-profile.js'
import type { WorkflowIntakeManifest, WorkflowPhaseDraft } from '../workflow/types.js'
import { targetUrlsForManifestCases } from '../workflow/target-urls.js'

export interface AgentExecutionCapacity {
  contextWindowTokens: number
  maxOutputTokens: number
  caseOutputTokens: number
  targetContextRatio: number
  targetOutputRatio: number
}

export interface AgentExecutionEpoch {
  id: string
  index: number
  total: number
  caseIds: string[]
  estimatedInputTokens: number
  estimatedOutputTokens: number
}

export const DEFAULT_AGENT_EXECUTION_CAPACITY: AgentExecutionCapacity = {
  contextWindowTokens: 128_000,
  maxOutputTokens: 16_000,
  caseOutputTokens: 900,
  targetContextRatio: 0.55,
  targetOutputRatio: 0.55,
}

export function capacityForAgentProfile(profile?: ModelProfile): AgentExecutionCapacity {
  return {
    contextWindowTokens: profile?.contextWindowTokens ?? DEFAULT_AGENT_EXECUTION_CAPACITY.contextWindowTokens,
    maxOutputTokens: profile?.maxOutputTokens ?? DEFAULT_AGENT_EXECUTION_CAPACITY.maxOutputTokens,
    caseOutputTokens: profile?.caseOutputTokens ?? DEFAULT_AGENT_EXECUTION_CAPACITY.caseOutputTokens,
    targetContextRatio: profile?.targetContextRatio ?? DEFAULT_AGENT_EXECUTION_CAPACITY.targetContextRatio,
    targetOutputRatio: profile?.targetOutputRatio ?? DEFAULT_AGENT_EXECUTION_CAPACITY.targetOutputRatio,
  }
}

export function buildAgentExecutionEpochs(
  manifest: WorkflowIntakeManifest,
  capacity: AgentExecutionCapacity,
  completedCaseIds: Iterable<string> = [],
): AgentExecutionEpoch[] {
  const completed = new Set(completedCaseIds)
  const inputBudget = Math.max(1, Math.floor(capacity.contextWindowTokens * capacity.targetContextRatio))
  const outputBudget = Math.max(1, Math.floor(capacity.maxOutputTokens * capacity.targetOutputRatio))
  const epochs: Array<Omit<AgentExecutionEpoch, 'total'>> = []
  let current: Omit<AgentExecutionEpoch, 'total'> | undefined

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

export function splitAgentExecutionEpoch(
  manifest: WorkflowIntakeManifest,
  epoch: AgentExecutionEpoch,
): AgentExecutionEpoch[] {
  if (epoch.caseIds.length < 2) return [epoch]
  const midpoint = Math.floor(epoch.caseIds.length / 2)
  const outputPerCase = Math.max(1, Math.ceil(epoch.estimatedOutputTokens / epoch.caseIds.length))
  return [epoch.caseIds.slice(0, midpoint), epoch.caseIds.slice(midpoint)].map((caseIds, index) => {
    const required = new Set(caseIds)
    const phases = manifest.phases.filter((phase) => required.has(phase.id))
    if (phases.length !== required.size) throw new Error(`Execution epoch ${epoch.id} contains case IDs outside the immutable manifest`)
    return {
      id: `${epoch.id}-${index === 0 ? 'a' : 'b'}`,
      index: epoch.index + index,
      total: epoch.total + 1,
      caseIds,
      estimatedInputTokens: phases.reduce((total, phase) => total + estimatePhaseInputTokens(phase), 0),
      estimatedOutputTokens: caseIds.length * outputPerCase,
    }
  })
}

export function manifestForAgentExecutionEpoch(
  manifest: WorkflowIntakeManifest,
  epoch: AgentExecutionEpoch,
): WorkflowIntakeManifest {
  const required = new Set(epoch.caseIds)
  const phases = manifest.phases.filter((phase) => required.has(phase.id))
  if (phases.length !== required.size) throw new Error(`Execution epoch ${epoch.id} contains case IDs outside the immutable manifest`)
  const imageIds = new Set(phases.flatMap((phase) => phase.imageIds))
  return {
    ...manifest,
    phases,
    materialIndex: manifest.materialIndex ?? manifest.phases.map((phase) => ({
      caseId: phase.id,
      title: phase.title,
      sourceRow: phase.sourceRow,
      risk: phase.risk,
      imageCount: phase.imageIds.length,
    })),
    targetUrls: targetUrlsForManifestCases(manifest, phases),
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
    materialIndex: manifest.materialIndex ?? manifest.phases.map((phase) => ({
      caseId: phase.id,
      title: phase.title,
      sourceRow: phase.sourceRow,
      risk: phase.risk,
      imageCount: phase.imageIds.length,
    })),
    targetUrls: targetUrlsForManifestCases(manifest, phases),
    embeddedImages: manifest.embeddedImages.filter((image) => imageIds.has(image.id)),
    supplementalImages: manifest.supplementalImages.filter((image) => imageIds.has(image.id)),
  }
}

/** Historical Codex-prefixed exports remain source-compatible aliases. */
export type CodexExecutionCapacity = AgentExecutionCapacity
export type CodexExecutionEpoch = AgentExecutionEpoch
export const DEFAULT_CODEX_EXECUTION_CAPACITY = DEFAULT_AGENT_EXECUTION_CAPACITY
export const capacityForModelProfile = capacityForAgentProfile
export const buildCodexExecutionEpochs = buildAgentExecutionEpochs
export const splitCodexExecutionEpoch = splitAgentExecutionEpoch
export const manifestForExecutionEpoch = manifestForAgentExecutionEpoch

function estimatePhaseInputTokens(phase: WorkflowPhaseDraft): number {
  const bytes = Buffer.byteLength(JSON.stringify(phase), 'utf8')
  return Math.max(256, Math.ceil(bytes / 4) + 256)
}
