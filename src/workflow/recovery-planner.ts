import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { WorkflowPlanDraft, WorkflowPlannerProvider, WorkflowPlannerRequest } from './planner-types.js'
import { draftBodyFromUnknown, validateWorkflowPlanDraft } from './planner-validation.js'

function mergeRecoveryContracts(before: WorkflowPlanDraft, candidate: WorkflowPlanDraft): WorkflowPlanDraft {
  const merged = structuredClone(before)
  const candidatePhases = new Map(candidate.groups.flatMap((group) => group.phases.map((phase) => [phase.id, phase] as const)))
  for (const group of merged.groups) {
    for (const phase of group.phases) {
      const recovery = candidatePhases.get(phase.id)?.recovery
      if (recovery) phase.recovery = structuredClone(recovery)
    }
  }
  return merged
}

export function missingRecoveryPhaseIds(draft: WorkflowPlanDraft): string[] {
  return draft.groups.flatMap((group) => group.phases)
    .filter((phase) => phase.risk !== 'read' && !phase.recovery)
    .map((phase) => phase.id)
}

export async function planWorkflowRecoveryContracts(options: {
  draft: WorkflowPlanDraft
  provider: WorkflowPlannerProvider
  workspaceDirectory: string
}): Promise<WorkflowPlanDraft> {
  const before = validateWorkflowPlanDraft(structuredClone(options.draft))
  if (missingRecoveryPhaseIds(before).length === 0) return before
  if (!options.provider.planRecovery) throw new Error(`Planner provider ${options.provider.name} does not support recovery planning`)
  const request: WorkflowPlannerRequest = {
    manifest: { workflowId: before.workflowId, sourceSha256: before.sourceSha256 },
    brief: '',
    imagePaths: [],
    imageSha256s: before.planner.imageSha256s,
    inputSha256: before.planner.inputSha256,
    workspaceDirectory: options.workspaceDirectory,
  }
  await mkdir(options.workspaceDirectory, { recursive: true, mode: 0o750 })
  let response = await options.provider.planRecovery(request, JSON.stringify(before))
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    await writeFile(
      resolve(options.workspaceDirectory, `recovery-planner-response-${attempt + 1}.json`),
      `${JSON.stringify(response, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o640 },
    )
    try {
      const body = draftBodyFromUnknown(JSON.parse(response.planJson) as unknown)
      const candidate = validateWorkflowPlanDraft({
        ...body,
        review: { ...body.review, status: 'draft' },
        planner: {
          ...before.planner,
          generatedAt: new Date().toISOString(),
          summary: [...before.planner.summary, ...response.summary],
        },
      })
      const merged = mergeRecoveryContracts(before, candidate)
      const result = validateWorkflowPlanDraft({
        ...merged,
        planner: {
          ...before.planner,
          generatedAt: new Date().toISOString(),
          summary: [...before.planner.summary, ...response.summary],
        },
      })
      await writeFile(
        resolve(options.workspaceDirectory, 'recovery-planner-response.json'),
        `${JSON.stringify(response, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o640 },
      )
      return result
    } catch (error) {
      lastError = error
      if (!options.provider.repair || attempt === 2) break
      response = await options.provider.repair(
        request,
        response,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Recovery Planner could not produce valid recovery contracts')
}
