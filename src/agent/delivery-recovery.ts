import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { WorkflowIntakeManifest } from '../workflow/types.js'
import type { CodexTestAgentResult, CodexTestCaseResult, CodexTestFailureKind, CodexTestFailureSource } from './types.js'

interface AgentCaseArtifact {
  caseId: string
  title?: string
  outcome: 'passed' | 'product_failed' | 'blocked'
  summary: string
  evidencePaths?: string[]
  blockers?: string[]
  productDefects?: string[]
  failureSource?: CodexTestFailureSource
  failureKind?: CodexTestFailureKind
  environmentRequirementIds?: string[]
  executionReceiptIds?: string[]
}

interface AgentDeliveryArtifact {
  version: '1.0'
  kind: 'case-results'
  workflowId: string
  sourceSha256: string
  generatedAt: string
  cases: AgentCaseArtifact[]
  mutationLedger: { state: 'terminal'; pendingCount: number; entries: unknown[] }
}

const failureSources = new Set<CodexTestFailureSource>(['product', 'agent_execution', 'environment', 'input', 'infrastructure'])
const failureKinds = new Set<CodexTestFailureKind>(['assertion', 'validation', 'authentication', 'environment', 'data', 'execution'])

function outcomeForCases(cases: CodexTestCaseResult[]): CodexTestAgentResult['outcome'] {
  if (cases.some((item) => item.outcome === 'blocked')) return 'blocked'
  if (cases.some((item) => item.outcome === 'product_failed')) return 'product_failed'
  return 'passed'
}

function validateArtifact(
  artifact: AgentDeliveryArtifact,
  manifest: WorkflowIntakeManifest,
): string[] {
  const problems: string[] = []
  if (artifact.version !== '1.0') problems.push('Agent delivery artifact version is unsupported')
  if (artifact.kind !== 'case-results') problems.push('Agent delivery artifact kind is unsupported')
  if (artifact.workflowId !== manifest.workflowId) problems.push('Agent delivery artifact workflowId does not match the immutable contract')
  if (artifact.sourceSha256 !== manifest.source.sha256) problems.push('Agent delivery artifact sourceSha256 does not match the immutable contract')
  if (!artifact.generatedAt?.trim()) problems.push('Agent delivery artifact has no generatedAt timestamp')
  if (!Array.isArray(artifact.cases)) problems.push('Agent delivery artifact cases must be an array')
  const rawCases = Array.isArray(artifact.cases) ? artifact.cases : []
  const cases = rawCases.filter((item): item is AgentCaseArtifact => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
  if (cases.length !== rawCases.length) problems.push('Agent delivery artifact cases must contain objects')
  const required = new Set(manifest.phases.map((phase) => phase.id))
  const returned = cases.map((item) => item.caseId)
  if (new Set(returned).size !== returned.length) problems.push('Agent delivery artifact contains duplicate case IDs')
  for (const id of required) if (!returned.includes(id)) problems.push(`Agent delivery artifact is missing case ${id}`)
  for (const id of returned) if (!required.has(id)) problems.push(`Agent delivery artifact contains unexpected case ${id}`)
  for (const item of cases) {
    if (!item.summary?.trim()) problems.push(`Agent delivery artifact case ${item.caseId} has no summary`)
    if (!['passed', 'product_failed', 'blocked'].includes(item.outcome)) problems.push(`Agent delivery artifact case ${item.caseId} has an invalid outcome`)
    if (item.failureSource && !failureSources.has(item.failureSource)) problems.push(`Agent delivery artifact case ${item.caseId} has an invalid failureSource`)
    if (item.failureKind && !failureKinds.has(item.failureKind)) problems.push(`Agent delivery artifact case ${item.caseId} has an invalid failureKind`)
    if (item.environmentRequirementIds && (!Array.isArray(item.environmentRequirementIds) || item.environmentRequirementIds.some((id) => !id.trim()))) {
      problems.push(`Agent delivery artifact case ${item.caseId} has invalid environment requirement references`)
    }
    if (item.executionReceiptIds && (!Array.isArray(item.executionReceiptIds) || item.executionReceiptIds.some((id) => !id.trim()))) {
      problems.push(`Agent delivery artifact case ${item.caseId} has invalid execution receipt references`)
    }
    if (item.outcome === 'passed' && (item.failureSource || item.failureKind)) problems.push(`Agent delivery artifact passed case ${item.caseId} has a failure classification`)
    if (item.outcome !== 'passed' && (!item.failureSource || !item.failureKind)) problems.push(`Agent delivery artifact non-passed case ${item.caseId} has no explicit failure classification`)
    if (item.outcome === 'product_failed' && item.failureSource !== 'product') problems.push(`Agent delivery artifact product-failed case ${item.caseId} is not product-sourced`)
    if (item.outcome === 'blocked' && item.failureSource === 'product') problems.push(`Agent delivery artifact blocked case ${item.caseId} is incorrectly product-sourced`)
  }
  if (!artifact.mutationLedger || artifact.mutationLedger.state !== 'terminal') problems.push('Agent delivery artifact does not report a terminal mutation ledger')
  if (!Array.isArray(artifact.mutationLedger?.entries)) problems.push('Agent delivery artifact mutation ledger entries must be an array')
  if (artifact.mutationLedger?.pendingCount !== 0) problems.push('Agent delivery artifact reports unresolved mutations')
  return problems
}

export async function recoverCodexDeliveryResult(options: {
  artifactPath: string
  manifest: WorkflowIntakeManifest
  startedAt: string
}): Promise<{ result?: CodexTestAgentResult; problems: string[] }> {
  if (!await access(options.artifactPath).then(() => true, () => false)) return { problems: ['Agent delivery artifact was not created'] }
  let artifact: AgentDeliveryArtifact
  try {
    const parsed = JSON.parse(await readFile(options.artifactPath, 'utf8')) as unknown
    if (parsed === null || (typeof parsed !== 'object' && !Array.isArray(parsed))) {
      return { problems: ['Agent delivery artifact must be a JSON object'] }
    }
    artifact = parsed as AgentDeliveryArtifact
  } catch (error) {
    return { problems: [`Agent delivery artifact could not be parsed: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const problems = validateArtifact(artifact, options.manifest)
  if (problems.length > 0) return { problems }
  const artifactRoot = dirname(options.artifactPath)
  for (const item of artifact.cases) {
    for (const evidence of item.evidencePaths ?? []) {
      if (!evidence || isAbsolute(evidence)) {
        problems.push(`Agent delivery artifact case ${item.caseId} has an invalid evidence path`)
        continue
      }
      const path = resolve(artifactRoot, evidence)
      const relativePath = relative(artifactRoot, path)
      if (relativePath.startsWith('..') || isAbsolute(relativePath) || !await access(path).then(() => true, () => false)) {
        problems.push(`Agent delivery artifact case ${item.caseId} references missing evidence ${evidence}`)
      }
    }
  }
  if (problems.length > 0) return { problems }
  const cases: CodexTestCaseResult[] = artifact.cases.map((item) => ({
    caseId: item.caseId,
    title: item.title ?? options.manifest.phases.find((phase) => phase.id === item.caseId)?.title ?? item.caseId,
    outcome: item.outcome,
    summary: item.summary,
    ...(item.failureSource && item.failureKind ? { failureSource: item.failureSource, failureKind: item.failureKind } : {}),
    ...(item.environmentRequirementIds?.length ? { environmentRequirementIds: item.environmentRequirementIds } : {}),
    ...(item.executionReceiptIds?.length ? { executionReceiptIds: item.executionReceiptIds } : {}),
    evidence: (item.evidencePaths?.length ?? 0) > 0
      ? item.evidencePaths!.map((path) => ({ kind: 'observation' as const, path, description: `AgentHost recorded evidence for ${item.caseId}: ${path}` }))
      : [{ kind: 'observation' as const, path: 'agent-workspace/case-results.json', description: `AgentHost recorded ${item.caseId} as ${item.outcome} in the delivery artifact.` }],
  }))
  const outcome = outcomeForCases(cases)
  const productDefects = cases
    .filter((item) => item.outcome === 'product_failed')
    .map((item) => item.summary)
  const blockers = cases
    .filter((item) => item.outcome === 'blocked')
    .map((item) => item.summary)
  return {
    problems: [],
    result: {
      version: '1.0',
      workflowId: options.manifest.workflowId,
      sourceSha256: options.manifest.source.sha256,
      outcome,
      summary: `Recovered AgentHost delivery artifact with ${cases.length} case results after the original structured delivery could not be accepted.`,
      startedAt: options.startedAt,
      finishedAt: new Date().toISOString(),
      cases,
      mutations: [],
      environmentRequirements: [],
      blockers: [...new Set(blockers)].slice(0, 50),
      productDefects: [...new Set(productDefects)].slice(0, 50),
      nextActions: outcome === 'passed' ? [] : ['Review the per-case evidence and resolve blocked or product-failed cases before declaring the business suite complete.'],
    },
  }
}

/**
 * Recover a completed logical suite from its per-epoch AgentHost artifacts.
 * This is used only when every immutable case is covered exactly once; a
 * partial or conflicting set fails closed and cannot override the aggregate.
 */
export async function recoverAgentEpochDeliveryResult(options: {
  workspaceDirectory: string
  manifest: WorkflowIntakeManifest
  startedAt: string
}): Promise<{ result?: CodexTestAgentResult; problems: string[] }> {
  const entries = await readdir(options.workspaceDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const artifactPaths = entries
    .filter((entry) => entry.isFile() && /^case-results\.epoch-[A-Za-z0-9._-]+\.json$/i.test(entry.name))
    .map((entry) => resolve(options.workspaceDirectory, entry.name))
    .sort()
  if (artifactPaths.length === 0) return { problems: ['Per-epoch AgentHost delivery artifacts were not created'] }

  const expectedIds = new Set(options.manifest.phases.map((phase) => phase.id))
  const seenIds = new Set<string>()
  const cases: CodexTestCaseResult[] = []
  const problems: string[] = []
  for (const artifactPath of artifactPaths) {
    let caseIds: string[]
    try {
      const parsed = JSON.parse(await readFile(artifactPath, 'utf8')) as { cases?: unknown }
      if (!Array.isArray(parsed.cases)) throw new Error('cases must be an array')
      caseIds = parsed.cases.map((item) => (
        item && typeof item === 'object' && !Array.isArray(item) && typeof (item as { caseId?: unknown }).caseId === 'string'
          ? (item as { caseId: string }).caseId
          : ''
      ))
      if (caseIds.some((id) => !id)) throw new Error('every case needs a caseId')
      if (new Set(caseIds).size !== caseIds.length) throw new Error('case IDs must be unique')
      if (caseIds.some((id) => !expectedIds.has(id))) throw new Error('artifact contains an unexpected case ID')
      if (caseIds.some((id) => seenIds.has(id))) throw new Error('case is duplicated across epoch artifacts')
    } catch (error) {
      problems.push(`${artifactPath}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const activeIds = new Set(caseIds)
    const scopedManifest = {
      ...options.manifest,
      phases: options.manifest.phases.filter((phase) => activeIds.has(phase.id)),
    }
    if (scopedManifest.phases.length !== caseIds.length) {
      problems.push(`${artifactPath}: epoch case scope does not match the immutable manifest`)
      continue
    }
    const recovered = await recoverAgentDeliveryResult({
      artifactPath,
      manifest: scopedManifest,
      startedAt: options.startedAt,
    })
    if (!recovered.result) {
      problems.push(...recovered.problems.map((problem) => `${artifactPath}: ${problem}`))
      continue
    }
    for (const caseId of caseIds) seenIds.add(caseId)
    cases.push(...recovered.result.cases)
  }
  for (const caseId of expectedIds) {
    if (!seenIds.has(caseId)) problems.push(`Per-epoch AgentHost delivery is missing case ${caseId}`)
  }
  if (problems.length > 0) return { problems }

  const byCaseId = new Map(cases.map((item) => [item.caseId, item]))
  const orderedCases = options.manifest.phases.map((phase) => byCaseId.get(phase.id)!)
  const outcome = outcomeForCases(orderedCases)
  const blockers = orderedCases.filter((item) => item.outcome === 'blocked').map((item) => item.summary)
  const productDefects = orderedCases.filter((item) => item.outcome === 'product_failed').map((item) => item.summary)
  return {
    problems: [],
    result: {
      version: '1.0',
      workflowId: options.manifest.workflowId,
      sourceSha256: options.manifest.source.sha256,
      outcome,
      summary: `Recovered ${artifactPaths.length} complete per-epoch AgentHost delivery artifact(s).`,
      startedAt: options.startedAt,
      finishedAt: new Date().toISOString(),
      cases: orderedCases,
      mutations: [],
      environmentRequirements: [],
      blockers: [...new Set(blockers)].slice(0, 50),
      productDefects: [...new Set(productDefects)].slice(0, 50),
      nextActions: outcome === 'passed'
        ? []
        : ['Review the per-case evidence and resolve blocked or product-failed cases before declaring the business suite complete.'],
    },
  }
}

/** Host-neutral recovery export; the historical name is retained for run compatibility. */
export const recoverAgentDeliveryResult = recoverCodexDeliveryResult
