import { access, readFile, readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { environmentRequirementsForCases } from './environment-requirements.js'
import {
  settlementClaimsFromDelivery,
  settlementClaimsFromResult,
  settlementOutcomeForClaims,
  settleResult,
  type ResultSettlementInput,
  type SettlementCaseClaim,
} from './result-settlement.js'
import type { WorkflowIntakeManifest } from '../workflow/types.js'
import type {
  CodexTestAgentResult,
  CodexTestCaseResult,
  CodexTestEnvironmentRequirement,
  CodexTestExecutionReceipt,
  CodexTestFailureKind,
  CodexTestFailureSource,
} from './types.js'

/**
 * The per-epoch delivery recovery Adapter.
 *
 * Its job is IO: find the artifacts an interrupted run left behind, read them,
 * resolve the evidence paths they reference, and aggregate the Epochs they
 * cover. Every shared invariant of the Result contract — identity, Case
 * membership, Evidence completeness, and failure classification — is judged by
 * the Result settlement seam, so a delivery cannot be accepted here while the
 * Runner's final settlement blocks the same claim. What stays local is what is
 * genuinely path-specific: the transport shape of an untrusted artifact and the
 * existence and workspace containment of evidence paths.
 */

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
const failureKinds = new Set<CodexTestFailureKind>(['assertion', 'validation', 'authentication', 'environment', 'data', 'execution', 'locator', 'mutation'])

const DELIVERY_NEXT_ACTION = 'Review the per-case evidence and resolve blocked or product-failed cases before declaring the business suite complete.'

/**
 * Recorded rows the caller read out of the run's private directory. They are the
 * authority for the references a claim may cite, so settlement judges claims
 * against them; a recovery handed no rows cannot confirm a requirement or
 * receipt reference and therefore fails closed on it.
 */
export interface DeliveryRecoveryRecordedRows {
  environmentRequirements?: readonly CodexTestEnvironmentRequirement[]
  executionReceipts?: readonly CodexTestExecutionReceipt[]
}

type DeliveryRecoveryOptions = {
  artifactPath: string
  manifest: WorkflowIntakeManifest
  startedAt: string
} & DeliveryRecoveryRecordedRows

/**
 * Transport shape of an untrusted artifact: its envelope, the value domains of
 * its rows, and its own ledger projection. Nothing here is a business invariant —
 * the rows have not become Case claims yet. `cases` is left undefined when the
 * case list itself is unusable, because no claim can be normalized from it and
 * judging the rest would produce noise instead of facts.
 */
function artifactShape(artifact: AgentDeliveryArtifact): { problems: string[]; cases?: AgentCaseArtifact[] } {
  const problems: string[] = []
  if (artifact.version !== '1.0') problems.push('Agent delivery artifact version is unsupported')
  if (artifact.kind !== 'case-results') problems.push('Agent delivery artifact kind is unsupported')
  if (!artifact.generatedAt?.trim()) problems.push('Agent delivery artifact has no generatedAt timestamp')
  if (!Array.isArray(artifact.cases)) {
    problems.push('Agent delivery artifact cases must be an array')
    return { problems }
  }
  const rawCases = artifact.cases
  const cases = rawCases.filter((item): item is AgentCaseArtifact => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
  if (cases.length !== rawCases.length) {
    problems.push('Agent delivery artifact cases must contain objects')
    return { problems }
  }
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
  }
  if (!artifact.mutationLedger || artifact.mutationLedger.state !== 'terminal') problems.push('Agent delivery artifact does not report a terminal mutation ledger')
  if (!Array.isArray(artifact.mutationLedger?.entries)) problems.push('Agent delivery artifact mutation ledger entries must be an array')
  if (artifact.mutationLedger?.pendingCount !== 0) problems.push('Agent delivery artifact reports unresolved mutations')
  return { problems, cases }
}

/**
 * IO-specific and Adapter-owned: a referenced evidence path must be
 * workspace-relative and must exist. The settlement seam never touches the
 * filesystem, so path resolution cannot be delegated.
 */
async function evidencePathProblems(cases: readonly AgentCaseArtifact[], artifactRoot: string): Promise<string[]> {
  const problems: string[] = []
  for (const item of cases) {
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
  return problems
}

function submissionInput(options: {
  manifest: WorkflowIntakeManifest
  claims: readonly SettlementCaseClaim[]
  workflowId: string
  sourceSha256: string
  startedAt: string
  finishedAt: string
  summary: string
  environmentRequirements: readonly CodexTestEnvironmentRequirement[] | undefined
  executionReceipts: readonly CodexTestExecutionReceipt[] | undefined
}): ResultSettlementInput {
  const claims = options.claims
  const outcome = settlementOutcomeForClaims(claims)
  return {
    manifest: options.manifest,
    claims,
    workflowId: options.workflowId,
    sourceSha256: options.sourceSha256,
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    outcome,
    summary: options.summary,
    blockers: [...new Set(claims.filter((claim) => claim.outcome === 'blocked').map((claim) => claim.summary))].slice(0, 50),
    productDefects: [...new Set(claims.filter((claim) => claim.outcome === 'product_failed').map((claim) => claim.summary))].slice(0, 50),
    nextActions: outcome === 'passed' ? [] : [DELIVERY_NEXT_ACTION],
    // The artifact's own ledger projection was checked above; the authoritative
    // ledger belongs to the Runner and is settled with the final Result.
    mutationLedger: [],
    ...(options.environmentRequirements ? { environmentRequirements: options.environmentRequirements } : {}),
    ...(options.executionReceipts ? { executionReceipts: options.executionReceipts } : {}),
  }
}

/**
 * Settle one recovered delivery artifact. The claims are normalized into the
 * seam's vocabulary first, so the verdict is the seam's and not a second
 * implementation of the same rules.
 */
function settleDeliveryArtifact(options: {
  rows: AgentCaseArtifact[]
  manifest: WorkflowIntakeManifest
  artifactReference: string
  workflowId: string
  sourceSha256: string
  startedAt: string
  environmentRequirements: readonly CodexTestEnvironmentRequirement[] | undefined
  executionReceipts: readonly CodexTestExecutionReceipt[] | undefined
}): { result?: CodexTestAgentResult; problems: string[] } {
  const claims = settlementClaimsFromDelivery(options.rows, options.artifactReference)
  return finishSettlement(settleResult(submissionInput({
    manifest: options.manifest,
    claims,
    workflowId: options.workflowId,
    sourceSha256: options.sourceSha256,
    startedAt: options.startedAt,
    finishedAt: new Date().toISOString(),
    summary: `Recovered AgentHost delivery artifact with ${claims.length} case results after the original structured delivery could not be accepted.`,
    environmentRequirements: options.environmentRequirements,
    executionReceipts: options.executionReceipts,
  })))
}

/**
 * The recorded environment-requirement projection stays with the Runner: it owns
 * the Mutation Ledger and the requirement rows that compose the final Result,
 * and settlement has already reconciled these claims against them here.
 */
function finishSettlement(settlement: { result?: CodexTestAgentResult; problems: string[] }): { result?: CodexTestAgentResult; problems: string[] } {
  if (!settlement.result) return { problems: settlement.problems }
  return { problems: [], result: { ...settlement.result, environmentRequirements: [] } }
}

export async function recoverCodexDeliveryResult(options: DeliveryRecoveryOptions): Promise<{ result?: CodexTestAgentResult; problems: string[] }> {
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
  const shape = artifactShape(artifact)
  if (!shape.cases) return { problems: shape.problems }
  // Every problem of one artifact is reported together: the correction prompt
  // the AgentHost receives must not hide a contract failure behind another.
  const pathProblems = await evidencePathProblems(shape.cases, dirname(options.artifactPath))
  const settlement = settleDeliveryArtifact({
    rows: shape.cases,
    manifest: options.manifest,
    artifactReference: basename(options.artifactPath),
    workflowId: artifact.workflowId,
    sourceSha256: artifact.sourceSha256,
    startedAt: options.startedAt,
    environmentRequirements: options.environmentRequirements,
    executionReceipts: options.executionReceipts,
  })
  const problems = [...shape.problems, ...pathProblems, ...settlement.problems]
  // Fail closed: a transport problem the seam cannot see — an outcome value
  // outside its domain, a missing summary — blocks the result even though the
  // claims themselves settled.
  if (problems.length > 0 || !settlement.result) return { problems }
  return { problems: [], result: settlement.result }
}

/**
 * Recover a completed logical suite from its per-epoch AgentHost artifacts.
 * This is used only when every immutable case is covered exactly once; a
 * partial or conflicting set fails closed and cannot override the aggregate.
 * Whether the Epochs together cover the contract exactly once is a shared
 * invariant, so the aggregation is settled through the same seam.
 */
export async function recoverAgentEpochDeliveryResult(options: {
  workspaceDirectory: string
  manifest: WorkflowIntakeManifest
  startedAt: string
} & DeliveryRecoveryRecordedRows): Promise<{ result?: CodexTestAgentResult; problems: string[] }> {
  const entries = await readdir(options.workspaceDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const artifactPaths = entries
    .filter((entry) => entry.isFile() && /^case-results\.epoch-[A-Za-z0-9._-]+\.json$/i.test(entry.name))
    .map((entry) => resolve(options.workspaceDirectory, entry.name))
    .sort()
  if (artifactPaths.length === 0) return { problems: ['Per-epoch AgentHost delivery artifacts were not created'] }

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
    } catch (error) {
      problems.push(`${artifactPath}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const scopedManifest = {
      ...options.manifest,
      phases: options.manifest.phases.filter((phase) => caseIds.includes(phase.id)),
    }
    const recovered = await recoverCodexDeliveryResult({
      artifactPath,
      manifest: scopedManifest,
      startedAt: options.startedAt,
      ...(options.environmentRequirements
        ? { environmentRequirements: environmentRequirementsForCases(options.environmentRequirements, caseIds) }
        : {}),
      ...(options.executionReceipts ? { executionReceipts: options.executionReceipts } : {}),
    })
    if (!recovered.result) {
      problems.push(...recovered.problems.map((problem) => `${artifactPath}: ${problem}`))
      continue
    }
    cases.push(...recovered.result.cases)
  }
  if (problems.length > 0) return { problems }

  // Manifest order, duplicates kept: a case claimed by two Epochs has to reach
  // the seam as a duplicate claim so it is rejected here instead of silently
  // collapsing into one result.
  const orderedCases = options.manifest.phases
    .flatMap((phase) => cases.filter((item) => item.caseId === phase.id))
  const claims = settlementClaimsFromResult(orderedCases)
  const settlement = settleResult(submissionInput({
    manifest: options.manifest,
    claims,
    workflowId: options.manifest.workflowId,
    sourceSha256: options.manifest.source.sha256,
    startedAt: options.startedAt,
    finishedAt: new Date().toISOString(),
    summary: `Recovered ${artifactPaths.length} complete per-epoch AgentHost delivery artifact(s).`,
    environmentRequirements: options.environmentRequirements,
    executionReceipts: options.executionReceipts,
  }))
  return finishSettlement(settlement)
}

/** Host-neutral recovery export; the historical name is retained for run compatibility. */
export const recoverAgentDeliveryResult = recoverCodexDeliveryResult
