import { failureModeFor } from './failure-mode.js'
import type {
  CodexTestAgentResult,
  CodexTestCaseResult,
  CodexTestEnvironmentRequirement,
  CodexTestExecutionReceipt,
  CodexTestEvidence,
  CodexTestFailureKind,
  CodexTestFailureSource,
  CodexTestMutationLedgerEntry,
  CodexTestOutcome,
} from './types.js'
import type { WorkflowIntakeManifest } from '../workflow/types.js'

/**
 * The Result settlement module: the one place the Result contract is decided.
 *
 * Entry points that produce or consume a Result — the per-Epoch delivery
 * Adapter, the Runner's final settlement, the cross-host comparison tool, and
 * acceptance reporting — all submit to this seam. Each Adapter keeps owning IO
 * (reading artifacts, resolving evidence paths, aggregating Epochs) and reports
 * its own path-specific problems; every shared invariant lives here so one rule
 * change reaches every path and two paths can never disagree about the same
 * Case claim. This module is that seam and its Case-claim vocabulary; the
 * Adapters are migrated onto it one by one behind the same interface.
 */

/**
 * The single internal Case-claim representation settlement reasons about.
 *
 * Every entry point — a per-epoch delivery artifact, an AgentHost structured
 * delivery, an aggregated Epoch result, or a settled artifact re-read by the
 * comparison and reporting tools — normalizes into this shape first, so one
 * invariant is evaluated once against one vocabulary instead of being
 * re-derived per transport. It deliberately stays independent of the Result
 * transport schema: `title` is optional because the immutable manifest is the
 * authority for it, and the reference arrays are readonly because a submission
 * is never mutated while it is being assessed.
 */
export interface SettlementCaseClaim {
  caseId: string
  title?: string
  outcome: CodexTestOutcome
  summary: string
  failureSource?: CodexTestFailureSource
  failureKind?: CodexTestFailureKind
  environmentRequirementIds?: readonly string[]
  executionReceiptIds?: readonly string[]
  /** Field-composition gate references; carried through so settlement stays lossless. */
  fieldGateIds?: readonly string[]
  evidence: readonly CodexTestEvidence[]
}

/**
 * One per-case row of a delivery artifact. Only the case-level facts a claim
 * needs live here; the artifact envelope (version, kind, timestamps, ledger
 * summary) is transport shape and stays in the Adapter that reads it.
 */
export interface DeliveryCaseClaimRow {
  caseId: string
  title?: string
  outcome: CodexTestOutcome
  summary: string
  failureSource?: CodexTestFailureSource
  failureKind?: CodexTestFailureKind
  environmentRequirementIds?: readonly string[]
  executionReceiptIds?: readonly string[]
  evidencePaths?: readonly string[]
}

/** Everything a caller submits for settlement. */
export interface ResultSettlementInput {
  /** The immutable test contract every claim is measured against. */
  manifest: WorkflowIntakeManifest
  /** Normalized Case claims; the only case representation settlement reasons about. */
  claims: readonly SettlementCaseClaim[]
  /** Submitted transport identity, checked against the immutable manifest. */
  workflowId: string
  sourceSha256: string
  startedAt: string
  finishedAt: string
  /** Submitted top-level outcome, checked against the outcome derived from the claims. */
  outcome: CodexTestOutcome
  /** Submitted narrative, checked against the derived outcome. */
  summary: string
  blockers: readonly string[]
  productDefects: readonly string[]
  nextActions: readonly string[]
  /** Environment requirement projection the submission reports, reconciled against the recorded rows. */
  reportedEnvironmentRequirements?: readonly CodexTestEnvironmentRequirement[]
  /** Runner-owned Mutation Ledger rows; a pending row blocks the run it belongs to. */
  mutationLedger?: readonly CodexTestMutationLedgerEntry[]
  /** Recorded environment requirements; the authority for requirement reconciliation. */
  environmentRequirements?: readonly CodexTestEnvironmentRequirement[]
  /** Recorded execution receipts; the authority for receipt references. */
  executionReceipts?: readonly CodexTestExecutionReceipt[]
  /** Problems already raised by the replay projection; appended unchanged. */
  replayProblems?: readonly string[]
}

/**
 * Fail-closed by construction: a settlement carries either the canonical Result
 * or a non-empty problem list. A caller can never receive a result that failed
 * an invariant, and never has to reason about "a result with warnings".
 */
export interface ResultSettlement {
  result?: CodexTestAgentResult
  problems: string[]
}

/**
 * The one settlement seam of the Result contract.
 *
 * Pure, synchronous, and free of file, AgentHost, and browser dependencies:
 * callers hand over immutable inputs, and settlement either composes the
 * canonical Result or returns every problem it found. Adapters keep owning IO
 * (reading artifacts, resolving evidence paths, aggregating Epochs) and report
 * their own path-specific problems separately.
 */
export function settleResult(input: ResultSettlementInput): ResultSettlement {
  const problems = settlementProblems(input)
  if (problems.length > 0) return { problems }
  return { result: canonicalResult(input), problems: [] }
}

/**
 * Every shared invariant of the Result contract, in composition order: identity,
 * Case membership, Case-level contract requirements, environment requirement
 * reconciliation, top-level outcome derivation, then the run's replay problems.
 * Exported separately because consumers such as the cross-host comparison tool
 * need the authority verdict without recomposing a Result.
 */
export function settlementProblems(input: ResultSettlementInput): string[] {
  const problems: string[] = []
  const manifest = input.manifest
  const claims = input.claims
  const environmentRequirements = input.environmentRequirements ?? []
  const executionReceipts = input.executionReceipts ?? []

  if (input.workflowId !== manifest.workflowId) problems.push('workflowId does not match the immutable test contract')
  if (input.sourceSha256 !== manifest.source.sha256) problems.push('sourceSha256 does not match the original test material')
  const requiredCases = new Set(manifest.phases.map((phase) => phase.id))
  const returnedCases = claims.map((claim) => claim.caseId)
  if (new Set(returnedCases).size !== returnedCases.length) problems.push('duplicate case results are not allowed')
  for (const caseId of requiredCases) if (!returnedCases.includes(caseId)) problems.push(`missing final case result for ${caseId}`)
  for (const caseId of returnedCases) if (!requiredCases.has(caseId)) problems.push(`unexpected case result for ${caseId}`)

  for (const claim of claims) {
    const phase = manifest.phases.find((candidate) => candidate.id === claim.caseId)
    if (claim.evidence.length === 0) problems.push(`case ${claim.caseId} has no execution evidence`)
    if (claim.outcome === 'passed' && (claim.failureSource || claim.failureKind)) problems.push(`passed case ${claim.caseId} contains a failure classification`)
    if (claim.outcome !== 'passed' && (!claim.failureSource || !claim.failureKind)) problems.push(`non-passed case ${claim.caseId} has no failure classification`)
    if (claim.outcome === 'product_failed' && claim.failureSource !== 'product') problems.push(`product-failed case ${claim.caseId} is not classified as product-sourced`)
    if (claim.outcome === 'blocked' && claim.failureSource === 'product') problems.push(`blocked case ${claim.caseId} is incorrectly classified as product-sourced`)

    // Receipts are passively captured audit evidence. They are validated when
    // the agent cites them, but missing optional case bookkeeping must not
    // prevent the primary AgentHost thread from exploring or delivering facts.
    const caseReceipts = claim.executionReceiptIds
      ?.map((id) => executionReceipts.find((receipt) => receipt.id === id))
      .filter((receipt): receipt is CodexTestExecutionReceipt => Boolean(receipt)) ?? []
    if (claim.executionReceiptIds?.some((id) => !executionReceipts.some((receipt) => receipt.id === id))) {
      problems.push(`case ${claim.caseId} references unknown execution receipts`)
    }
    if (caseReceipts.some((receipt) => receipt.caseId !== claim.caseId)) {
      problems.push(`case ${claim.caseId} references an execution receipt belonging to another case`)
    }

    if (claim.outcome !== 'blocked' && phase?.outcome) {
      if (phase.outcome.evidence.includes('observation') && !claim.evidence.some((evidence) => evidence.kind === 'observation')) {
        problems.push(`case ${claim.caseId} does not satisfy its outcome observation evidence requirement`)
      }
      if (phase.outcome.evidence.includes('interaction') && !caseReceipts.some((receipt) => receipt.kind === 'interaction')) {
        problems.push(`case ${claim.caseId} does not satisfy its outcome interaction receipt requirement`)
      }
    }
    if (claim.outcome !== 'passed' && phase?.outcome) {
      const allowedModes = phase.outcome.failureModes ?? []
      if (allowedModes.length > 0) {
        const mode = failureModeFor(claim.failureSource, claim.failureKind)
        if (!allowedModes.includes(mode)) problems.push(`case ${claim.caseId} failure mode ${mode} is not allowed by its outcome contract`)
      }
    }

    if (claim.failureSource === 'environment') {
      if (!claim.environmentRequirementIds?.length) {
        problems.push(`environment-blocked case ${claim.caseId} has no recorded environment requirement reference`)
        continue
      }
      for (const requirementId of claim.environmentRequirementIds) {
        const requirement = environmentRequirements.find((candidate) => candidate.id === requirementId)
        if (!requirement) {
          problems.push(`environment-blocked case ${claim.caseId} references unknown environment requirement ${requirementId}`)
          continue
        }
        if (!requirement.caseIds.includes(claim.caseId)) problems.push(`environment-blocked case ${claim.caseId} is not linked to environment requirement ${requirementId}`)
        if (requirement.status !== 'pending') problems.push(`environment-blocked case ${claim.caseId} references non-pending environment requirement ${requirementId}`)
        if (requirement.evidence.length === 0) problems.push(`environment requirement ${requirementId} has no saved evidence`)
      }
    } else if (claim.environmentRequirementIds?.length) {
      problems.push(`non-environment case ${claim.caseId} contains environment requirement references`)
    }
  }

  const recordedById = new Map(environmentRequirements.map((item) => [item.id, item]))
  for (const requirement of input.reportedEnvironmentRequirements ?? []) {
    const recorded = recordedById.get(requirement.id)
    if (!recorded) {
      problems.push(`final result includes unrecorded environment requirement ${requirement.id}`)
      continue
    }
    if (!sameEnvironmentRequirement(requirement, recorded)) {
      problems.push(`final result environment requirement ${requirement.id} does not match the recorded requirement`)
    }
  }
  for (const requirement of environmentRequirements.filter((item) => item.status === 'pending')) {
    for (const caseId of requirement.caseIds) {
      const claim = claims.find((item) => item.caseId === caseId)
      if (!claim || claim.failureSource !== 'environment' || !claim.environmentRequirementIds?.includes(requirement.id)) {
        problems.push(`pending environment requirement ${requirement.id} is not represented by environment-blocked case ${caseId}`)
      }
    }
  }

  const expectedOutcome = outcomeForClaims(claims)
  if (input.outcome !== expectedOutcome) problems.push(`top-level outcome must be ${expectedOutcome}`)
  if (input.outcome === 'passed' && (input.blockers.length > 0 || input.productDefects.length > 0)) problems.push('passed result contains blockers or product defects')
  if (input.outcome === 'blocked' && input.blockers.length === 0) problems.push('blocked result has no blocker')
  if (input.outcome === 'product_failed' && input.productDefects.length === 0) problems.push('product-failed result has no product defect')
  problems.push(...input.replayProblems ?? [])
  return problems
}

/**
 * The top-level outcome a claim set settles to. An Adapter that has no
 * submitted outcome of its own — a per-epoch delivery artifact records only
 * per-case facts — reports this value, so the derivation stays in the seam
 * instead of being re-written per transport.
 */
export function settlementOutcomeForClaims(claims: readonly SettlementCaseClaim[]): CodexTestOutcome {
  return outcomeForClaims(claims)
}

/** Normalize the cases of a canonical Result into the one Case-claim representation. */
export function settlementClaimsFromResult(cases: readonly CodexTestCaseResult[]): SettlementCaseClaim[] {
  return cases.map((item) => ({
    caseId: item.caseId,
    title: item.title,
    outcome: item.outcome,
    summary: item.summary,
    ...(item.failureSource ? { failureSource: item.failureSource } : {}),
    ...(item.failureKind ? { failureKind: item.failureKind } : {}),
    ...(item.environmentRequirementIds?.length ? { environmentRequirementIds: item.environmentRequirementIds } : {}),
    ...(item.executionReceiptIds?.length ? { executionReceiptIds: item.executionReceiptIds } : {}),
    ...(item.fieldGateIds?.length ? { fieldGateIds: item.fieldGateIds } : {}),
    evidence: item.evidence,
  }))
}

/**
 * Normalize delivery-artifact case rows into the same Case-claim
 * representation. An artifact row records evidence as workspace-relative paths
 * instead of Evidence entries, so each path becomes an observation and a row
 * with no path at all becomes an observation of the artifact itself. The
 * `artifactReference` is the file name the Adapter read, kept here because it is
 * part of what the claim asserts, not of how the artifact was found.
 */
export function settlementClaimsFromDelivery(
  cases: readonly DeliveryCaseClaimRow[],
  artifactReference: string,
): SettlementCaseClaim[] {
  return cases.map((item) => ({
    caseId: item.caseId,
    ...(item.title ? { title: item.title } : {}),
    outcome: item.outcome,
    summary: item.summary,
    ...(item.failureSource ? { failureSource: item.failureSource } : {}),
    ...(item.failureKind ? { failureKind: item.failureKind } : {}),
    ...(item.environmentRequirementIds?.length ? { environmentRequirementIds: item.environmentRequirementIds } : {}),
    ...(item.executionReceiptIds?.length ? { executionReceiptIds: item.executionReceiptIds } : {}),
    evidence: (item.evidencePaths?.length ?? 0) > 0
      ? item.evidencePaths!.map((path) => ({
        kind: 'observation' as const,
        path,
        description: `AgentHost recorded evidence for ${item.caseId}: ${path}`,
      }))
      : [{
        kind: 'observation' as const,
        path: artifactReference,
        description: `AgentHost recorded ${item.caseId} as ${item.outcome} in ${artifactReference}.`,
      }],
  }))
}

/** Compose the canonical Result of a submission that passed every invariant. */
function canonicalResult(input: ResultSettlementInput): CodexTestAgentResult {
  const ledger = input.mutationLedger ?? []
  const environmentRequirements = input.environmentRequirements ?? []
  const pendingRequirements = environmentRequirements.filter((item) => item.status === 'pending')
  const pendingMutations = ledger.filter((entry) => entry.status === 'pending')

  let summary = input.summary
  if (pendingRequirements.length > 0) summary = `${summary} Required environment prerequisites remain unavailable.`
  if (pendingMutations.length > 0) summary = `${summary} Unrecovered business mutations remain.`
  let blockers = pendingRequirements.length > 0
    ? [...new Set([...input.blockers, ...pendingRequirements.map((item) => item.condition)])]
    : [...input.blockers]
  if (pendingMutations.length > 0) blockers = [...blockers, `Unrecovered mutations: ${pendingMutations.map((entry) => entry.id).join(', ')}`]
  const nextActions = pendingRequirements.length > 0
    ? [...new Set([...input.nextActions, ...pendingRequirements.map((item) => `Provide the required ${item.kind} prerequisite: ${item.condition}, then resume the same run.`)])]
    : [...input.nextActions]

  const claims = enforceMutationLedgerOnClaims(input.claims, pendingMutations)
  return {
    version: '1.0',
    workflowId: input.workflowId,
    sourceSha256: input.sourceSha256,
    outcome: outcomeForClaims(claims),
    summary,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    cases: claims.map((claim) => caseResultFromClaim(claim, input.manifest)),
    mutations: ledger.map((entry) => ({
      id: entry.id,
      caseId: entry.caseId,
      description: entry.description,
      risk: entry.risk,
      status: entry.status,
      evidence: entry.evidence,
    })),
    environmentRequirements: [...environmentRequirements],
    blockers,
    productDefects: [...input.productDefects],
    nextActions,
  }
}

/**
 * An unrecovered business write can never be reported as a success: the case it
 * belongs to becomes blocked with an agent-execution classification and carries
 * the pending mutation as its own evidence. An explicit blocked classification
 * is preserved so an environment block is not rewritten into an execution
 * failure.
 */
function enforceMutationLedgerOnClaims(
  claims: readonly SettlementCaseClaim[],
  pendingMutations: readonly CodexTestMutationLedgerEntry[],
): SettlementCaseClaim[] {
  if (pendingMutations.length === 0) return [...claims]
  const pendingByCase = new Map<string, CodexTestMutationLedgerEntry[]>()
  for (const entry of pendingMutations) pendingByCase.set(entry.caseId, [...(pendingByCase.get(entry.caseId) ?? []), entry])
  return claims.map((claim) => {
    const entries = pendingByCase.get(claim.caseId)
    if (!entries) return claim
    const preserveBlockedClassification = claim.outcome === 'blocked'
    return {
      ...claim,
      outcome: 'blocked',
      summary: `${claim.summary} Unrecovered business mutations remain for this case.`,
      failureSource: preserveBlockedClassification ? (claim.failureSource ?? 'agent_execution') : 'agent_execution',
      failureKind: preserveBlockedClassification ? (claim.failureKind ?? 'execution') : 'execution',
      evidence: [
        ...claim.evidence,
        ...entries.map((entry) => ({
          kind: 'mutation' as const,
          description: `Pending mutation ${entry.id}: ${entry.description}`,
        })),
      ],
    }
  })
}

function caseResultFromClaim(claim: SettlementCaseClaim, manifest: WorkflowIntakeManifest): CodexTestCaseResult {
  return {
    caseId: claim.caseId,
    title: claim.title ?? manifest.phases.find((phase) => phase.id === claim.caseId)?.title ?? claim.caseId,
    outcome: claim.outcome,
    summary: claim.summary,
    ...(claim.failureSource ? { failureSource: claim.failureSource } : {}),
    ...(claim.failureKind ? { failureKind: claim.failureKind } : {}),
    ...(claim.environmentRequirementIds?.length ? { environmentRequirementIds: [...claim.environmentRequirementIds] } : {}),
    ...(claim.executionReceiptIds?.length ? { executionReceiptIds: [...claim.executionReceiptIds] } : {}),
    ...(claim.fieldGateIds?.length ? { fieldGateIds: [...claim.fieldGateIds] } : {}),
    evidence: claim.evidence.map((evidence) => (
      evidence.path == null
        ? { kind: evidence.kind, description: evidence.description }
        : { kind: evidence.kind, description: evidence.description, path: evidence.path }
    )),
  }
}

function outcomeForClaims(claims: readonly SettlementCaseClaim[]): CodexTestOutcome {
  if (claims.some((item) => item.outcome === 'blocked')) return 'blocked'
  if (claims.some((item) => item.outcome === 'product_failed')) return 'product_failed'
  return 'passed'
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value))
}

function sameEnvironmentRequirement(
  left: CodexTestEnvironmentRequirement,
  right: CodexTestEnvironmentRequirement,
): boolean {
  return left.id === right.id &&
    left.kind === right.kind &&
    left.origin === right.origin &&
    left.condition === right.condition &&
    left.status === right.status &&
    left.requestedAt === right.requestedAt &&
    sameStringSet(left.caseIds, right.caseIds) &&
    sameStringSet(left.evidence, right.evidence)
}
