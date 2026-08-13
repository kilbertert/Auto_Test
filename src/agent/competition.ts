import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { WorkflowIntakeManifest } from '../workflow/types.js'
import type {
  AgentTestCaseResult,
  AgentTestFailureKind,
  AgentTestFailureMode,
  AgentTestFailureSource,
  AgentTestOutcome,
  AgentTestResult,
  CodexTestAgentState,
  CodexTestExecutionReceipt,
  CodexTestMutationLedgerEntry,
} from './types.js'
import { parseAgentTestResult } from './result.js'
import { failureModeCounts } from './failure-mode.js'
import { usageFrom } from './host.js'
import { writePrivateJson } from './state.js'

export interface AgentCompetitionOracleCase {
  caseId: string
  outcome: AgentTestOutcome
  /** Omitted failure fields are wildcards and are not compared. */
  failureSource?: AgentTestFailureSource
  failureKind?: AgentTestFailureKind
}

export interface AgentCompetitionOracle {
  version: '1.0'
  /** The oracle is valid only for this immutable input contract. */
  workflowId: string
  sourceSha256: string
  cases: AgentCompetitionOracleCase[]
}

export interface AgentCompetitionCandidateSummary {
  runDirectory: string
  hostId: string
  displayName?: string
  executable?: string
  platform: string
  arch: string
  packageVersion?: string
  commit?: string
  manifestSha256?: string
  environmentSha256?: string
  terminal: boolean
  outcome: AgentTestOutcome
  caseCounts: { passed: number; product_failed: number; blocked: number }
  evidenceCount: number
  citedReceiptCount: number
  mutationCount: number
  pendingMutationCount: number
  inputBundleSha256?: string
  durationMs?: number
  oracleMatchedCases?: number
  oracleMatchRate?: number
  failureSources: Partial<Record<AgentTestFailureSource, number>>
  failureKinds: Partial<Record<AgentTestFailureKind, number>>
  failureModes: Partial<Record<AgentTestFailureMode, number>>
  /** Aggregated token usage across the run's completed turns. */
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  /** Physical AgentHost threads used; the first thread is generation 1. */
  threadGeneration?: number
  epochCount?: number
  /** Number of recovered/replacement threads beyond the first. */
  recoveryCount?: number
  interruptionCode?: string
  baselineDelta?: {
    durationMs?: number
    evidenceCount: number
    citedReceiptCount: number
    mutationCount: number
    oracleMatchedCases?: number
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
  }
}

export interface AgentCompetitionCaseDifference {
  caseId: string
  outcomes: Array<{
    hostId: string
    outcome: AgentTestOutcome
    failureSource?: AgentTestFailureSource
    failureKind?: AgentTestFailureKind
    summary: string
  }>
}

export interface AgentCompetitionReport {
  version: '1.0'
  kind: 'agent-competition'
  generatedAt: string
  workflowId: string
  sourceSha256: string
  contractStatus: 'valid' | 'invalid'
  contractProblems: string[]
  candidates: AgentCompetitionCandidateSummary[]
  caseDifferences: AgentCompetitionCaseDifference[]
  verdict: 'equivalent' | 'different' | 'oracle_winner' | 'undetermined' | 'invalid'
  winnerHostId?: string
  oracle?: AgentCompetitionOracle
}

interface LoadedCandidate {
  summary: AgentCompetitionCandidateSummary
  result: AgentTestResult
  state: CodexTestAgentState
  ledger: CodexTestMutationLedgerEntry[]
  receipts: CodexTestExecutionReceipt[]
  selection: AgentHostSelectionArtifact
  validationProblems?: string[]
  manifest?: WorkflowIntakeManifest
  inputBundle?: InputBundleArtifact
  environmentSelection?: EnvironmentSelectionArtifact
}

interface InputBundleArtifact {
  briefSha256?: unknown
  imageSha256s?: unknown
  bundleSha256?: unknown
}

interface AgentHostSelectionArtifact {
  id?: unknown
  displayName?: unknown
  executable?: unknown
  capabilities?: unknown
  platform?: unknown
  arch?: unknown
  packageVersion?: unknown
  commit?: unknown
}

interface EnvironmentSelectionArtifact {
  profileId?: unknown
  origins?: unknown
  policy?: unknown
  authenticatedOrigins?: unknown
  testDataSha256?: unknown
  testDataAccess?: unknown
}

interface JsonArtifact<T> {
  exists: boolean
  value?: T
  error?: string
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function readArtifact<T>(path: string): Promise<JsonArtifact<T>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : undefined
    if (code === 'ENOENT') return { exists: false }
    return { exists: true, error: error instanceof Error ? error.message : String(error) }
  }
  try {
    return { exists: true, value: JSON.parse(text) as T }
  } catch (error) {
    return { exists: true, error: error instanceof Error ? error.message : String(error) }
  }
}

function emptyResult(): AgentTestResult {
  return {
    version: '1.0',
    workflowId: '',
    sourceSha256: '',
    outcome: 'blocked',
    summary: '缺少可验证的 AgentTest 结果制品',
    startedAt: '',
    finishedAt: '',
    cases: [],
    mutations: [],
    environmentRequirements: [],
    blockers: ['缺少可验证的 AgentTest 结果制品'],
    productDefects: [],
    nextActions: [],
  }
}

function fallbackResult(value: unknown): AgentTestResult {
  const record = recordValue(value)
  const result = emptyResult()
  return {
    ...result,
    ...(typeof record?.workflowId === 'string' ? { workflowId: record.workflowId } : {}),
    ...(typeof record?.sourceSha256 === 'string' ? { sourceSha256: record.sourceSha256 } : {}),
  }
}

function emptyState(result: AgentTestResult): CodexTestAgentState {
  return {
    version: '2.0',
    status: 'failed',
    stage: 'failed',
    workflowId: stringField(result.workflowId) ?? '',
    sourceSha256: stringField(result.sourceSha256) ?? '',
    startedAt: stringField(result.startedAt) ?? '',
    updatedAt: stringField(result.finishedAt) ?? '',
    threadGeneration: 0,
    completedCaseIds: [],
  }
}

function isManifest(value: unknown): value is WorkflowIntakeManifest {
  const record = recordValue(value)
  const source = recordValue(record?.source)
  return typeof record?.workflowId === 'string' &&
    Array.isArray(record?.phases) &&
    record.phases.every((phase) => {
      const item = recordValue(phase)
      return typeof item?.id === 'string' && item.id.trim().length > 0
    }) &&
    typeof source?.sha256 === 'string'
}

function manifestCaseIds(manifest: WorkflowIntakeManifest | undefined): Set<string> {
  if (!manifest || !Array.isArray(manifest.phases)) return new Set()
  return new Set(manifest.phases
    .map((phase) => phase && typeof phase.id === 'string' ? phase.id : undefined)
    .filter((id): id is string => Boolean(id)))
}

function manifestSha256(manifest: WorkflowIntakeManifest | undefined): string | undefined {
  if (!manifest) return undefined
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize)
    const record = recordValue(value)
    if (!record) return value
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]))
  }
  return createHash('sha256').update(JSON.stringify(canonicalize(manifest))).digest('hex')
}

function environmentSelectionSha256(selection: EnvironmentSelectionArtifact | undefined): string | undefined {
  const policy = recordValue(selection?.policy)
  if (
    !selection ||
    !stringField(selection.profileId) ||
    !Array.isArray(selection.origins) || selection.origins.some((origin) => !stringField(origin)) ||
    !Array.isArray(selection.authenticatedOrigins) || selection.authenticatedOrigins.some((origin) => !stringField(origin)) ||
    !isSha256(selection.testDataSha256) ||
    typeof policy?.allowWrite !== 'boolean' ||
    typeof policy?.allowDestructive !== 'boolean' ||
    (policy.maxRefinements !== undefined && typeof policy.maxRefinements !== 'number') ||
    (policy.maxEnvironmentRetries !== undefined && typeof policy.maxEnvironmentRetries !== 'number') ||
    (selection.testDataAccess !== undefined && selection.testDataAccess !== 'direct' && selection.testDataAccess !== 'opaque')
  ) return undefined
  return createHash('sha256').update(JSON.stringify({
    profileId: selection.profileId,
    origins: [...selection.origins as string[]].sort(),
    policy: {
      allowWrite: policy.allowWrite,
      allowDestructive: policy.allowDestructive,
      maxRefinements: policy.maxRefinements ?? null,
      maxEnvironmentRetries: policy.maxEnvironmentRetries ?? null,
    },
    authenticatedOrigins: [...selection.authenticatedOrigins as string[]].sort(),
    testDataSha256: selection.testDataSha256,
    testDataAccess: selection.testDataAccess ?? 'direct',
  })).digest('hex')
}

function durationMs(result: AgentTestResult): number | undefined {
  const start = Date.parse(result.startedAt)
  const end = Date.parse(result.finishedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  return end - start
}

function caseCounts(cases: AgentTestCaseResult[]): AgentCompetitionCandidateSummary['caseCounts'] {
  return {
    passed: cases.filter((item) => item.outcome === 'passed').length,
    product_failed: cases.filter((item) => item.outcome === 'product_failed').length,
    blocked: cases.filter((item) => item.outcome === 'blocked').length,
  }
}

function countValues<T extends string>(values: Array<T | undefined>): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {}
  for (const value of values) if (value) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

interface AggregateTokenUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

/**
 * Sum token usage from every completed agent turn in the run's event log.
 * Returns undefined when the log is absent or contains no completed turns, so
 * callers can fall back to the state's last-epoch snapshot.
 */
export async function readAggregateTokenUsage(runDirectory: string): Promise<AggregateTokenUsage | undefined> {
  let text: string
  try {
    text = await readFile(resolve(runDirectory, 'codex-agent.events.jsonl'), 'utf8')
  } catch {
    return undefined
  }
  const usage: AggregateTokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
  let sawUsage = false
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const record = recordValue(event)
    if (!record) continue
    // The event log stores the host's raw turn events. Codex emits
    // `turn.completed` with top-level usage; OMP emits per-turn usage nested
    // under `message.usage` on its `turn_end` frames. Normalize both through
    // the shared usageFrom mapper so the reader is not coupled to one host.
    let turnUsage: ReturnType<typeof usageFrom>
    if (record.type === 'turn.completed' || record.type === 'turn_completed') {
      turnUsage = usageFrom(record.usage)
    } else if (record.type === 'turn_end') {
      turnUsage = usageFrom(recordValue(record.message)?.usage)
    } else {
      continue
    }
    if (!turnUsage) continue
    sawUsage = true
    usage.inputTokens += turnUsage.inputTokens
    usage.cachedInputTokens += turnUsage.cachedInputTokens
    usage.outputTokens += turnUsage.outputTokens
  }
  return sawUsage ? usage : undefined
}

function oracleScore(result: AgentTestResult, oracle: AgentCompetitionOracle | undefined): number | undefined {
  if (!oracle) return undefined
  if (!Array.isArray(oracle.cases)) return 0
  const expected = new Map(oracle.cases
    .map((item) => {
      const value = recordValue(item)
      return typeof value?.caseId === 'string' ? [value.caseId, value] as const : undefined
    })
    .filter((item): item is readonly [string, Record<string, unknown>] => Boolean(item)))
  const cases = Array.isArray(result.cases) ? result.cases : []
  return cases.reduce((score, item) => {
    const target = expected.get(item.caseId)
    if (!target || target.outcome !== item.outcome) return score
    if (target.failureSource !== undefined && target.failureSource !== item.failureSource) return score
    if (target.failureKind !== undefined && target.failureKind !== item.failureKind) return score
    return score + 1
  }, 0)
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

function inputBundleProblems(bundle: InputBundleArtifact | undefined, hostId: string, exists: boolean): string[] {
  if (!exists) return [`${hostId} 缺少 immutable input-bundle.json`]
  if (!bundle || !recordValue(bundle)) return [`${hostId} 的 immutable input-bundle.json 结构无效`]
  const problems: string[] = []
  if (!isSha256(bundle.briefSha256)) problems.push(`${hostId} 的 input bundle briefSha256 无效`)
  if (!Array.isArray(bundle.imageSha256s) || bundle.imageSha256s.some((value) => !isSha256(value))) {
    problems.push(`${hostId} 的 input bundle imageSha256s 无效`)
  }
  if (!isSha256(bundle.bundleSha256)) problems.push(`${hostId} 的 input bundle bundleSha256 无效`)
  if (problems.length > 0) return problems
  const imageSha256s = [...(bundle.imageSha256s as string[])].sort()
  const expected = createHash('sha256')
    .update(JSON.stringify({ briefSha256: bundle.briefSha256, imageSha256s }))
    .digest('hex')
  if (expected !== bundle.bundleSha256) problems.push(`${hostId} 的 input bundle bundleSha256 与 brief/images 不一致`)
  return problems
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates]
}

function outcomeForCases(cases: AgentTestCaseResult[]): AgentTestOutcome {
  return cases.some((item) => item.outcome === 'blocked')
    ? 'blocked'
    : cases.some((item) => item.outcome === 'product_failed') ? 'product_failed' : 'passed'
}

async function evidencePathEscapesBase(baseDirectory: string, evidencePath: string, allowAbsolute: boolean): Promise<boolean> {
  if (!allowAbsolute && isAbsolute(evidencePath)) return true
  const lexicalPath = resolve(baseDirectory, evidencePath)
  const lexicalRelative = relative(baseDirectory, lexicalPath)
  if (lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) return true
  try {
    const [realBase, realEvidence] = await Promise.all([realpath(baseDirectory), realpath(lexicalPath)])
    const realRelative = relative(realBase, realEvidence)
    return realRelative.startsWith('..') || isAbsolute(realRelative)
  } catch {
    return true
  }
}

async function evidencePathEscapesRun(runDirectory: string, evidencePath: string): Promise<boolean> {
  return evidencePathEscapesBase(runDirectory, evidencePath, true)
}

async function evidencePathEscapesWorkspace(runDirectory: string, evidencePath: string): Promise<boolean> {
  return evidencePathEscapesBase(resolve(runDirectory, 'agent-workspace'), evidencePath, false)
}

async function validateCandidateArtifacts(candidate: LoadedCandidate, expectedCaseIds: Set<string>): Promise<string[]> {
  const problems: string[] = []
  const { summary, result, state, ledger, receipts, selection } = candidate
  const cases = Array.isArray(result.cases) ? result.cases : []
  const mutations = Array.isArray(result.mutations) ? result.mutations : []
  const ledgerEntries = Array.isArray(ledger) ? ledger : []
  const receiptEntries = Array.isArray(receipts) ? receipts : []
  if (!Array.isArray(result.cases)) problems.push(`${summary.hostId} 的结果缺少 cases 数组`)
  if (!Array.isArray(result.mutations)) problems.push(`${summary.hostId} 的结果缺少 mutations 数组`)
  if (!Array.isArray(ledger)) problems.push(`${summary.hostId} 的 Mutation Ledger 不是数组`)
  if (!Array.isArray(receipts)) problems.push(`${summary.hostId} 的执行回执不是数组`)
  const selectionId = stringField(selection.id)
  if (!selectionId) problems.push(`${summary.hostId} 的宿主选择记录缺少 id`)
  if (selectionId !== summary.hostId) problems.push(`${summary.hostId} 的宿主选择 id 无效或与结果不一致`)
  if (!stringField(selection.platform)) problems.push(`${summary.hostId} 的宿主选择记录缺少 platform`)
  if (!stringField(selection.arch)) problems.push(`${summary.hostId} 的宿主选择记录缺少 arch`)
  if (!stringField(selection.packageVersion)) problems.push(`${summary.hostId} 的宿主选择记录缺少 Auto-Test packageVersion`)
  if (!stringField(selection.commit)) problems.push(`${summary.hostId} 的宿主选择记录缺少 Auto-Test commit`)
  const capabilities = recordValue(selection.capabilities)
  if (!capabilities || (capabilities.workspaceIsolation !== 'enforced' && capabilities.workspaceIsolation !== 'prompt_only')) {
    problems.push(`${summary.hostId} 的宿主选择记录缺少有效 workspaceIsolation 能力`)
  }
  if (state.workflowId !== result.workflowId || state.sourceSha256 !== result.sourceSha256) {
    problems.push(`${summary.hostId} 的状态身份与结果身份不一致`)
  }
  if (!state.agentHost) problems.push(`${summary.hostId} 的状态文件缺少 AgentHost 身份`)
  else if (state.agentHost !== summary.hostId) problems.push(`${summary.hostId} 的状态宿主与选择记录不一致`)
  if (state.status !== 'completed' || state.stage !== 'completed' || state.outcome !== result.outcome) {
    problems.push(`${summary.hostId} 的状态文件没有与结果一致的 completed 终态`)
  }
  const resultWorkbookPath = stringField(state.resultWorkbookPath)
  if (!resultWorkbookPath) {
    problems.push(`${summary.hostId} 缺少逐来源行回写的结果工作簿路径`)
  } else {
    const workbookPath = resolve(summary.runDirectory, resultWorkbookPath)
    const workbookIsFile = await stat(workbookPath).then((value) => value.isFile(), () => false)
    if (await evidencePathEscapesRun(summary.runDirectory, resultWorkbookPath) || !workbookIsFile) {
      problems.push(`${summary.hostId} 的结果工作簿不存在或越界`)
    }
  }
  if (summary.pendingMutationCount > 0) problems.push(`${summary.hostId} 存在 pending Mutation Ledger`)

  const caseIds = cases.map((item) => item.caseId)
  for (const duplicate of duplicateValues(caseIds)) problems.push(`${summary.hostId} 存在重复 case 结果 ${duplicate}`)
  const actualCaseIds = new Set(caseIds)
  for (const caseId of expectedCaseIds) if (!actualCaseIds.has(caseId)) problems.push(`${summary.hostId} 缺少 case ${caseId}`)
  for (const caseId of actualCaseIds) if (!expectedCaseIds.has(caseId)) problems.push(`${summary.hostId} 产生了未在比较合同中的 case ${caseId}`)
  if (result.outcome !== outcomeForCases(cases)) problems.push(`${summary.hostId} 的 top-level outcome 与逐 case outcome 不一致`)

  const receiptById = new Map<string, CodexTestExecutionReceipt>()
  for (const receipt of receiptEntries) {
    if (!receipt.id || receiptById.has(receipt.id)) {
      problems.push(`${summary.hostId} 的执行回执 id 缺失或重复`)
      continue
    }
    receiptById.set(receipt.id, receipt)
    if (receipt.status !== 'completed') problems.push(`${summary.hostId} 存在非 completed 执行回执 ${receipt.id}`)
    if (receipt.caseId && !expectedCaseIds.has(receipt.caseId)) problems.push(`${summary.hostId} 的回执 ${receipt.id} 引用了未知 case ${receipt.caseId}`)
  }
  for (const item of cases) {
    if (!Array.isArray(item.evidence)) {
      problems.push(`${summary.hostId} 的 case ${item.caseId} 证据不是数组`)
      continue
    }
    if (item.evidence.length === 0) problems.push(`${summary.hostId} 的 case ${item.caseId} 没有证据`)
    for (const evidence of item.evidence) {
      if (!evidence || typeof evidence !== 'object' || typeof evidence.description !== 'string' || !evidence.description.trim()) {
        problems.push(`${summary.hostId} 的 case ${item.caseId} 存在空证据说明`)
        continue
      }
      if (!evidence.path) continue
      const path = resolve(summary.runDirectory, 'agent-workspace', evidence.path)
      const evidenceIsFile = await stat(path).then((value) => value.isFile(), () => false)
      if (await evidencePathEscapesWorkspace(summary.runDirectory, evidence.path) || !evidenceIsFile) {
        problems.push(`${summary.hostId} 的 case ${item.caseId} 引用了不存在或越界证据 ${evidence.path}`)
      }
    }
    const cited = Array.isArray(item.executionReceiptIds) ? item.executionReceiptIds : []
    if (item.executionReceiptIds !== undefined && !Array.isArray(item.executionReceiptIds)) problems.push(`${summary.hostId} 的 case ${item.caseId} 执行回执引用不是数组`)
    for (const duplicate of duplicateValues(cited)) problems.push(`${summary.hostId} 的 case ${item.caseId} 重复引用回执 ${duplicate}`)
    for (const receiptId of cited) {
      const receipt = receiptById.get(receiptId)
      if (!receipt) {
        problems.push(`${summary.hostId} 的 case ${item.caseId} 引用了未知执行回执 ${receiptId}`)
      } else if (receipt.caseId && receipt.caseId !== item.caseId) {
        problems.push(`${summary.hostId} 的 case ${item.caseId} 引用了另一 case 的执行回执 ${receiptId}`)
      }
    }
    if (item.outcome === 'passed' && (item.failureSource || item.failureKind)) problems.push(`${summary.hostId} 的 passed case ${item.caseId} 带有失败分类`)
    if (item.outcome !== 'passed' && (!item.failureSource || !item.failureKind)) problems.push(`${summary.hostId} 的非 passed case ${item.caseId} 缺少失败分类`)
    if (item.outcome === 'product_failed' && item.failureSource !== 'product') problems.push(`${summary.hostId} 的 product_failed case ${item.caseId} 不是 product 来源`)
    if (item.outcome === 'blocked' && item.failureSource === 'product') problems.push(`${summary.hostId} 的 blocked case ${item.caseId} 不能是 product 来源`)
  }

  const ledgerById = new Map<string, CodexTestMutationLedgerEntry>()
  for (const entry of ledgerEntries) {
    if (!entry.id || ledgerById.has(entry.id)) {
      problems.push(`${summary.hostId} 的 Mutation Ledger id 缺失或重复`)
      continue
    }
    ledgerById.set(entry.id, entry)
  }
  const resultMutationIds = mutations.map((entry) => entry.id)
  for (const duplicate of duplicateValues(resultMutationIds)) problems.push(`${summary.hostId} 的结果重复 Mutation ${duplicate}`)
  if (new Set(resultMutationIds).size !== ledgerById.size || resultMutationIds.some((id) => !ledgerById.has(id)) || [...ledgerById.keys()].some((id) => !resultMutationIds.includes(id))) {
    problems.push(`${summary.hostId} 的结果 Mutation 集与 Ledger 不一致`)
  }
  for (const mutation of mutations) {
    const entry = ledgerById.get(mutation.id)
    if (!entry) continue
    if (entry.caseId !== mutation.caseId || entry.status !== mutation.status || entry.risk !== mutation.risk) {
      problems.push(`${summary.hostId} 的结果 Mutation ${mutation.id} 与 Ledger 事实不一致`)
    }
  }
  return problems
}

function validateOracle(
  oracle: AgentCompetitionOracle,
  workflowId: string,
  sourceSha256: string,
  expectedCaseIds: Set<string>,
): string[] {
  const problems: string[] = []
  if (!recordValue(oracle)) return ['oracle 必须是 JSON 对象']
  if (oracle.version !== '1.0') problems.push('oracle version 不受支持')
  if (oracle.workflowId !== workflowId) problems.push('oracle workflowId 必须绑定同一 immutable workflow')
  if (oracle.sourceSha256 !== sourceSha256) problems.push('oracle sourceSha256 必须绑定同一 immutable input')
  if (!Array.isArray(oracle.cases) || oracle.cases.length === 0) {
    problems.push('oracle 必须包含至少一条 case 期望')
    return problems
  }
  const ids = oracle.cases.map((item) => recordValue(item)?.caseId).filter((id): id is string => typeof id === 'string')
  if (ids.length !== oracle.cases.length) problems.push('oracle 包含无效 case 条目')
  for (const duplicate of duplicateValues(ids)) problems.push(`oracle 存在重复 case ${duplicate}`)
  const oracleIds = new Set(ids)
  for (const caseId of expectedCaseIds) if (!oracleIds.has(caseId)) problems.push(`oracle 缺少 case ${caseId}`)
  for (const caseId of oracleIds) if (!expectedCaseIds.has(caseId)) problems.push(`oracle 包含未知 case ${caseId}`)
  for (const rawItem of oracle.cases) {
    const item = recordValue(rawItem)
    const caseId = typeof item?.caseId === 'string' ? item.caseId : '<empty>'
    const outcome = item?.outcome
    const failureSource = item?.failureSource
    const failureKind = item?.failureKind
    if (!item || !['passed', 'product_failed', 'blocked'].includes(String(outcome))) problems.push(`oracle case ${caseId} 的 outcome 无效`)
    if (outcome === 'passed' && failureSource) problems.push(`oracle passed case ${caseId} 不能声明 failureSource`)
    if (outcome === 'product_failed' && failureSource && failureSource !== 'product') problems.push(`oracle product_failed case ${caseId} 必须是 product 来源`)
    if (outcome === 'blocked' && failureSource === 'product') problems.push(`oracle blocked case ${caseId} 不能是 product 来源`)
    if (failureKind !== undefined && !['assertion', 'validation', 'authentication', 'environment', 'data', 'execution', 'locator', 'mutation'].includes(String(failureKind))) {
      problems.push(`oracle case ${caseId} 的 failureKind 无效`)
    }
    if (outcome === 'passed' && failureKind) problems.push(`oracle passed case ${caseId} 不能声明 failureKind`)
  }
  return problems
}

async function loadCandidate(runDirectoryInput: string, oracle?: AgentCompetitionOracle): Promise<LoadedCandidate> {
  const runDirectory = resolve(runDirectoryInput)
  const validationProblems: string[] = []
  const candidateLabel = basename(runDirectory)
  const selectionArtifact = await readArtifact<AgentHostSelectionArtifact>(resolve(runDirectory, 'agent-host-selection.json'))
  const selection = recordValue(selectionArtifact.value) as AgentHostSelectionArtifact | undefined ?? {}
  if (!selectionArtifact.exists) validationProblems.push(`${candidateLabel} 缺少 agent-host-selection.json`)
  else if (selectionArtifact.error) validationProblems.push(`${candidateLabel} 的 agent-host-selection.json 无法读取：${selectionArtifact.error}`)
  else if (!recordValue(selectionArtifact.value)) validationProblems.push(`${candidateLabel} 的 agent-host-selection.json 不是 JSON 对象`)

  const stateArtifact = await readArtifact<CodexTestAgentState>(resolve(runDirectory, 'codex-agent.state.json'))
  if (!stateArtifact.exists) validationProblems.push(`${candidateLabel} 缺少 codex-agent.state.json`)
  else if (stateArtifact.error) validationProblems.push(`${candidateLabel} 的 codex-agent.state.json 无法读取：${stateArtifact.error}`)
  else if (!recordValue(stateArtifact.value)) validationProblems.push(`${candidateLabel} 的 codex-agent.state.json 不是 JSON 对象`)

  let result = emptyResult()
  let rawResult: unknown
  let resultArtifactFound = false
  for (const name of ['agent-test.result.json', 'codex-agent.result.json']) {
    const artifact = await readArtifact<AgentTestResult>(resolve(runDirectory, name))
    if (!artifact.exists) continue
    resultArtifactFound = true
    if (artifact.error) {
      validationProblems.push(`${candidateLabel} 的 ${name} 无法读取：${artifact.error}`)
      continue
    }
    rawResult = artifact.value
    break
  }
  if (!resultArtifactFound) validationProblems.push(`${candidateLabel} 缺少 structured AgentTest result artifact`)
  else if (rawResult === undefined) validationProblems.push(`${candidateLabel} 的 structured AgentTest result artifact 无法解析`)

  if (rawResult !== undefined && !recordValue(rawResult)) validationProblems.push(`${candidateLabel} 的 structured AgentTest result 不是 JSON 对象`)
  if (rawResult !== undefined) {
    try {
      result = parseAgentTestResult(JSON.stringify(rawResult))
    } catch (error) {
      validationProblems.push(`${candidateLabel} 的结果未通过统一 AgentTest schema：${error instanceof Error ? error.message : String(error)}`)
      const malformed = recordValue(rawResult)
      if (malformed && !Array.isArray(malformed.cases)) validationProblems.push(`${candidateLabel} 的结果缺少 cases 数组`)
      if (malformed && !Array.isArray(malformed.mutations)) validationProblems.push(`${candidateLabel} 的结果缺少 mutations 数组`)
      result = fallbackResult(rawResult)
    }
  }
  const state = recordValue(stateArtifact.value)
    ? stateArtifact.value as CodexTestAgentState
    : emptyState(result)

  const ledgerArtifact = await readArtifact<CodexTestMutationLedgerEntry[]>(resolve(runDirectory, '.agent-private', 'mutation-ledger.json'))
  const ledger = Array.isArray(ledgerArtifact.value) && ledgerArtifact.value.every((entry) => Boolean(recordValue(entry)))
    ? ledgerArtifact.value
    : []
  if (!ledgerArtifact.exists) validationProblems.push(`${candidateLabel} 缺少 .agent-private/mutation-ledger.json`)
  else if (ledgerArtifact.error) validationProblems.push(`${candidateLabel} 的 Mutation Ledger 无法读取：${ledgerArtifact.error}`)
  else if (!Array.isArray(ledgerArtifact.value)) validationProblems.push(`${candidateLabel} 的 Mutation Ledger 不是数组`)
  else if (ledgerArtifact.value.some((entry) => !recordValue(entry))) validationProblems.push(`${candidateLabel} 的 Mutation Ledger 包含无效条目`)

  const receiptsArtifact = await readArtifact<CodexTestExecutionReceipt[]>(resolve(runDirectory, 'agent-workspace', 'execution-receipts.json'))
  let receipts: CodexTestExecutionReceipt[] = []
  if (Array.isArray(receiptsArtifact.value) && receiptsArtifact.value.every((receipt) => Boolean(recordValue(receipt)))) {
    receipts = receiptsArtifact.value
  }
  if (receiptsArtifact.error) validationProblems.push(`${candidateLabel} 的执行回执无法读取：${receiptsArtifact.error}`)
  else if (receiptsArtifact.value !== undefined && !Array.isArray(receiptsArtifact.value)) validationProblems.push(`${candidateLabel} 的执行回执不是数组`)
  else if (Array.isArray(receiptsArtifact.value) && receiptsArtifact.value.some((receipt) => !recordValue(receipt))) validationProblems.push(`${candidateLabel} 的执行回执包含无效条目`)

  const manifestArtifact = await readArtifact<WorkflowIntakeManifest>(resolve(runDirectory, 'agent-workspace', 'test-manifest.json'))
  const manifest = isManifest(manifestArtifact.value) ? manifestArtifact.value : undefined
  if (!manifestArtifact.exists) validationProblems.push(`${candidateLabel} 缺少 immutable test-manifest.json`)
  else if (manifestArtifact.error) validationProblems.push(`${candidateLabel} 的 immutable test-manifest.json 无法读取：${manifestArtifact.error}`)
  else if (!manifest) validationProblems.push(`${candidateLabel} 的 immutable test-manifest.json 结构无效`)

  const inputBundleArtifact = await readArtifact<InputBundleArtifact>(resolve(runDirectory, 'input-bundle.json'))
  const inputBundle = recordValue(inputBundleArtifact.value) as InputBundleArtifact | undefined
  if (inputBundleArtifact.error) validationProblems.push(`${candidateLabel} 的 input-bundle.json 无法读取：${inputBundleArtifact.error}`)
  const environmentArtifact = await readArtifact<EnvironmentSelectionArtifact>(resolve(runDirectory, 'environment-selection.json'))
  const environmentSelection = recordValue(environmentArtifact.value) as EnvironmentSelectionArtifact | undefined
  const environmentHash = environmentSelectionSha256(environmentSelection)
  if (!environmentArtifact.exists) validationProblems.push(`${candidateLabel} 缺少 immutable environment-selection.json`)
  else if (environmentArtifact.error) validationProblems.push(`${candidateLabel} 的 environment-selection.json 无法读取：${environmentArtifact.error}`)
  else if (!environmentHash) validationProblems.push(`${candidateLabel} 的 environment-selection.json 结构无效`)
  const cases = Array.isArray(result.cases) ? result.cases : []
  const ledgerEntries = Array.isArray(ledger) ? ledger : []
  const counts = caseCounts(cases)
  const pendingMutationCount = ledgerEntries.filter((item) => item.status === 'pending').length
  const citedReceiptCount = cases.reduce((sum, item) => sum + (item.executionReceiptIds?.length ?? 0), 0)
  const resultDurationMs = durationMs(result)
  const matchedCases = oracleScore(result, oracle)
  const hostId = stringField(selection.id) ?? `<invalid:${candidateLabel}>`
  const aggregateTokenUsage = await readAggregateTokenUsage(runDirectory)
  const tokenUsage = aggregateTokenUsage ?? state.lastUsage
  const inputTokens = tokenUsage ? numberField(tokenUsage.inputTokens) : undefined
  const cachedInputTokens = tokenUsage ? numberField(tokenUsage.cachedInputTokens) : undefined
  const outputTokens = tokenUsage ? numberField(tokenUsage.outputTokens) : undefined
  const threadGeneration = numberField(state.threadGeneration)
  const epochCount = numberField(state.epochCount)
  const recoveryCount = threadGeneration !== undefined && threadGeneration >= 1 ? threadGeneration - 1 : undefined
  const interruptionCode = state.runInterruption?.code
  const summary: AgentCompetitionCandidateSummary = {
    runDirectory,
    hostId,
    ...(stringField(selection.displayName) ? { displayName: stringField(selection.displayName)! } : {}),
    ...(stringField(selection.executable) ? { executable: stringField(selection.executable)! } : {}),
    platform: stringField(selection.platform) ?? process.platform,
    arch: stringField(selection.arch) ?? process.arch,
    ...(stringField(selection.packageVersion) ? { packageVersion: stringField(selection.packageVersion)! } : {}),
    ...(stringField(selection.commit) ? { commit: stringField(selection.commit)! } : {}),
    ...(manifestSha256(manifest) ? { manifestSha256: manifestSha256(manifest)! } : {}),
    ...(environmentHash ? { environmentSha256: environmentHash } : {}),
    terminal: state.status === 'completed' && state.outcome === result.outcome && pendingMutationCount === 0,
    outcome: result.outcome,
    caseCounts: counts,
    evidenceCount: cases.reduce((sum, item) => sum + (Array.isArray(item.evidence) ? item.evidence.length : 0), 0),
    citedReceiptCount,
    mutationCount: ledgerEntries.length,
    pendingMutationCount,
    ...(isSha256(inputBundle?.bundleSha256) ? { inputBundleSha256: inputBundle.bundleSha256 } : {}),
    ...(resultDurationMs !== undefined ? { durationMs: resultDurationMs } : {}),
    ...(matchedCases !== undefined ? { oracleMatchedCases: matchedCases } : {}),
    ...(matchedCases !== undefined && oracle?.cases.length
      ? { oracleMatchRate: matchedCases / oracle.cases.length }
      : {}),
    failureSources: countValues(cases.map((item) => item.failureSource)),
    failureKinds: countValues(cases.map((item) => item.failureKind)),
    failureModes: failureModeCounts(cases),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(threadGeneration !== undefined ? { threadGeneration } : {}),
    ...(epochCount !== undefined ? { epochCount } : {}),
    ...(recoveryCount !== undefined ? { recoveryCount } : {}),
    ...(interruptionCode ? { interruptionCode } : {}),
  }
  validationProblems.push(...inputBundleProblems(inputBundle, hostId, inputBundleArtifact.exists))
  const candidate: LoadedCandidate = {
    summary,
    result,
    state,
    ledger,
    receipts,
    selection,
    ...(manifest ? { manifest } : {}),
    ...(inputBundle ? { inputBundle } : {}),
    ...(environmentSelection ? { environmentSelection } : {}),
  }
  if (validationProblems.length > 0) candidate.validationProblems = validationProblems
  return candidate
}

async function contractProblems(candidates: LoadedCandidate[], manifest: WorkflowIntakeManifest | undefined, oracle: AgentCompetitionOracle | undefined): Promise<string[]> {
  const problems: string[] = []
  if (candidates.length < 2) problems.push('至少需要两个 AgentHost run 才能比较')
  const runDirectories = candidates.map((candidate) => candidate.summary.runDirectory)
  for (const duplicate of duplicateValues(runDirectories)) problems.push(`重复比较同一个 run：${duplicate}`)
  const hostIds = candidates.map((candidate) => candidate.summary.hostId)
  for (const duplicate of duplicateValues(hostIds)) problems.push(`重复比较同一个 AgentHost：${duplicate}`)
  const workflowId = stringField(candidates[0]?.result.workflowId) ?? ''
  const sourceSha256 = stringField(candidates[0]?.result.sourceSha256) ?? ''
  if (!workflowId) problems.push('比较合同缺少 workflowId')
  if (!isSha256(sourceSha256)) problems.push('比较合同缺少有效 sourceSha256')
  const embeddedManifests = candidates.map((candidate) => candidate.manifest)
  const suppliedManifest = manifest === undefined || isManifest(manifest) ? manifest : undefined
  if (manifest !== undefined && suppliedManifest === undefined) problems.push('比较调用方提供的 immutable test-manifest.json 结构无效')
  if (embeddedManifests.some((item) => item === undefined)) problems.push('至少一个 AgentHost run 缺少 immutable test-manifest.json')
  const contractManifest = suppliedManifest ?? embeddedManifests[0]
  const expectedCaseIds = manifestCaseIds(contractManifest)
  if (expectedCaseIds.size === 0) problems.push('比较合同没有 case')
  if (contractManifest && contractManifest.phases.length !== expectedCaseIds.size) problems.push('Manifest 存在重复 case ID')
  if (contractManifest && contractManifest.workflowId !== workflowId) problems.push('Manifest workflowId 与候选结果不一致')
  if (contractManifest && contractManifest.source.sha256 !== sourceSha256) problems.push('Manifest sourceSha256 与候选结果不一致')
  const inputBundleSha256 = candidates[0]?.summary.inputBundleSha256
  if (!inputBundleSha256) problems.push('比较合同缺少 immutable input bundle')
  const manifestSha256Value = candidates[0]?.summary.manifestSha256
  if (!manifestSha256Value) problems.push('比较合同缺少 immutable Manifest hash')
  const environmentSha256Value = candidates[0]?.summary.environmentSha256
  if (!environmentSha256Value) problems.push('比较合同缺少 immutable environment selection')
  for (const candidate of candidates) {
    if (candidate.result.workflowId !== workflowId) problems.push(`${candidate.summary.hostId} 的 workflowId 与其他候选不一致`)
    if (candidate.result.sourceSha256 !== sourceSha256) problems.push(`${candidate.summary.hostId} 的 sourceSha256 与其他候选不一致`)
    if (candidate.state.agentHost && candidate.state.agentHost !== candidate.summary.hostId) problems.push(`${candidate.summary.hostId} 的状态宿主与选择记录不一致`)
    if (!candidate.summary.terminal) problems.push(`${candidate.summary.hostId} 没有终态或仍有 pending Mutation Ledger`)
    if (candidate.summary.platform !== candidates[0]?.summary.platform) problems.push(`${candidate.summary.hostId} 与其他候选的平台不一致`)
    if (candidate.summary.arch !== candidates[0]?.summary.arch) problems.push(`${candidate.summary.hostId} 与其他候选的架构不一致`)
    if ((candidate.summary.packageVersion ?? undefined) !== (candidates[0]?.summary.packageVersion ?? undefined)) problems.push(`${candidate.summary.hostId} 与其他候选的 Auto-Test 包版本不一致`)
    if ((candidate.summary.commit ?? undefined) !== (candidates[0]?.summary.commit ?? undefined)) problems.push(`${candidate.summary.hostId} 与其他候选的 Auto-Test commit 不一致`)
    if (candidate.summary.inputBundleSha256 !== inputBundleSha256) problems.push(`${candidate.summary.hostId} 与其他候选的 immutable input bundle 不一致`)
    if (candidate.summary.manifestSha256 !== manifestSha256Value) problems.push(`${candidate.summary.hostId} 与其他候选的 immutable Manifest 不一致`)
    if (candidate.summary.environmentSha256 !== environmentSha256Value) problems.push(`${candidate.summary.hostId} 与其他候选的 environment Profile/权限合同不一致`)
    if (candidate.manifest && contractManifest) {
      if (candidate.manifest.workflowId !== contractManifest.workflowId || candidate.manifest.source.sha256 !== contractManifest.source.sha256) {
        problems.push(`${candidate.summary.hostId} 的 immutable Manifest 身份与其他候选不一致`)
      }
      const candidateCaseIds = new Set(candidate.manifest.phases.map((phase) => phase.id))
      if (candidateCaseIds.size !== expectedCaseIds.size || [...candidateCaseIds].some((id) => !expectedCaseIds.has(id))) {
        problems.push(`${candidate.summary.hostId} 的 immutable Manifest case 覆盖与其他候选不一致`)
      }
    }
    problems.push(...(candidate.validationProblems ?? []), ...await validateCandidateArtifacts(candidate, expectedCaseIds))
  }
  if (oracle && !recordValue(oracle)) problems.push('oracle 必须是 JSON 对象')
  else if (oracle && workflowId && isSha256(sourceSha256)) problems.push(...validateOracle(oracle, workflowId, sourceSha256, expectedCaseIds))
  return [...new Set(problems)]
}

function differences(candidates: LoadedCandidate[]): AgentCompetitionCaseDifference[] {
  const ids = [...new Set(candidates.flatMap((candidate) => (Array.isArray(candidate.result.cases) ? candidate.result.cases : []).map((item) => item.caseId)))].sort()
  return ids.map((caseId) => {
    const outcomes = candidates.map((candidate) => {
      const item = (Array.isArray(candidate.result.cases) ? candidate.result.cases : []).find((result) => result.caseId === caseId)
      return {
        hostId: candidate.summary.hostId,
        outcome: item?.outcome ?? 'blocked' as const,
        ...(item?.failureSource ? { failureSource: item.failureSource } : {}),
        ...(item?.failureKind ? { failureKind: item.failureKind } : {}),
        summary: item?.summary ?? 'missing case result',
      }
    })
    return { caseId, outcomes }
  }).filter((difference) => {
    const first = difference.outcomes[0]
    return difference.outcomes.some((item) => item.outcome !== first?.outcome || item.failureSource !== first?.failureSource || item.failureKind !== first?.failureKind)
  })
}

export async function compareAgentRuns(options: {
  runDirectories: string[]
  manifest?: WorkflowIntakeManifest
  oracle?: AgentCompetitionOracle
}): Promise<AgentCompetitionReport> {
  if (options.runDirectories.length < 2) throw new Error('至少提供两个 AgentHost run 才能比较')
  const candidates = await Promise.all(options.runDirectories.map((path) => loadCandidate(path, options.oracle)))
  const problems = await contractProblems(candidates, options.manifest, options.oracle)
  const caseDifferences = differences(candidates)
  let verdict: AgentCompetitionReport['verdict'] = 'undetermined'
  let winnerHostId: string | undefined
  if (problems.length > 0) verdict = 'invalid'
  else if (options.oracle) {
    const scores = candidates.map((candidate) => ({ hostId: candidate.summary.hostId, score: candidate.summary.oracleMatchedCases ?? 0 }))
    const best = Math.max(...scores.map((item) => item.score))
    const winners = scores.filter((item) => item.score === best)
    if (winners.length === 1) {
      verdict = 'oracle_winner'
      winnerHostId = winners[0]!.hostId
    } else {
      verdict = 'undetermined'
    }
  } else {
    verdict = caseDifferences.length === 0 ? 'equivalent' : 'different'
  }
  const first = candidates[0]!
  const baseline = first.summary
  const summaries = candidates.map(({ summary }) => ({
    ...summary,
    ...(summary === baseline ? {} : {
      baselineDelta: {
        ...(summary.durationMs !== undefined && baseline.durationMs !== undefined
          ? { durationMs: summary.durationMs - baseline.durationMs }
          : {}),
        evidenceCount: summary.evidenceCount - baseline.evidenceCount,
        citedReceiptCount: summary.citedReceiptCount - baseline.citedReceiptCount,
        mutationCount: summary.mutationCount - baseline.mutationCount,
        ...(summary.oracleMatchedCases !== undefined && baseline.oracleMatchedCases !== undefined
          ? { oracleMatchedCases: summary.oracleMatchedCases - baseline.oracleMatchedCases }
          : {}),
        ...(summary.inputTokens !== undefined && baseline.inputTokens !== undefined
          ? { inputTokens: summary.inputTokens - baseline.inputTokens }
          : {}),
        ...(summary.cachedInputTokens !== undefined && baseline.cachedInputTokens !== undefined
          ? { cachedInputTokens: summary.cachedInputTokens - baseline.cachedInputTokens }
          : {}),
        ...(summary.outputTokens !== undefined && baseline.outputTokens !== undefined
          ? { outputTokens: summary.outputTokens - baseline.outputTokens }
          : {}),
      },
    }),
  }))
  return {
    version: '1.0',
    kind: 'agent-competition',
    generatedAt: new Date().toISOString(),
    workflowId: stringField(first.result.workflowId) ?? '',
    sourceSha256: stringField(first.result.sourceSha256) ?? '',
    contractStatus: problems.length === 0 ? 'valid' : 'invalid',
    contractProblems: problems,
    candidates: summaries,
    caseDifferences,
    verdict,
    ...(winnerHostId ? { winnerHostId } : {}),
    ...(options.oracle ? { oracle: options.oracle } : {}),
  }
}

export async function writeAgentCompetitionReport(path: string, report: AgentCompetitionReport): Promise<void> {
  await writePrivateJson(path, report)
}

export function competitionFileName(runDirectory: string): string {
  return `${basename(resolve(runDirectory))}-agent-competition.json`
}
