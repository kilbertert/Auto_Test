import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { redactSensitiveContent } from '../input/text.js'
import {
  diagnosticErrorDetails,
  elapsedSeconds,
  runWithWorkflowProgress,
  type WorkflowProgressSink,
} from './diagnostics.js'
import type { WorkflowIntakeManifest } from './types.js'
import type {
  WorkflowPlanDraft,
  WorkflowPlannerModelResponse,
  WorkflowPlannerProvider,
} from './planner-types.js'
import {
  draftBodyFromUnknown,
  validateWorkflowPlanDraft,
  type WorkflowDraftNormalization,
} from './planner-validation.js'

export interface PlanWorkflowOptions {
  manifest: WorkflowIntakeManifest
  mediaDirectory: string
  brief?: string
  provider: WorkflowPlannerProvider
  workspaceDirectory: string
  initialResponse?: WorkflowPlannerModelResponse
  progress?: WorkflowProgressSink
  heartbeatIntervalMs?: number
}

export function parseWorkflowPlanJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    const lastObjectEnd = value.lastIndexOf('}')
    if (lastObjectEnd < 0) throw error
    const candidate = value.slice(0, lastObjectEnd + 1)
    const trailing = value.slice(lastObjectEnd + 1).trim()
    if (!/^\]+$/.test(trailing)) throw error
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      throw error
    }
  }
}

function requireManifestPhaseCoverage(draft: WorkflowPlanDraft, manifest: WorkflowIntakeManifest): void {
  const sourceRefs = new Set(draft.groups.flatMap((group) => group.phases.flatMap((phase) => phase.sourceRefs)))
  const missing = manifest.phases.filter((phase) => !sourceRefs.has(`phase:${phase.id}`)).map((phase) => phase.id)
  if (missing.length > 0) throw new Error(`Planner omitted Intake phases: ${missing.join(', ')}`)
}

async function verifiedImagePaths(manifest: WorkflowIntakeManifest, mediaDirectory: string): Promise<{ paths: string[]; hashes: string[] }> {
  const images = [...manifest.embeddedImages, ...manifest.supplementalImages]
  const paths: string[] = []
  const hashes: string[] = []
  for (const image of images) {
    const path = resolve(mediaDirectory, basename(image.fileName))
    const content = await readFile(path)
    const actual = createHash('sha256').update(content).digest('hex')
    if (actual !== image.sha256) throw new Error(`Image hash mismatch: ${image.id}`)
    paths.push(path)
    hashes.push(actual)
  }
  return { paths, hashes }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(path, 0o600)
}

async function plannerCall(
  options: PlanWorkflowOptions,
  attempt: number,
  operation: () => Promise<WorkflowPlannerModelResponse>,
): Promise<WorkflowPlannerModelResponse> {
  return runWithWorkflowProgress(options.progress, {
    stage: 'planning',
    operation: attempt === 1 ? 'planner.generate' : 'planner.repair',
    attempt,
    maxAttempts: 3,
    startMessage: `[Planner] 正在${attempt === 1 ? '生成' : '修复'} Execution Plan，第 ${attempt}/3 轮`,
    heartbeatMessage: (elapsedMs) => `[Planner] 第 ${attempt}/3 轮仍在运行，已等待 ${elapsedSeconds(elapsedMs)}`,
    successMessage: (elapsedMs) => `[Planner] 第 ${attempt}/3 轮模型响应已返回，耗时 ${elapsedSeconds(elapsedMs)}`,
    failureMessage: (elapsedMs, error) => `[Planner] 第 ${attempt}/3 轮模型调用失败（${elapsedSeconds(elapsedMs)}）：${diagnosticErrorDetails(error).message}`,
    ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
  }, operation)
}

export async function planWorkflow(options: PlanWorkflowOptions): Promise<WorkflowPlanDraft> {
  const sanitizedBrief = redactSensitiveContent(options.brief ?? '')
  const images = await verifiedImagePaths(options.manifest, options.mediaDirectory)
  const inputSha256 = createHash('sha256').update(JSON.stringify({
    manifest: options.manifest,
    brief: sanitizedBrief,
    imageSha256s: images.hashes,
  })).digest('hex')
  await mkdir(options.workspaceDirectory, { recursive: true, mode: 0o750 })
  const request = {
    manifest: options.manifest,
    brief: sanitizedBrief,
    imagePaths: images.paths,
    imageSha256s: images.hashes,
    inputSha256,
    workspaceDirectory: options.workspaceDirectory,
  }
  let response = options.initialResponse ?? await plannerCall(options, 1, () => options.provider.generate(request))
  let validated: WorkflowPlanDraft | undefined
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    const attemptNumber = attempt + 1
    const responsePath = resolve(options.workspaceDirectory, `planner-response-${attemptNumber}.json`)
    await writePrivateJson(responsePath, response)
    try {
      const bodyInput = parseWorkflowPlanJson(response.planJson)
      const normalizations: WorkflowDraftNormalization[] = []
      const body = draftBodyFromUnknown(bodyInput, normalizations)
      if (normalizations.length > 0) {
        const normalizationPath = resolve(options.workspaceDirectory, `planner-normalization-${attemptNumber}.json`)
        await writePrivateJson(normalizationPath, { version: '1.0', attempt: attemptNumber, normalizations })
        await options.progress?.emit({
          kind: 'normalization_applied',
          stage: 'planning',
          operation: 'planner.validate',
          attempt: attemptNumber,
          maxAttempts: 3,
          message: `[Planner] 第 ${attemptNumber}/3 轮已确定性修复 ${normalizations.length} 个结构问题`,
          artifactPath: normalizationPath,
          details: { count: normalizations.length, kinds: [...new Set(normalizations.map((item) => item.kind))] },
        })
      }
      if (body.workflowId !== options.manifest.workflowId) throw new Error('Planner changed workflowId')
      if (body.sourceSha256 !== options.manifest.source.sha256) throw new Error('Planner changed sourceSha256')
      const candidate = validateWorkflowPlanDraft({
        ...body,
        review: { ...body.review, status: 'draft' },
        planner: {
          provider: options.provider.name,
          model: options.provider.model,
          generatedAt: new Date().toISOString(),
          inputSha256,
          imageSha256s: images.hashes,
          summary: response.summary,
        },
      })
      requireManifestPhaseCoverage(candidate, options.manifest)
      validated = candidate
      await options.progress?.emit({
        kind: 'information',
        stage: 'planning',
        operation: 'planner.validate',
        attempt: attemptNumber,
        maxAttempts: 3,
        message: `[Planner] 第 ${attemptNumber}/3 轮 Draft 校验通过，共 ${candidate.groups.length} 个 Group、${candidate.groups.flatMap((group) => group.phases).length} 个 Phase`,
        artifactPath: responsePath,
      })
      break
    } catch (error) {
      lastError = error
      const details = diagnosticErrorDetails(error)
      const validationPath = resolve(options.workspaceDirectory, `planner-validation-${attemptNumber}.json`)
      await writePrivateJson(validationPath, {
        version: '1.0',
        attempt: attemptNumber,
        status: 'failed',
        code: details.code,
        ...(details.location ? { location: details.location } : {}),
        message: details.message,
      })
      await options.progress?.emit({
        kind: 'validation_failed',
        stage: 'planning',
        operation: 'planner.validate',
        attempt: attemptNumber,
        maxAttempts: 3,
        message: `[Planner] 第 ${attemptNumber}/3 轮结构校验未通过：${details.message}`,
        code: details.code,
        ...(details.location ? { location: details.location } : {}),
        artifactPath: validationPath,
      })
      if (!options.provider.repair || attempt === 2) break
      response = await plannerCall(options, attemptNumber + 1, () => options.provider.repair!(request, response, details.message))
    }
  }
  if (!validated) throw lastError instanceof Error ? lastError : new Error('Planner could not produce a valid draft')
  await writeFile(resolve(options.workspaceDirectory, 'planner-input.sha256'), `${inputSha256}\n`, { encoding: 'utf8', mode: 0o640 })
  return validated
}
