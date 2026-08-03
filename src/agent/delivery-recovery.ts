import { access, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { WorkflowIntakeManifest } from '../workflow/types.js'
import type { CodexTestAgentResult, CodexTestCaseResult, CodexTestFailureKind, CodexTestFailureSource } from './types.js'

interface AgentCaseArtifact {
  caseId: string
  title?: string
  outcome: 'passed' | 'product_failed' | 'blocked'
  summary: string
  evidence?: string[]
  blockers?: string[]
  productDefects?: string[]
  failureSource?: CodexTestFailureSource
  failureKind?: CodexTestFailureKind
}

interface AgentDeliveryArtifact {
  workflowId: string
  source?: { sha256?: string }
  generatedAt?: string
  cases: AgentCaseArtifact[]
  mutationLedger?: { pending?: number; entries?: unknown[] }
}

const failureSources = new Set<CodexTestFailureSource>(['product', 'agent_execution', 'environment', 'input'])
const failureKinds = new Set<CodexTestFailureKind>(['assertion', 'validation', 'authentication', 'environment', 'data', 'execution'])

function failureForArtifact(item: AgentCaseArtifact): { failureSource: CodexTestFailureSource; failureKind: CodexTestFailureKind } | undefined {
  if (item.outcome === 'passed') return undefined
  if (item.failureSource && item.failureKind) return { failureSource: item.failureSource, failureKind: item.failureKind }
  if (item.outcome === 'product_failed') return { failureSource: 'product', failureKind: 'assertion' }
  const text = `${item.summary} ${(item.blockers ?? []).join(' ')}`
  if (/missing|not provided|test data|数据|缺少/i.test(text)) return { failureSource: 'environment', failureKind: 'data' }
  if (/permission|policy|authorization|allowedRisk|not authorized|权限|策略|授权/i.test(text)) {
    return { failureSource: 'input', failureKind: 'validation' }
  }
  if (/authentication|login|captcha|登录|验证码/i.test(text)) return { failureSource: 'environment', failureKind: 'authentication' }
  return { failureSource: 'agent_execution', failureKind: 'execution' }
}

function validateArtifact(
  artifact: AgentDeliveryArtifact,
  manifest: WorkflowIntakeManifest,
): string[] {
  const problems: string[] = []
  if (artifact.workflowId !== manifest.workflowId) problems.push('Codex delivery artifact workflowId does not match the immutable contract')
  if (artifact.source?.sha256 !== manifest.source.sha256) problems.push('Codex delivery artifact sourceSha256 does not match the immutable contract')
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
  }
  const pending = artifact.mutationLedger?.pending ?? 0
  if (pending !== 0) problems.push('Codex delivery artifact reports unresolved mutations')
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
    for (const evidence of item.evidence ?? []) {
      if (!evidence.startsWith('evidence/')) {
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
    ...(failureForArtifact(item) ?? {}),
    evidence: (item.evidence?.length ?? 0) > 0
      ? item.evidence!.map((path) => ({ kind: 'observation' as const, path, description: `Codex recorded evidence for ${item.caseId}: ${path}` }))
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
