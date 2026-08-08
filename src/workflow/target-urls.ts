import type { WorkflowIntakeManifest, WorkflowPhaseDraft } from './types.js'

const urlPattern = /https?:\/\/[^\s,，;；]+/gi

export function normalizeWorkflowUrl(value: string): string | undefined {
  try {
    const url = new URL(value.replace(/[)）\]】。]+$/g, ''))
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : undefined
  } catch {
    return undefined
  }
}

export function extractWorkflowUrls(value: string): string[] {
  return [...new Set((value.match(urlPattern) ?? [])
    .map(normalizeWorkflowUrl)
    .filter((url): url is string => Boolean(url)))]
}

export function urlsReferencedByPhases(phases: WorkflowPhaseDraft[]): string[] {
  return [...new Set(phases.flatMap((phase) => [
    ...(phase.summary ? extractWorkflowUrls(phase.summary) : []),
    ...extractWorkflowUrls(phase.title),
    ...phase.steps.flatMap((step) => extractWorkflowUrls(step.sourceText)),
    ...phase.resources.flatMap((resource) => resource.urls.length > 0 ? resource.urls : extractWorkflowUrls(resource.text)),
  ]).map(normalizeWorkflowUrl).filter((url): url is string => Boolean(url)))]
}

/**
 * URLs explicitly supplied for this run are the environment-selection input.
 * Material references remain in `targetUrls` for Agent understanding, but do
 * not become a pre-execution registration requirement by implication.
 */
export function environmentTargetUrls(manifest: WorkflowIntakeManifest): string[] {
  return manifest.declaredTargetUrls ?? []
}

/** Keep a canary/epoch's material links scoped to the cases it actually runs. */
export function targetUrlsForManifestCases(
  manifest: WorkflowIntakeManifest,
  phases: WorkflowPhaseDraft[],
): string[] {
  const declared = manifest.declaredTargetUrls ?? []
  const referenced = urlsReferencedByPhases(phases)
  const scoped = [...new Set([...declared, ...referenced])]
  if (scoped.length > 0) return scoped
  // A pre-contract manifest has no provenance field. Preserve its historical
  // material set only for frozen artifact inspection; new manifests stay empty.
  return manifest.declaredTargetUrls === undefined ? manifest.targetUrls : []
}
