import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CodexCliWorkflowPlanner } from './planner-provider.js'
import type { WorkflowPlanExplorationReport } from './plan-exploration.js'
import type { WorkflowPlanDraft, WorkflowPlannerRequest } from './planner-types.js'
import { draftBodyFromUnknown, validateWorkflowPlanDraft } from './planner-validation.js'

export function mergeRefinedDraft(before: WorkflowPlanDraft, candidate: WorkflowPlanDraft): WorkflowPlanDraft {
  const merged = structuredClone(before)
  const candidateGroups = new Map(candidate.groups.map((group) => [group.id, group]))
  for (const group of merged.groups) {
    const candidateGroup = candidateGroups.get(group.id)
    if (!candidateGroup) continue
    const candidatePhases = new Map(candidateGroup.phases.map((phase) => [phase.id, phase]))
    for (const phase of group.phases) {
      const candidatePhase = candidatePhases.get(phase.id)
      if (!candidatePhase) continue

      const candidateAssertions = new Map(candidatePhase.assertions.map((assertion) => [assertion.id, assertion]))
      phase.assertions = phase.assertions.map((assertion) => {
        const replacement = candidateAssertions.get(assertion.id)
        if (!replacement || replacement.kind !== assertion.kind) return assertion
        const next = structuredClone(assertion) as Record<string, unknown>
        if ('target' in replacement && 'target' in assertion) next.target = replacement.target
        if ('table' in replacement && 'table' in assertion) next.table = replacement.table
        return next as typeof assertion
      })

      const beforeEntitySteps = new Map(phase.steps
        .filter((step) => step.kind === 'captureTableRow' || step.kind === 'clickAlignedTableAction')
        .map((step) => [step.id, step]))
      const candidateStepIds = new Set(candidatePhase.steps.map((step) => step.id))
      phase.steps = candidatePhase.steps.map((step) => beforeEntitySteps.get(step.id) ?? step)
      for (const step of beforeEntitySteps.values()) {
        if (!candidateStepIds.has(step.id)) phase.steps.push(step)
      }
    }
  }
  return {
    ...merged,
    review: candidate.review,
    planner: {
      ...before.planner,
      generatedAt: new Date().toISOString(),
      summary: [...before.planner.summary, ...candidate.planner.summary],
    },
  }
}

export function validateLiveLocatorTextOracleChanges(
  before: WorkflowPlanDraft,
  refined: WorkflowPlanDraft,
  pageEvidence: string,
): void {
  const previous = new Map(before.groups.flatMap((group) => group.phases.flatMap((phase) =>
    phase.assertions.filter((assertion) => assertion.kind === 'locatorText').map((assertion) => [`${group.id}:${phase.id}:${assertion.id}`, assertion]),
  )))
  for (const group of refined.groups) {
    for (const phase of group.phases) {
      for (const assertion of phase.assertions) {
        if (assertion.kind !== 'locatorText') continue
        const prior = previous.get(`${group.id}:${phase.id}:${assertion.id}`)
        if (!prior || JSON.stringify(prior.expected) === JSON.stringify(assertion.expected)) continue
        const priorLiteral = prior.expected.literal
        const refinedLiteral = assertion.expected.literal
        if (!priorLiteral || !refinedLiteral || prior.expected.valueRef || assertion.expected.valueRef) {
          throw new Error(`Exploration refinement changed non-literal locatorText oracle ${assertion.id}`)
        }
        if (!pageEvidence.includes(refinedLiteral)) {
          throw new Error(`Exploration refinement changed locatorText oracle ${assertion.id} without exact live-page evidence`)
        }
      }
    }
  }
}

export async function refineWorkflowDraftFromExploration(options: {
  draft: WorkflowPlanDraft
  exploration: WorkflowPlanExplorationReport
  pageEvidence: string
  provider: CodexCliWorkflowPlanner
  workspaceDirectory: string
}): Promise<WorkflowPlanDraft> {
  const before = validateWorkflowPlanDraft(structuredClone(options.draft))
  const request: WorkflowPlannerRequest = {
    manifest: { workflowId: before.workflowId, sourceSha256: before.sourceSha256 },
    brief: '',
    imagePaths: [],
    imageSha256s: before.planner.imageSha256s,
    inputSha256: before.planner.inputSha256,
    workspaceDirectory: options.workspaceDirectory,
  }
  const response = await options.provider.refineFromExploration(
    request,
    JSON.stringify(before),
    JSON.stringify({
      status: options.exploration.status,
      runtimeStatus: options.exploration.runtimeResult.status,
      error: options.exploration.runtimeResult.error ?? null,
      phases: options.exploration.runtimeResult.phases,
      steps: options.exploration.runtimeResult.steps,
      assertions: options.exploration.runtimeResult.assertions,
    }),
    options.pageEvidence,
  )
  await writeFile(resolve(options.workspaceDirectory, 'exploration-refinement-response.json'), `${JSON.stringify(response, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  const body = draftBodyFromUnknown(JSON.parse(response.planJson) as unknown)
  const candidate = {
    ...body,
    review: { ...body.review, status: 'draft' },
    planner: {
      ...before.planner,
      generatedAt: new Date().toISOString(),
      summary: [...before.planner.summary, ...response.summary],
    },
  } as WorkflowPlanDraft
  const merged = validateWorkflowPlanDraft(mergeRefinedDraft(before, candidate))
  validateLiveLocatorTextOracleChanges(before, merged, options.pageEvidence)
  return merged
}

export async function readSanitizedPageEvidence(paths: string[]): Promise<string> {
  const values = await Promise.all(paths.map(async (path) => ({ path, content: await readFile(path, 'utf8') })))
  const hashes = new Set<string>()
  return values.flatMap((value) => {
    const hash = createHash('sha256').update(value.content).digest('hex')
    if (hashes.has(hash)) return []
    hashes.add(hash)
    return [`FILE ${value.path}\n${value.content}`]
  }).join('\n\n').slice(0, 120_000)
}
