import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  diagnosticErrorDetails,
  elapsedSeconds,
  runWithWorkflowProgress,
  type WorkflowProgressSink,
} from './diagnostics.js'
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
  progress?: WorkflowProgressSink
  heartbeatIntervalMs?: number
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
  const callPlanner = (attempt: number, operation: () => Promise<import('./planner-types.js').WorkflowPlannerModelResponse>) => (
    runWithWorkflowProgress(options.progress, {
      stage: 'recovery_planning',
      operation: attempt === 1 ? 'recovery-planner.generate' : 'recovery-planner.repair',
      attempt,
      maxAttempts: 3,
      startMessage: `[Recovery Planner] 正在${attempt === 1 ? '生成' : '修复'}恢复契约，第 ${attempt}/3 轮`,
      heartbeatMessage: (elapsedMs) => `[Recovery Planner] 第 ${attempt}/3 轮仍在运行，已等待 ${elapsedSeconds(elapsedMs)}`,
      successMessage: (elapsedMs) => `[Recovery Planner] 第 ${attempt}/3 轮模型响应已返回，耗时 ${elapsedSeconds(elapsedMs)}`,
      failureMessage: (elapsedMs, error) => `[Recovery Planner] 第 ${attempt}/3 轮模型调用失败（${elapsedSeconds(elapsedMs)}）：${diagnosticErrorDetails(error).message}`,
      ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
    }, operation)
  )
  let response = await callPlanner(1, () => options.provider.planRecovery!(request, JSON.stringify(before)))
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    const attemptNumber = attempt + 1
    const responsePath = resolve(options.workspaceDirectory, `recovery-planner-response-${attemptNumber}.json`)
    await writeFile(
      responsePath,
      `${JSON.stringify(response, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    await chmod(responsePath, 0o600)
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
        { encoding: 'utf8', mode: 0o600 },
      )
      await chmod(resolve(options.workspaceDirectory, 'recovery-planner-response.json'), 0o600)
      await options.progress?.emit({
        kind: 'information',
        stage: 'recovery_planning',
        operation: 'recovery-planner.validate',
        attempt: attemptNumber,
        maxAttempts: 3,
        message: `[Recovery Planner] 第 ${attemptNumber}/3 轮恢复契约校验通过`,
        artifactPath: responsePath,
      })
      return result
    } catch (error) {
      lastError = error
      const details = diagnosticErrorDetails(error)
      await options.progress?.emit({
        kind: 'validation_failed',
        stage: 'recovery_planning',
        operation: 'recovery-planner.validate',
        attempt: attemptNumber,
        maxAttempts: 3,
        message: `[Recovery Planner] 第 ${attemptNumber}/3 轮结构校验未通过：${details.message}`,
        code: details.code,
        ...(details.location ? { location: details.location } : {}),
        artifactPath: responsePath,
      })
      if (!options.provider.repair || attempt === 2) break
      response = await callPlanner(attemptNumber + 1, () => options.provider.repair!(request, response, details.message))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Recovery Planner could not produce valid recovery contracts')
}
