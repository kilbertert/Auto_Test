import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { redactSensitiveContent } from '../input/text.js'
import type { WorkflowIntakeManifest } from './types.js'
import type {
  WorkflowPlanDraft,
  WorkflowPlannerModelResponse,
  WorkflowPlannerProvider,
} from './planner-types.js'
import { draftBodyFromUnknown, validateWorkflowPlanDraft } from './planner-validation.js'

export interface PlanWorkflowOptions {
  manifest: WorkflowIntakeManifest
  mediaDirectory: string
  brief?: string
  provider: WorkflowPlannerProvider
  workspaceDirectory: string
  initialResponse?: WorkflowPlannerModelResponse
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
  let response = options.initialResponse ?? await options.provider.generate(request)
  let validated: WorkflowPlanDraft | undefined
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    await writeFile(resolve(options.workspaceDirectory, `planner-response-${attempt + 1}.json`), `${JSON.stringify(response, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o640,
    })
    try {
      const bodyInput = parseWorkflowPlanJson(response.planJson)
      const body = draftBodyFromUnknown(bodyInput)
      if (body.workflowId !== options.manifest.workflowId) throw new Error('Planner changed workflowId')
      if (body.sourceSha256 !== options.manifest.source.sha256) throw new Error('Planner changed sourceSha256')
      validated = validateWorkflowPlanDraft({
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
      requireManifestPhaseCoverage(validated, options.manifest)
      break
    } catch (error) {
      lastError = error
      if (!options.provider.repair || attempt === 2) break
      response = await options.provider.repair(request, response, error instanceof Error ? error.message : String(error))
    }
  }
  if (!validated) throw lastError instanceof Error ? lastError : new Error('Planner could not produce a valid draft')
  await writeFile(resolve(options.workspaceDirectory, 'planner-input.sha256'), `${inputSha256}\n`, { encoding: 'utf8', mode: 0o640 })
  return validated
}
