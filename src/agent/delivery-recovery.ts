import { access, readFile } from 'node:fs/promises'
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

function validateArtifact(
  artifact: AgentDeliveryArtifact,
  manifest: WorkflowIntakeManifest,
): string[] {
  const problems: string[] = []
  if (artifact.version !== '1.0') problems.push('Codex delivery artifact version is unsupported')
  if (artifact.kind !== 'case-results') problems.push('Codex delivery artifact kind is unsupported')
  if (artifact.workflowId !== manifest.workflowId) problems.push('Codex delivery artifact workflowId does not match the immutable contract')
  if (artifact.sourceSha256 !== manifest.source.sha256) problems.push('Codex delivery artifact sourceSha256 does not match the immutable contract')
  if (!artifact.generatedAt?.trim()) problems.push('Codex delivery artifact has no generatedAt timestamp')
  if (!Array.isArray(artifact.cases)) problems.push('Codex delivery artifact cases must be an array')
  const required = new Set(manifest.phases.map((phase) => phase.id))
  const returned = artifact.cases.map((item) => item.caseId)
  if (new Set(returned).size !== returned.length) problems.push('Codex delivery artifact contains duplicate case IDs')
  for (const id of required) if (!returned.includes(id)) problems.push(`Codex delivery artifact is missing case ${id}`)
  for (const id of returned) if (!required.has(id)) problems.push(`Codex delivery artifact contains unexpected case ${id}`)
  for (const item of artifact.cases) {
    if (!item.summary?.trim()) problems.push(`Codex delivery artifact case ${item.caseId} has no summary`)
    if (!['passed', 'product_failed', 'blocked'].includes(item.outcome)) problems.push(`Codex delivery artifact case ${item.caseId} has an invalid outcome`)
    if (item.failureSource && !failureSources.has(item.failureSource)) problems.push(`Codex delivery artifact case ${item.caseId} has an invalid failureSource`)
    if (item.failureKind && !failureKinds.has(item.failureKind)) problems.push(`Codex delivery artifact case ${item.caseId} has an invalid failureKind`)
    if (item.environmentRequirementIds && (!Array.isArray(item.environmentRequirementIds) || item.environmentRequirementIds.some((id) => !id.trim()))) {
      problems.push(`Codex delivery artifact case ${item.caseId} has invalid environment requirement references`)
    }
    if (item.executionReceiptIds && (!Array.isArray(item.executionReceiptIds) || item.executionReceiptIds.some((id) => !id.trim()))) {
      problems.push(`Codex delivery artifact case ${item.caseId} has invalid execution receipt references`)
    }
    if (item.outcome === 'passed' && (item.failureSource || item.failureKind)) problems.push(`Codex delivery artifact passed case ${item.caseId} has a failure classification`)
    if (item.outcome !== 'passed' && (!item.failureSource || !item.failureKind)) problems.push(`Codex delivery artifact non-passed case ${item.caseId} has no explicit failure classification`)
    if (item.outcome === 'product_failed' && item.failureSource !== 'product') problems.push(`Codex delivery artifact product-failed case ${item.caseId} is not product-sourced`)
    if (item.outcome === 'blocked' && item.failureSource === 'product') problems.push(`Codex delivery artifact blocked case ${item.caseId} is incorrectly product-sourced`)
  }
  if (!artifact.mutationLedger || artifact.mutationLedger.state !== 'terminal') problems.push('Codex delivery artifact does not report a terminal mutation ledger')
  if (!Array.isArray(artifact.mutationLedger?.entries)) problems.push('Codex delivery artifact mutation ledger entries must be an array')
  if (artifact.mutationLedger?.pendingCount !== 0) problems.push('Codex delivery artifact reports unresolved mutations')
  return problems
}

export async function recoverCodexDeliveryResult(options: {
  artifactPath: string
  manifest: WorkflowIntakeManifest
  startedAt: string
}): Promise<{ result?: CodexTestAgentResult; problems: string[] }> {
  if (!await access(options.artifactPath).then(() => true, () => false)) return { problems: ['Codex delivery artifact was not created'] }
  let artifact: AgentDeliveryArtifact
  try {
    artifact = JSON.parse(await readFile(options.artifactPath, 'utf8')) as AgentDeliveryArtifact
  } catch (error) {
    return { problems: [`Codex delivery artifact could not be parsed: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const problems = validateArtifact(artifact, options.manifest)
  if (problems.length > 0) return { problems }
  const artifactRoot = dirname(options.artifactPath)
  for (const item of artifact.cases) {
    for (const evidence of item.evidencePaths ?? []) {
      if (!evidence || isAbsolute(evidence)) {
        problems.push(`Codex delivery artifact case ${item.caseId} has an invalid evidence path`)
        continue
      }
      const path = resolve(artifactRoot, evidence)
      const relativePath = relative(artifactRoot, path)
      if (relativePath.startsWith('..') || isAbsolute(relativePath) || !await access(path).then(() => true, () => false)) {
        problems.push(`Codex delivery artifact case ${item.caseId} references missing evidence ${evidence}`)
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
      ? item.evidencePaths!.map((path) => ({ kind: 'observation' as const, path, description: `Codex recorded evidence for ${item.caseId}: ${path}` }))
      : [{ kind: 'observation' as const, path: 'agent-workspace/case-results.json', description: `Codex recorded ${item.caseId} as ${item.outcome} in the delivery artifact.` }],
  }))
  const outcome = cases.some((item) => item.outcome === 'blocked')
    ? 'blocked'
    : cases.some((item) => item.outcome === 'product_failed') ? 'product_failed' : 'passed'
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
      summary: `Recovered Codex delivery artifact with ${cases.length} case results after structured response transport failure.`,
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
