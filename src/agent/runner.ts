import { chromium } from '@playwright/test'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { EnvironmentProfile } from '../workflow/environment-profile.js'
import { resolveModelProfileEnvironment, toAgentModelProviderDescriptor, type ModelProfile } from '../workflow/model-profile.js'
import type { WorkflowIntakeManifest } from '../workflow/types.js'
import { redactAgentTextArtifact, redactAgentTextArtifacts, sanitizeAgentDeliveryEvidencePaths } from './artifact-redaction.js'
import { readAgentBuildInfo } from './build-info.js'
import { createLegacyCodexAgentHost } from './codex-host.js'
import { buildAgentExecutionEpochs, capacityForAgentProfile, manifestForAgentExecutionEpoch, splitAgentExecutionEpoch, type AgentExecutionEpoch } from './execution-epochs.js'
import { caseResultDirectory, readCaseResultRecords, writeCaseResultRecords } from './case-result-store.js'
import type { CodexTestControlConfig } from './control-types.js'
import { reconcileEnvironmentRequirementCaseLinks, reconcileEnvironmentRequirements } from './environment-requirements.js'
import { recoverAgentDeliveryResult, recoverAgentEpochDeliveryResult } from './delivery-recovery.js'
import { ExecutionReceiptRecorder, readExecutionReceipts } from './execution-receipts.js'
import { AgentHostError, agentHostErrorKindForMessage, agentHostErrorMessageForMatching, normalizeAgentEvent, normalizeAgentHostError } from './host.js'
import type { AgentEvent, AgentHost, AgentHostId, AgentHostLaunchOptions, AgentHostRuntime, AgentHostSession, AgentInputPart } from './host.js'
import { createAgentHost } from './host-registry.js'
import { agentTestCheckpointPrompt, agentTestFinalPrompt, agentTestPrompt, agentTestResumePrompt } from './prompt.js'
import { AgentTestProgressReporter, type AgentTestProgressSink } from './progress.js'
import { redactAgentArtifactValue, redactAgentJsonValue, redactAgentValue, secretValues, transientAgentEventValues } from './redact.js'
import { enforceMutationLedger, parseAgentTestCandidate, agentTestStructuredOutputSchema } from './result.js'
import { failureModeFor } from './failure-mode.js'
import { initialAgentTestState as initialCodexTestState, updateAgentTestState as updateCodexTestState, writePrivateJson } from './state.js'
import type {
  CodexTestAgentResult,
  CodexTestAgentState,
  CodexTestCaseResult,
  CodexTestEnvironmentRequirement,
  CodexTestExecutionReceipt,
  CodexTestFailureKind,
  CodexTestMutationLedgerEntry,
  CodexTestRunInterruptionCode,
  CodexTestRunInterruptionStage,
} from './types.js'
import { prepareAgentWorkspace, promoteReplayBrowserState, REPLAY_SESSION_STORAGE_CAPTURE_FILENAME, type AgentWorkspace } from './workspace.js'
import { generateReplayAssets } from './replay-assets.js'
import { compileMcpReplay, readJsonLines } from '../compiler/mcp-replay.js'

export interface AgentTestOptions {
  outputDirectory: string
  manifest: WorkflowIntakeManifest
  profile: EnvironmentProfile
  secrets: Record<string, string | string[]>
  environmentContext: string
  sourceFilePath?: string
  briefFilePath?: string
  imagePaths: string[]
  headed: boolean
  slowMo?: number
  maxIterations?: number
  model?: string
  /** Optional source directory for the selected host's native provider/auth state. */
  agentSourceHome?: string
  maxFinalizationTurns?: number
  resume?: boolean
  onProgress?: AgentTestProgressSink
  progressHeartbeatMs?: number
  testDataAccess?: 'direct' | 'opaque'
  modelProfile?: ModelProfile
  agentHost?: AgentHost
  agentHostId?: AgentHostId
  agentExecutable?: string
  /** Process environment used to resolve the selected AgentHost runtime. */
  environment?: NodeJS.ProcessEnv
}

export interface AgentTestRun {
  state: CodexTestAgentState
  result?: CodexTestAgentResult
}

interface CodexTurnUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

export interface AgentTestDependencies {
  /** Legacy injection seam wrapped by an AgentHost for compatibility. */
  startThread?: Parameters<typeof createLegacyCodexAgentHost>[0]['startThread']
  resumeThread?: Parameters<typeof createLegacyCodexAgentHost>[0]['resumeThread']
  agentHost?: AgentHost
  browserExecutablePath?: string
}

/** Historical Codex-prefixed names remain source-compatible aliases. */
export type CodexTestAgentOptions = AgentTestOptions
export type CodexTestAgentRun = AgentTestRun
export type CodexTestAgentDependencies = AgentTestDependencies

async function appendEvent(
  path: string,
  event: AgentEvent,
  secrets: string[],
  receiptRecorder?: ExecutionReceiptRecorder,
): Promise<void> {
  const source = event.raw ?? event
  const serialized = JSON.stringify(redactAgentArtifactValue(source, [...secrets, ...transientAgentEventValues(source)]))
  await writeFile(path, `${serialized}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 })
  if (process.platform !== 'win32') await chmod(path, 0o600)
  await receiptRecorder?.observe(event)
}

function isNonFatalAgentHostError(message: string): boolean {
  if (/^Reconnecting\.\.\. \d+\/\d+/i.test(message)) {
    // A model entitlement denial is permanent for this Provider binding. Do
    // not spend the remaining native reconnect attempts on the same 403.
    return agentHostErrorKindForMessage(message) !== 'provider_authorization'
  }
  return /^Model metadata for .+ not found\. Defaulting to fallback metadata\b/i.test(message)
}

async function runTurn(
  thread: AgentHostSession,
  hostId: AgentHostId,
  input: AgentInputPart[],
  eventsPath: string,
  secrets: string[],
  progress: AgentTestProgressReporter,
  onThreadStarted?: (threadId: string) => Promise<void>,
  outputSchema?: unknown,
  receiptRecorder?: ExecutionReceiptRecorder,
  onUsage?: (usage: CodexTurnUsage) => Promise<void> | void,
  afterTurn?: () => Promise<void>,
  onEvent?: (event: AgentEvent) => Promise<void> | void,
): Promise<string> {
  try {
    const streamed = await thread.run(input, outputSchema ? { outputSchema } : undefined)
    let finalResponse = ''
    let lastReconnectMessage: string | undefined
    let turnCompleted = false
    for await (const event of streamed.events) {
      await appendEvent(eventsPath, event, secrets, receiptRecorder)
      progress.observe(event)
      if (event.type === 'turn_completed' && event.usage) await onUsage?.(event.usage)
      if (event.type === 'thread_started' && event.threadId) await onThreadStarted?.(event.threadId)
      await onEvent?.(event)
      if (event.type === 'agent_message') finalResponse = event.text ?? ''
      if (event.type === 'turn_failed') throw new Error(event.message ?? 'agent turn failed')
      if (event.type === 'session_incompatible') {
        throw new AgentHostError(hostId, event.message ?? 'AgentHost session is incompatible with the current model binding', 'session_incompatible')
      }
      if (event.type === 'error') {
        const message = event.message ?? 'agent host error'
        if (isNonFatalAgentHostError(message)) {
          if (/^Reconnecting\.\.\. \d+\/\d+/i.test(message)) lastReconnectMessage = message
        } else {
          const kind = event.errorKind ?? agentHostErrorKindForMessage(message)
          if (kind) throw new AgentHostError(hostId, message, kind)
          throw new Error(message)
        }
      }
      if (event.type === 'turn_completed') {
        turnCompleted = true
        break
      }
    }
    if (!turnCompleted) {
      if (lastReconnectMessage) {
        const kind = agentHostErrorKindForMessage(lastReconnectMessage)
        if (kind) throw new AgentHostError(hostId, lastReconnectMessage, kind)
        throw new Error(lastReconnectMessage)
      }
      throw new Error('Agent host returned no final response')
    }
    if (!finalResponse) throw new Error('Agent host returned no final response')
    return finalResponse
  } catch (error) {
    throw normalizeAgentHostError(hostId, error)
  } finally {
    await afterTurn?.()
  }
}

export function finalResultProblems(
  result: CodexTestAgentResult,
  manifest: WorkflowIntakeManifest,
  recordedEnvironmentRequirements: CodexTestEnvironmentRequirement[] = [],
  executionReceipts: CodexTestExecutionReceipt[] = [],
  replayProblems: string[] = [],
): string[] {
  const problems: string[] = []
  if (result.workflowId !== manifest.workflowId) problems.push('workflowId does not match the immutable test contract')
  if (result.sourceSha256 !== manifest.source.sha256) problems.push('sourceSha256 does not match the original test material')
  const requiredCases = new Set(manifest.phases.map((phase) => phase.id))
  const returnedCases = result.cases.map((item) => item.caseId)
  if (new Set(returnedCases).size !== returnedCases.length) problems.push('duplicate case results are not allowed')
  for (const caseId of requiredCases) if (!returnedCases.includes(caseId)) problems.push(`missing final case result for ${caseId}`)
  for (const caseId of returnedCases) if (!requiredCases.has(caseId)) problems.push(`unexpected case result for ${caseId}`)
  for (const item of result.cases) {
    const phase = manifest.phases.find((candidate) => candidate.id === item.caseId)
    if (item.evidence.length === 0) problems.push(`case ${item.caseId} has no execution evidence`)
    if (item.outcome === 'passed' && (item.failureSource || item.failureKind)) problems.push(`passed case ${item.caseId} contains a failure classification`)
    if (item.outcome !== 'passed' && (!item.failureSource || !item.failureKind)) problems.push(`non-passed case ${item.caseId} has no failure classification`)
    if (item.outcome === 'product_failed' && item.failureSource !== 'product') problems.push(`product-failed case ${item.caseId} is not classified as product-sourced`)
    if (item.outcome === 'blocked' && item.failureSource === 'product') problems.push(`blocked case ${item.caseId} is incorrectly classified as product-sourced`)
    const caseReceipts = item.executionReceiptIds?.map((id) => executionReceipts.find((receipt) => receipt.id === id)).filter((receipt): receipt is CodexTestExecutionReceipt => Boolean(receipt)) ?? []
    if (item.executionReceiptIds?.some((id) => !executionReceipts.some((receipt) => receipt.id === id))) {
      problems.push(`case ${item.caseId} references unknown execution receipts`)
    }
    if (caseReceipts.some((receipt) => receipt.caseId !== item.caseId)) {
      problems.push(`case ${item.caseId} references an execution receipt belonging to another case`)
    }
    if (item.outcome !== 'blocked' && phase?.outcome) {
      if (phase.outcome.evidence.includes('observation') && !item.evidence.some((evidence) => evidence.kind === 'observation')) {
        problems.push(`case ${item.caseId} does not satisfy its outcome observation evidence requirement`)
      }
      if (phase.outcome.evidence.includes('interaction') && !caseReceipts.some((receipt) => receipt.kind === 'interaction')) {
        problems.push(`case ${item.caseId} does not satisfy its outcome interaction receipt requirement`)
      }
    }
    if (item.outcome !== 'passed' && phase?.outcome && (phase.outcome.failureModes?.length ?? 0) > 0) {
      const mode = failureModeFor(item.failureSource, item.failureKind)
      if (!phase.outcome.failureModes!.includes(mode)) {
        problems.push(`case ${item.caseId} failure mode ${mode} is not allowed by its outcome contract`)
      }
    }
    // Receipts are passively captured audit evidence. They are validated when
    // the agent cites them, but missing optional case bookkeeping must not
    // prevent the primary AgentHost thread from exploring or delivering facts.
    if (item.failureSource === 'environment') {
      if (!item.environmentRequirementIds?.length) {
        problems.push(`environment-blocked case ${item.caseId} has no recorded environment requirement reference`)
        continue
      }
      for (const requirementId of item.environmentRequirementIds) {
        const requirement = recordedEnvironmentRequirements.find((candidate) => candidate.id === requirementId)
        if (!requirement) {
          problems.push(`environment-blocked case ${item.caseId} references unknown environment requirement ${requirementId}`)
          continue
        }
        if (!requirement.caseIds.includes(item.caseId)) {
          problems.push(`environment-blocked case ${item.caseId} is not linked to environment requirement ${requirementId}`)
        }
        if (requirement.status !== 'pending') {
          problems.push(`environment-blocked case ${item.caseId} references non-pending environment requirement ${requirementId}`)
        }
        if (requirement.evidence.length === 0) {
          problems.push(`environment requirement ${requirementId} has no saved evidence`)
        }
      }
    } else if (item.environmentRequirementIds?.length) {
      problems.push(`non-environment case ${item.caseId} contains environment requirement references`)
    }
  }
  const recordedById = new Map(recordedEnvironmentRequirements.map((item) => [item.id, item]))
  for (const requirement of result.environmentRequirements) {
    const recorded = recordedById.get(requirement.id)
    if (!recorded) {
      problems.push(`final result includes unrecorded environment requirement ${requirement.id}`)
      continue
    }
    if (!sameEnvironmentRequirement(requirement, recorded)) {
      problems.push(`final result environment requirement ${requirement.id} does not match the recorded requirement`)
    }
  }
  for (const requirement of recordedEnvironmentRequirements.filter((item) => item.status === 'pending')) {
    for (const caseId of requirement.caseIds) {
      const caseResult = result.cases.find((item) => item.caseId === caseId)
      if (!caseResult || caseResult.failureSource !== 'environment' || !caseResult.environmentRequirementIds?.includes(requirement.id)) {
        problems.push(`pending environment requirement ${requirement.id} is not represented by environment-blocked case ${caseId}`)
      }
    }
  }
  const expectedOutcome = result.cases.some((item) => item.outcome === 'blocked')
    ? 'blocked'
    : result.cases.some((item) => item.outcome === 'product_failed') ? 'product_failed' : 'passed'
  if (result.outcome !== expectedOutcome) problems.push(`top-level outcome must be ${expectedOutcome}`)
  if (result.outcome === 'passed' && (result.blockers.length > 0 || result.productDefects.length > 0)) problems.push('passed result contains blockers or product defects')
  if (result.outcome === 'blocked' && result.blockers.length === 0) problems.push('blocked result has no blocker')
  if (result.outcome === 'product_failed' && result.productDefects.length === 0) problems.push('product-failed result has no product defect')
  problems.push(...replayProblems)
  return problems
}

async function replayProblemsForResult(eventsPath: string, result: CodexTestAgentResult): Promise<string[]> {
  const passedCaseIds = new Set(result.cases.filter((item) => item.outcome === 'passed').map((item) => item.caseId))
  if (passedCaseIds.size === 0) return []
  const events = await readJsonLines(eventsPath)
  const compiled = compileMcpReplay(events, passedCaseIds)
  const storageCaptured = events.some((value) => {
    const event = normalizeAgentEvent(value)
    return event.type === 'tool_completed' && event.status === 'completed' &&
      event.server === 'playwright' && event.tool === 'browser_storage_state'
  })
  const sessionCaptured = events.some((value) => {
    const event = normalizeAgentEvent(value)
    const arguments_ = event.arguments as { filename?: unknown } | undefined
    return event.type === 'tool_completed' && event.status === 'completed' && event.server === 'playwright' &&
      event.tool === 'browser_evaluate' && arguments_?.filename === REPLAY_SESSION_STORAGE_CAPTURE_FILENAME
  })
  return [
    ...(!storageCaptured ? ['passed cases have no completed browser_storage_state replay setup capture'] : []),
    ...(!sessionCaptured ? ['passed cases have no completed browser_evaluate replay sessionStorage capture'] : []),
    ...compiled.diagnostics
    .filter((item) => item.severity === 'error')
    .map((item) => `case ${item.caseId ?? 'unknown'} replay contract ${item.code}: ${item.message}`),
  ]
}

async function replayVerificationProblems(options: {
  outputDirectory: string
  eventsPath: string
  result: CodexTestAgentResult
  manifest: WorkflowIntakeManifest
  workspace: AgentWorkspace
  profile: EnvironmentProfile
}): Promise<string[]> {
  const verifyAll = !options.profile.policy.allowWrite && !options.profile.policy.allowDestructive
  const assets = await generateReplayAssets({
    outputDirectory: options.outputDirectory,
    eventsPath: options.eventsPath,
    result: options.result,
    manifest: options.manifest,
    storageStatePath: options.workspace.replayStorageStatePath,
    initPagePath: options.workspace.initPagePath,
    secretsPath: options.workspace.playwrightSecretsPath,
    verifyReadOnly: true,
    verifyAll,
  })
  return assets.cases.flatMap((item) => {
    const risk = options.manifest.phases.find((phase) => phase.id === item.caseId)?.risk
    if ((!verifyAll && risk !== 'read') || item.status === 'verified') return []
    return [`case ${item.caseId} independent Playwright replay ${item.status}: ${item.verification?.output.slice(-2_000) ?? item.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`]
  })
}

function redactAgentJsonArtifact<T>(value: T, secrets: string[]): T {
  return redactAgentJsonValue(value, secrets) as T
}

function sameStringSet(left: string[], right: string[]): boolean {
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

function enforceEnvironmentRequirements(
  result: CodexTestAgentResult,
  requirements: CodexTestEnvironmentRequirement[],
): CodexTestAgentResult {
  const environmentRequirements = requirements
  const pending = environmentRequirements.filter((item) => item.status === 'pending')
  if (pending.length === 0) return { ...result, environmentRequirements }
  return {
    ...result,
    outcome: 'blocked',
    summary: `${result.summary} Required environment prerequisites remain unavailable.`,
    environmentRequirements,
    blockers: [...new Set([...result.blockers, ...pending.map((item) => item.condition)])],
    nextActions: [...new Set([
      ...result.nextActions,
      ...pending.map((item) => `Provide the required ${item.kind} prerequisite: ${item.condition}, then resume the same run.`),
    ])],
  }
}

function isOperationalBlock(message: string, error?: unknown): boolean {
  if (error instanceof AgentHostError) return error.retryable || error.kind === 'provider_authorization'
  if (agentHostErrorKindForMessage(message) === 'provider_authorization') return true
  const normalized = agentHostErrorMessageForMatching(message)
  return /usage limit|quota|credit|rate limit|tpm rate limit|rpm rate limit|at capacity|capacity|context (?:length|window)|maximum context|too many tokens|token limit|output limit|try a different model|resource exhausted|overloaded|\b429\b|\b5\d\d\b|bad gateway|upstream|reconnect|timed? out|timeout|connection|network|dns|certificate|tls|unauthorized|forbidden|\b401\b|\b403\b|mcp|mutation ledger|chromium executable|spawn .*enoent|no final response|不可用/i.test(normalized)
}

function isTransientProviderRateLimitError(error: unknown): boolean {
  if (!(error instanceof AgentHostError) || error.kind !== 'quota') return false
  const normalized = agentHostErrorMessageForMatching(error.message)
  if (/insufficient quota|credit (?:depleted|exhausted)|quota (?:depleted|exhausted)|usage limit exceeded/i.test(normalized)) return false
  return /allocated quota exceeded|rate limit|too many requests|tpm|rpm|\b429\b/i.test(normalized)
}

function providerRetryDelayMs(error: AgentHostError): number {
  const match = error.message.match(/(?:retry[- ]after|retry in|try again in)\s*:?\s*(\d+)\s*(milliseconds?|ms|seconds?|s)?/i)
  if (match) {
    const amount = Number(match[1])
    const unit = match[2]?.toLowerCase() ?? 's'
    return Math.min(60_000, Math.max(0, amount * (unit.startsWith('ms') ? 1 : 1_000)))
  }
  return 15_000
}

async function waitForProviderRateLimit(error: AgentHostError): Promise<void> {
  const delayMs = providerRetryDelayMs(error)
  if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

function isMutationLedgerViolation(message: string): boolean {
  return /mutation ledger is invalid|mutation ledger is not valid json/i.test(message)
}

function infrastructureBlockDetails(message: string): {
  code: CodexTestRunInterruptionCode
  reason: string
  nextAction: string
} {
  if (/control mcp capability preflight/i.test(message)) {
    return {
      code: 'mcp',
      reason: 'Control MCP 能力预检未观察到唯一且合规的 test_contract 调用。',
      nextAction: '检查本地 MCP 启动、Provider 的标准 function/SSE/工具结果协议和模型工具调用能力后，使用原结果目录继续上次测试。',
    }
  }
  if (/mutation ledger/i.test(message)) {
    return {
      code: 'filesystem',
      reason: '本次 Agent 执行破坏了 Auto-Test 的 Mutation Ledger 交付制品，核心拒绝继续判定业务结果。',
      nextAction: '检查运行目录中的 Mutation Ledger 和 Agent 事件，修复宿主执行后使用原结果目录恢复；不要重复已发生的业务写入。',
    }
  }
  const normalized = agentHostErrorMessageForMatching(message)
  if (agentHostErrorKindForMessage(message) === 'provider_authorization') {
    return {
      code: 'provider_authorization',
      reason: 'Provider 拒绝了当前模型访问：模型未购买、未开通，或当前 Key 无权使用。',
      nextAction: '在当前 Provider 开通该模型，或切换到当前 Key 已授权的模型/Profile 后，使用原结果目录继续上次测试。',
    }
  }
  if (/context (?:length|window)|maximum context|too many tokens|token limit|output limit/i.test(normalized)) {
    return {
      code: 'provider_capacity',
      reason: '当前执行 epoch 超出模型上下文或单次输出容量。',
      nextAction: '在模型 Profile 中登记准确的容量参数或切换到容量更大的模型后，使用原结果目录继续上次测试。',
    }
  }
  if (/at capacity|capacity|try a different model|overloaded/i.test(normalized)) {
    return {
      code: 'provider_capacity',
      reason: '当前模型供应商容量不足或所选模型暂时不可用。',
      nextAction: '使用 --model-profile 切换到另一个已注册的模型供应商后，使用原结果目录继续上次测试。',
    }
  }
  if (/usage limit|quota|credit|rate limit|tpm rate limit|rpm rate limit|resource exhausted|\b429\b/i.test(normalized)) {
    return {
      code: 'provider_rate_limited',
      reason: '模型服务额度不足或调用频率受限。',
      nextAction: '恢复或切换可用的模型 API 额度后，使用原结果目录继续上次测试。',
    }
  }
  if (/unauthorized|forbidden|\b401\b|\b403\b/i.test(message)) {
    return {
      code: 'provider_authentication',
      reason: '模型或本地执行依赖的身份验证失败。',
      nextAction: '修复 Provider 或执行依赖的认证配置后，使用原结果目录继续上次测试。',
    }
  }
  if (/bad gateway|upstream|\b5\d\d\b/i.test(message)) {
    return {
      code: 'provider_unavailable',
      reason: '模型服务或上游接口暂时不可用。',
      nextAction: '等待模型服务恢复后，使用原结果目录继续上次测试。',
    }
  }
  if (/chromium executable|spawn .*enoent/i.test(message)) {
    return {
      code: 'browser',
      reason: '浏览器或本地执行程序未正确安装，或无法启动。',
      nextAction: '运行环境检查并修复 Chromium/AgentHost CLI 后，使用原结果目录继续上次测试。',
    }
  }
  if (/agent host|agenthost|omp (?:rpc|process|session|cli)|codex (?:cli|sdk|thread|process)|(?:rpc|process|session|thread).*agenthost|不可用/i.test(message)) {
    return {
      code: 'agent_host',
      reason: '选定的 AgentHost 或其本地可执行程序不可用。',
      nextAction: '安装或修复选定 AgentHost（Codex/OMP）后，使用原结果目录继续上次测试。',
    }
  }
  if (/mcp/i.test(message)) {
    return {
      code: 'mcp',
      reason: '浏览器控制服务（MCP）暂时不可用。',
      nextAction: '恢复 MCP 或重启 Auto-Test 运行依赖后，使用原结果目录继续上次测试。',
    }
  }
  if (/no final response/i.test(message)) {
    return {
      code: 'agent_host',
      reason: 'AgentHost 本轮没有返回完整执行结果。',
      nextAction: '使用原结果目录继续同一 AgentHost 线程，不要重复已验证的业务写入。',
    }
  }
  if (/reconnect|timed? out|timeout|connection|network|dns|certificate|tls/i.test(message)) {
    return {
      code: 'network',
      reason: '模型、浏览器或本地网络连接中断。',
      nextAction: '恢复网络和运行依赖后，使用原结果目录继续上次测试。',
    }
  }
  return {
    code: 'unknown',
    reason: 'Auto-Test 的执行依赖出现异常，测试尚未完成。',
    nextAction: '查看运行诊断并修复执行依赖后，使用原结果目录继续上次测试。',
  }
}

function isContextOrOutputCapacityError(error: unknown): boolean {
  if (!(error instanceof AgentHostError) || error.kind !== 'quota') return false
  return /context (?:length|window)|maximum context|too many tokens|token limit|output limit/i.test(agentHostErrorMessageForMatching(error.message))
}

function interruptionStage(state: CodexTestAgentState): CodexTestRunInterruptionStage {
  if (state.stage === 'preparing') return 'preparation'
  if (state.activeEpoch?.stage === 'finalizing' || state.activeEpoch?.stage === 'checkpointing' || state.stage === 'finalizing') return 'finalization'
  if (state.stage === 'executing') return 'execution'
  if (state.stage === 'completed') return 'delivery'
  return 'unknown'
}

function environmentRecoveryActions(conditions: string[]): string[] {
  return conditions.map((condition) => `补充环境前置条件：${condition}，然后使用原结果目录继续上次测试。`)
}

function blockedCaseResults(
  manifest: WorkflowIntakeManifest,
  fallback: {
    summary: string
    failureSource: 'infrastructure' | 'agent_execution'
    failureKind: 'execution'
    evidenceDescription: string
  },
  environmentRequirements: CodexTestEnvironmentRequirement[],
  recordedCases: CodexTestCaseResult[],
): {
  cases: CodexTestCaseResult[]
  environmentBlockers: string[]
  blockers: string[]
  productDefects: string[]
} {
  const recordedById = new Map(recordedCases.map((item) => [item.caseId, item]))
  const pendingRequirements = environmentRequirements.filter((item) => item.status === 'pending' && item.evidence.length > 0)
  const requirementsByCase = new Map<string, CodexTestEnvironmentRequirement[]>()
  for (const requirement of pendingRequirements) {
    for (const caseId of requirement.caseIds) {
      const current = requirementsByCase.get(caseId) ?? []
      current.push(requirement)
      requirementsByCase.set(caseId, current)
    }
  }
  const environmentFailureKind = (kind: CodexTestEnvironmentRequirement['kind']): CodexTestFailureKind => {
    if (kind === 'authentication') return 'authentication'
    if (kind === 'test_data') return 'data'
    return 'environment'
  }
  const cases = manifest.phases.map((phase) => {
    const recorded = recordedById.get(phase.id)
    if (recorded) {
      if (recorded.failureSource !== 'environment') return recorded
      const recordedRequirementIds = new Set(recorded.environmentRequirementIds ?? [])
      const stillPending = pendingRequirements.some((item) => (
        item.caseIds.includes(phase.id) && recordedRequirementIds.has(item.id)
      ))
      if (stillPending) return recorded
    }
    const requirements = requirementsByCase.get(phase.id) ?? []
    if (requirements.length > 0) {
      const primary = requirements[0]!
      return {
        caseId: phase.id,
        title: phase.title,
        outcome: 'blocked' as const,
        summary: primary.condition,
        failureSource: 'environment' as const,
        failureKind: environmentFailureKind(primary.kind),
        environmentRequirementIds: requirements.map((item) => item.id),
        evidence: requirements.flatMap((item) => item.evidence.map((path) => ({
          kind: 'observation' as const,
          path,
          description: `已记录环境前置条件：${item.condition}`,
        }))),
      }
    }
    return {
      caseId: phase.id,
      title: phase.title,
      outcome: 'blocked' as const,
      summary: fallback.summary,
      failureSource: fallback.failureSource,
      failureKind: fallback.failureKind,
      evidence: [{ kind: 'observation' as const, description: fallback.evidenceDescription }],
    }
  })
  const representedRequirements = new Set(cases
    .filter((item) => item.failureSource === 'environment')
    .flatMap((item) => item.environmentRequirementIds ?? []))
  return {
    cases,
    environmentBlockers: [...new Set(pendingRequirements
      .filter((item) => representedRequirements.has(item.id))
      .map((item) => item.condition))],
    blockers: [...new Set(cases.filter((item) => item.outcome === 'blocked').map((item) => item.summary))].slice(0, 50),
    productDefects: [...new Set(cases.filter((item) => item.outcome === 'product_failed').map((item) => item.summary))].slice(0, 50),
  }
}

function blockedResult(
  manifest: WorkflowIntakeManifest,
  state: CodexTestAgentState,
  message: string,
  ledger: CodexTestMutationLedgerEntry[],
  environmentRequirements: CodexTestEnvironmentRequirement[] = [],
  recordedCases: CodexTestCaseResult[] = [],
): CodexTestAgentResult {
  const details = infrastructureBlockDetails(message)
  const { cases, environmentBlockers, blockers, productDefects } = blockedCaseResults(manifest, {
    summary: details.reason,
    failureSource: 'infrastructure',
    failureKind: 'execution',
    evidenceDescription: 'Execution dependency failure recorded in codex-agent.events.jsonl.',
  }, environmentRequirements, recordedCases)
  const result: CodexTestAgentResult = {
    version: '1.0',
    workflowId: manifest.workflowId,
    sourceSha256: manifest.source.sha256,
    outcome: 'blocked',
    summary: environmentBlockers.length > 0
      ? '测试未完成：一个或多个用例存在已记录但尚未满足的环境前置条件。'
      : details.reason,
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    cases,
    mutations: [],
    environmentRequirements,
    // Case-scoped environment observations are user-facing causes. The
    // provider interruption remains a separate run event on the state.
    blockers: blockers.length > 0 ? blockers : [details.reason],
    productDefects,
    nextActions: environmentBlockers.length > 0
      ? environmentRecoveryActions(environmentBlockers)
      : [details.nextAction],
  }
  return enforceMutationLedger(result, ledger)
}

function deliveryBlockedResult(
  manifest: WorkflowIntakeManifest,
  state: CodexTestAgentState,
  message: string,
  ledger: CodexTestMutationLedgerEntry[],
  environmentRequirements: CodexTestEnvironmentRequirement[],
  recordedCases: CodexTestCaseResult[] = [],
): CodexTestAgentResult {
  const { cases, environmentBlockers, blockers, productDefects } = blockedCaseResults(manifest, {
    summary: message,
    failureSource: 'agent_execution',
    failureKind: 'execution',
    evidenceDescription: 'Structured delivery validation did not complete.',
  }, environmentRequirements, recordedCases)
  return enforceMutationLedger({
    version: '1.0',
    workflowId: manifest.workflowId,
    sourceSha256: manifest.source.sha256,
    outcome: 'blocked',
    summary: 'The selected AgentHost completed execution but did not produce a complete evidence-based delivery result.',
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    cases,
    mutations: [],
    environmentRequirements,
    blockers: blockers.length > 0 ? blockers : [message],
    productDefects,
    nextActions: environmentBlockers.length > 0
      ? environmentRecoveryActions(environmentBlockers)
      : ['Resume the same AgentHost session and complete the structured evidence-based result without repeating verified writes.'],
  }, ledger)
}

async function readMutationLedger(path: string): Promise<CodexTestMutationLedgerEntry[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`Mutation Ledger is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Mutation Ledger is invalid: expected a JSON array of entries')
  }
  const isIsoTimestamp = (value: unknown): value is string => typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  const invalidIndex = parsed.findIndex((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true
    const value = entry as Record<string, unknown>
    return typeof value.id !== 'string' ||
      typeof value.caseId !== 'string' ||
      typeof value.description !== 'string' ||
      (value.risk !== 'write' && value.risk !== 'destructive') ||
      (value.status !== 'pending' && value.status !== 'compensated' && value.status !== 'accepted') ||
      !isIsoTimestamp(value.createdAt) ||
      !isIsoTimestamp(value.updatedAt) ||
      !Array.isArray(value.evidence) ||
      value.evidence.some((item) => typeof item !== 'string')
  })
  if (invalidIndex >= 0) {
    throw new Error(`Mutation Ledger is invalid: entry ${invalidIndex} does not match the run contract`)
  }
  return parsed as CodexTestMutationLedgerEntry[]
}

/** Tool name the host's agent must invoke to read the immutable test contract. */
export function controlContractToolName(hostId: AgentHostId): string {
  return hostId === 'omp' ? 'mcp__auto_test_control_test_contract' : 'auto-test-control.test_contract'
}

function controlMcpPreflightPrompt(hostId: AgentHostId): string {
  return [
    'This is a read-only Auto-Test capability preflight.',
    `Call ${controlContractToolName(hostId)} exactly once and do not call any other tool.`,
    'After the tool returns, reply with a short confirmation only.',
  ].join(' ')
}

function isCompletedControlContractCall(event: AgentEvent): boolean {
  return event.type === 'tool_completed' &&
    event.status === 'completed' &&
    event.server === 'auto-test-control' &&
    event.tool === 'test_contract'
}

function isToolEvent(event: AgentEvent): boolean {
  return event.type === 'tool_started' || event.type === 'tool_completed'
}

function isPreflightActionEvent(event: AgentEvent): boolean {
  return isToolEvent(event) ||
    event.type === 'command_started' || event.type === 'command_completed' ||
    event.type === 'file_change_started' || event.type === 'file_change_completed'
}

function isControlContractToolEvent(event: AgentEvent): boolean {
  return isToolEvent(event) && event.server === 'auto-test-control' && event.tool === 'test_contract'
}

async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

function environmentRequirementsForCases(
  requirements: CodexTestEnvironmentRequirement[],
  caseIds: string[],
): CodexTestEnvironmentRequirement[] {
  const active = new Set(caseIds)
  return requirements
    .map((requirement) => ({ ...requirement, caseIds: requirement.caseIds.filter((caseId) => active.has(caseId)) }))
    .filter((requirement) => requirement.caseIds.length > 0)
}

function aggregateCaseResults(options: {
  manifest: WorkflowIntakeManifest
  caseResults: CodexTestAgentResult['cases']
  requirements: CodexTestEnvironmentRequirement[]
  startedAt: string
}): CodexTestAgentResult {
  const byCaseId = new Map(options.caseResults.map((item) => [item.caseId, item]))
  const cases = options.manifest.phases.map((phase) => {
    const result = byCaseId.get(phase.id)
    if (!result) throw new Error(`Adaptive execution is missing ${phase.id}`)
    return result
  })
  const outcome = cases.some((item) => item.outcome === 'blocked')
    ? 'blocked'
    : cases.some((item) => item.outcome === 'product_failed') ? 'product_failed' : 'passed'
  const counts = {
    passed: cases.filter((item) => item.outcome === 'passed').length,
    productFailed: cases.filter((item) => item.outcome === 'product_failed').length,
    blocked: cases.filter((item) => item.outcome === 'blocked').length,
  }
  return {
    version: '1.0',
    workflowId: options.manifest.workflowId,
    sourceSha256: options.manifest.source.sha256,
    outcome,
    summary: `AgentHost adaptive execution completed ${cases.length} cases: ${counts.passed} passed, ${counts.productFailed} product-failed, ${counts.blocked} blocked.`,
    startedAt: options.startedAt,
    finishedAt: new Date().toISOString(),
    cases,
    mutations: [],
    environmentRequirements: options.requirements,
    blockers: [...new Set(cases.filter((item) => item.outcome === 'blocked').map((item) => item.summary))].slice(0, 50),
    productDefects: [...new Set(cases.filter((item) => item.outcome === 'product_failed').map((item) => item.summary))].slice(0, 50),
    nextActions: outcome === 'passed'
      ? []
      : ['Review the per-case evidence and resolve blocked or product-failed cases before declaring the suite complete.'],
  }
}

function deliveryArtifactFromResult(result: CodexTestAgentResult) {
  const pending = result.mutations.filter((item) => item.status === 'pending')
  return {
    version: '1.0' as const,
    kind: 'case-results' as const,
    workflowId: result.workflowId,
    sourceSha256: result.sourceSha256,
    generatedAt: result.finishedAt,
    cases: result.cases.map((item) => ({
      caseId: item.caseId,
      title: item.title,
      outcome: item.outcome,
      summary: item.summary,
      evidencePaths: item.evidence.map((evidence) => evidence.path).filter((path): path is string => Boolean(path)),
      ...(item.failureSource ? { failureSource: item.failureSource } : {}),
      ...(item.failureKind ? { failureKind: item.failureKind } : {}),
      ...(item.environmentRequirementIds?.length ? { environmentRequirementIds: item.environmentRequirementIds } : {}),
      ...(item.executionReceiptIds?.length ? { executionReceiptIds: item.executionReceiptIds } : {}),
    })),
    mutationLedger: { state: 'terminal' as const, pendingCount: pending.length, entries: result.mutations },
  }
}

async function activateExecutionEpoch(
  workspace: AgentWorkspace,
  epoch: AgentExecutionEpoch,
): Promise<void> {
  const config = JSON.parse(await readFile(workspace.controlConfigPath, 'utf8')) as CodexTestControlConfig
  await writePrivateJson(workspace.controlConfigPath, { ...config, activeCaseIds: epoch.caseIds })
  await writePrivateJson(resolve(workspace.workspaceDirectory, 'active-execution-epoch.json'), epoch)
}

function epochResultPath(workspace: AgentWorkspace, epoch: AgentExecutionEpoch): string {
  return resolve(workspace.privateDirectory, 'execution-epochs', `${epoch.id}.result.json`)
}

function epochDeliveryPath(workspace: AgentWorkspace, epoch: AgentExecutionEpoch): string {
  return resolve(workspace.workspaceDirectory, `case-results.${epoch.id}.json`)
}

function imagePathsForExecutionEpoch(workspace: AgentWorkspace, manifest: WorkflowIntakeManifest): string[] {
  const relevantIds = new Set([
    ...manifest.embeddedImages.map((image) => image.id),
    ...manifest.supplementalImages.map((image) => image.id),
  ])
  if (relevantIds.size === 0) return []
  return workspace.inputImagePaths.filter((path) => {
    const name = basename(path)
    return [...relevantIds].some((id) => name.includes(id))
  })
}

function hostInput(
  host: AgentHost,
  runtime: AgentHostRuntime,
  text: string,
  imagePaths: string[],
): AgentInputPart[] {
  const providerAcceptsImages = runtime.provider
    ? runtime.provider.inputModalities?.includes('image') === true
    : true
  if (host.capabilities.localImages && providerAcceptsImages) {
    return [
      { type: 'text', text },
      ...imagePaths.map((path) => ({ type: 'local_image' as const, path })),
    ]
  }
  if (imagePaths.length === 0) return [{ type: 'text', text }]
  return [{
    type: 'text',
    text: `${text}\n\nThe selected AgentHost/model binding cannot receive inline image parts. Inspect these staged files from the run workspace when visual evidence is needed:\n${imagePaths.map((path) => `- ${path}`).join('\n')}`,
  }]
}

function sessionBindingFingerprint(host: AgentHost, runtime: AgentHostRuntime): string {
  const binding = runtime.provider
    ? {
        profileId: runtime.provider.profileId,
        providerId: runtime.provider.providerId,
        baseUrl: runtime.provider.baseUrl,
        api: runtime.provider.api,
        model: runtime.provider.model,
        modelSelector: runtime.provider.modelSelector,
      }
    : { model: runtime.model ?? null }
  return createHash('sha256').update(JSON.stringify({ hostId: host.id, binding })).digest('hex')
}

export async function runAgentTest(
  options: AgentTestOptions,
  dependencies: AgentTestDependencies = {},
): Promise<AgentTestRun> {
  const outputDirectory = resolve(options.outputDirectory)
  const statePath = resolve(outputDirectory, 'codex-agent.state.json')
  const resultPath = resolve(outputDirectory, 'codex-agent.result.json')
  const eventsPath = resolve(outputDirectory, 'codex-agent.events.jsonl')
  const existingLedgerPath = resolve(outputDirectory, '.agent-private', 'mutation-ledger.json')
  let state: CodexTestAgentState
  let resumeThreadId: string | undefined
  if (options.resume) {
    state = JSON.parse(await readFile(statePath, 'utf8')) as CodexTestAgentState
    if (state.version !== '2.0') throw new Error('旧版 Codex 测试状态不再支持恢复，请为本次执行创建新的 run')
    if (!Array.isArray(state.completedCaseIds) || !Number.isInteger(state.threadGeneration) || state.threadGeneration < 0) {
      throw new Error('Codex 测试状态缺少自适应 epoch 恢复字段，请为本次执行创建新的 run')
    }
    await access(existingLedgerPath)
    if (state.workflowId !== options.manifest.workflowId || state.sourceSha256 !== options.manifest.source.sha256) {
      throw new Error('Resume input does not match the existing Codex test state')
    }
    if (state.status === 'completed' && state.outcome !== 'blocked') {
      throw new Error(`Completed ${state.outcome ?? 'terminal'} Codex test runs cannot be resumed`)
    }
    resumeThreadId = state.threadId
    const { resultPath: _resultPath, outcome: _outcome, error: _error, runInterruption: _runInterruption, ...unfinishedState } = state
    state = updateCodexTestState(unfinishedState, {
      status: 'running',
      stage: 'preparing',
      ...(resumeThreadId ? { threadId: resumeThreadId } : {}),
    })
  } else {
    for (const path of [statePath, existingLedgerPath]) {
      await access(path).then(
        () => { throw new Error(`Output directory already contains Codex agent state: ${path}. Use a new output directory.`) },
        (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error },
      )
    }
    state = initialCodexTestState(options.manifest.workflowId, options.manifest.source.sha256)
  }
  let mutationLedgerPath: string | undefined
  let environmentRequirementsPath: string | undefined
  let executionReceiptsPath: string | undefined
  let activeThread: AgentHostSession | undefined
  let runInterruption: CodexTestAgentState['runInterruption']
  const injectedHost = options.agentHost ?? dependencies.agentHost
  const requestedHostId = options.agentHostId ?? state.agentHost
  const selectedHostId = injectedHost?.id ?? requestedHostId ?? 'codex'
  const usesLegacyThreadFactory = !injectedHost && selectedHostId === 'codex' &&
    Boolean(dependencies.startThread || dependencies.resumeThread)
  if (injectedHost && requestedHostId && injectedHost.id !== requestedHostId) {
    throw new Error(`AgentHost selection is ambiguous: injected ${injectedHost.id} but requested ${requestedHostId}`)
  }
  let host: AgentHost
  if (injectedHost) {
    host = injectedHost
  } else if (usesLegacyThreadFactory) {
    host = createLegacyCodexAgentHost({
      startThread: dependencies.startThread ?? (() => { throw new Error('Legacy startThread dependency is missing') }),
      resumeThread: dependencies.resumeThread ?? (() => { throw new Error('Legacy resumeThread dependency is missing') }),
    })
  } else {
    host = createAgentHost(selectedHostId)
  }
  if (options.resume && !state.agentHost && host.id !== 'codex') {
    throw new Error(`Resume agent host is unknown in the legacy state; refusing to switch to ${host.id}`)
  }
  if (options.resume && state.agentHost && state.agentHost !== host.id) {
    throw new Error(`Resume agent host does not match the original run: ${state.agentHost} -> ${host.id}`)
  }
  const progress = new AgentTestProgressReporter(options.onProgress, options.progressHeartbeatMs)
  progress.setContext({ hostId: host.id })
  state = updateCodexTestState(state, { agentHost: host.id })
  await writePrivateJson(statePath, state)
  const redactionSecrets = secretValues(options.secrets)
  try {
    progress.report('stage', options.resume
      ? '正在恢复原测试代理线程、浏览器会话和 Mutation Ledger'
      : '正在检查 Chromium 并准备隔离测试工作区')
    progress.startHeartbeat()
    const browserExecutablePath = dependencies.browserExecutablePath ?? chromium.executablePath()
    if (!options.resume) {
      await access(browserExecutablePath).catch(() => {
        throw new Error(`Chromium executable is unavailable: ${browserExecutablePath}. Run Playwright browser installation first.`)
      })
    }
    const runtimeEnvironment = options.environment ?? process.env
    const workspace = await prepareAgentWorkspace({
      outputDirectory,
      manifest: options.manifest,
      profile: options.profile,
      secrets: options.secrets,
      ...(options.sourceFilePath ? { sourceFilePath: options.sourceFilePath } : {}),
      ...(options.briefFilePath ? { briefFilePath: options.briefFilePath } : {}),
      inputImagePaths: options.imagePaths,
      headed: options.headed,
      browserExecutablePath,
      ...(options.slowMo !== undefined ? { slowMo: options.slowMo } : {}),
      environment: runtimeEnvironment,
      testDataAccess: options.testDataAccess ?? 'direct',
      ...(options.resume ? { resume: true } : {}),
    })
    await promoteReplayBrowserState(workspace, options.profile.origins)
    const runtime = await host.modelProvider.prepare({
      workspaceDirectory: workspace.workspaceDirectory,
      privateDirectory: workspace.privateDirectory,
      agentHome: workspace.agentHome,
      ...(options.agentExecutable ? { executable: options.agentExecutable } : {}),
      ...(options.agentSourceHome ? { sourceAgentHome: options.agentSourceHome } : {}),
      playwrightConfigPath: workspace.playwrightConfigPath,
      playwrightSecretsPath: workspace.playwrightSecretsPath,
      controlConfigPath: workspace.controlConfigPath,
      environment: runtimeEnvironment,
      mcpEnvironment: workspace.mcpEnvironment,
      ...(options.model ? { model: options.model } : {}),
      ...(options.modelProfile ? {
        provider: toAgentModelProviderDescriptor(resolveModelProfileEnvironment(options.modelProfile, runtimeEnvironment)),
      } : {}),
      ...(options.resume ? { resume: true } : {}),
    })
    const providerEnvironmentName = runtime.provider?.credentialEnvironmentVariable
    const providerCredential = providerEnvironmentName ? runtime.environment[providerEnvironmentName] : undefined
    if (providerCredential && !redactionSecrets.includes(providerCredential)) redactionSecrets.push(providerCredential)
    mutationLedgerPath = workspace.mutationLedgerPath
    environmentRequirementsPath = workspace.environmentRequirementsPath
    executionReceiptsPath = workspace.executionReceiptsPath
    const checkpointDirectory = resolve(workspace.privateDirectory, 'checkpoints')
    const resultDirectory = caseResultDirectory(outputDirectory)
    const scrubGeneratedArtifacts = async (): Promise<void> => {
      await redactAgentTextArtifact(eventsPath, redactionSecrets)
      const sanitization = await sanitizeAgentDeliveryEvidencePaths(workspace.workspaceDirectory, redactionSecrets)
      if (sanitization.renamedFiles > 0) {
        progress.report('stage', `已同步清理 ${sanitization.renamedFiles} 个证据文件名及其交付引用`)
      }
      await redactAgentTextArtifacts(workspace.workspaceDirectory, redactionSecrets, {
        excludedDirectories: [workspace.inputDirectory],
        excludedFiles: [workspace.manifestPath],
      })
      await redactAgentTextArtifacts(checkpointDirectory, redactionSecrets)
    }
    await scrubGeneratedArtifacts()
    await reconcileEnvironmentRequirements(environmentRequirementsPath, options.profile.origins)
    if (options.resume) {
      const ledger = await readMutationLedger(workspace.mutationLedgerPath)
      if (!ledger.some((entry) => entry.status === 'pending')) {
        const recoveryStrategies = [
          () => recoverAgentEpochDeliveryResult({
            workspaceDirectory: workspace.workspaceDirectory,
            manifest: options.manifest,
            startedAt: state.startedAt,
          }),
          () => recoverAgentDeliveryResult({
            artifactPath: workspace.caseResultsPath,
            manifest: options.manifest,
            startedAt: state.startedAt,
          }),
        ]
        for (const recover of recoveryStrategies) {
          const recovered = await recover()
          if (!recovered.result) continue
          const environmentRequirements = await reconcileEnvironmentRequirementCaseLinks(
            workspace.environmentRequirementsPath,
            recovered.result.cases,
          )
          const executionReceipts = await readExecutionReceipts(workspace.executionReceiptsPath)
          const replayProblems = await replayProblemsForResult(eventsPath, recovered.result)
          const recoveryProblems = finalResultProblems(
            recovered.result,
            options.manifest,
            environmentRequirements,
            executionReceipts,
            replayProblems,
          )
          const replayVerification = recoveryProblems.length === 0
            ? await replayVerificationProblems({ outputDirectory, eventsPath, result: recovered.result, manifest: options.manifest, workspace, profile: options.profile })
            : []
          if (recoveryProblems.length === 0 && replayVerification.length === 0) {
            const result = redactAgentJsonArtifact(enforceMutationLedger(
              enforceEnvironmentRequirements(recovered.result, environmentRequirements),
              ledger,
            ), redactionSecrets)
            await writeCaseResultRecords(resultDirectory, options.manifest, 'recovered-delivery', result.cases)
            await writePrivateJson(workspace.caseResultsPath, deliveryArtifactFromResult(result))
            await writePrivateJson(resultPath, result)
            progress.report('stage', `已有逐 case 交付通过确定性校验，无需再次启动浏览器或 AgentHost：${result.outcome}`)
            const { activeEpoch: _recoveredEpoch, ...completedState } = state
            state = updateCodexTestState(completedState, {
              status: 'completed',
              stage: 'completed',
              outcome: result.outcome,
              resultPath,
              finishedAt: new Date().toISOString(),
              completedCaseIds: options.manifest.phases.map((phase) => phase.id),
            })
            await writePrivateJson(statePath, state)
            return { state, result }
          }
        }
      }
      await access(browserExecutablePath).catch(() => {
        throw new Error(`Chromium executable is unavailable: ${browserExecutablePath}. Run Playwright browser installation first.`)
      })
    }
    const threadOptions: AgentHostLaunchOptions = {
      workspaceDirectory: workspace.workspaceDirectory,
      runtime,
      ...(options.agentExecutable ? { executable: options.agentExecutable } : {}),
      additionalWritableDirectories: [workspace.privateDirectory],
      playwrightConfigPath: workspace.playwrightConfigPath,
      playwrightSecretsPath: workspace.playwrightSecretsPath,
      controlConfigPath: workspace.controlConfigPath,
      fullAgentAccess: (options.testDataAccess ?? 'direct') === 'direct',
    }
    const hostProbe = await host.probe(threadOptions)
    if (!hostProbe.ok) throw new Error(`${host.displayName} 不可用：${hostProbe.reason ?? '宿主探针失败'}`)
    if (!host.capabilities.streaming || !host.capabilities.mcp) {
      throw new Error(`${host.displayName} 缺少 Auto-Test 所需的 streaming 或 MCP 能力`)
    }
    if ((options.testDataAccess ?? 'direct') === 'opaque' && !host.capabilities.restrictedMode) {
      throw new Error(`${host.displayName} 不支持 opaque/restricted test-data mode`)
    }
    const buildInfo = await readAgentBuildInfo()
    await writePrivateJson(resolve(outputDirectory, 'agent-host-selection.json'), {
      version: '1.0',
      id: host.id,
      displayName: host.displayName,
      capabilities: host.capabilities,
      executable: hostProbe.executable,
      hostVersion: hostProbe.version,
      modelProvider: {
        supportedApis: host.modelProvider.supportedApis,
        ...(runtime.provider ? { binding: runtime.provider } : { mode: 'native' }),
      },
      ...buildInfo,
      selectedAt: new Date().toISOString(),
    })
    state = updateCodexTestState(state, { agentHost: host.id })
    await writePrivateJson(statePath, state)
    progress.report('stage', `隔离测试工作区已准备，正在启动 ${host.displayName} 测试线程`)
    const fullAgentAccess = (options.testDataAccess ?? 'direct') === 'direct'
    const existingRecords = await readCaseResultRecords(resultDirectory, options.manifest)
    const completedCaseIds = new Set([
      ...state.completedCaseIds,
      ...existingRecords.map((record) => record.result.caseId),
    ])
    const capacity = capacityForAgentProfile(options.modelProfile)
    let epochs = buildAgentExecutionEpochs(options.manifest, capacity, completedCaseIds)
    const activePendingCaseIds = state.activeEpoch?.caseIds.filter((caseId) => !completedCaseIds.has(caseId)) ?? []
    if (state.activeEpoch && activePendingCaseIds.length > 0) {
      const active = new Set(activePendingCaseIds)
      const remaining = epochs
        .map((epoch) => ({ ...epoch, caseIds: epoch.caseIds.filter((caseId) => !active.has(caseId)) }))
        .filter((epoch) => epoch.caseIds.length > 0)
        .map((epoch, index) => epoch.id === state.activeEpoch!.id
          ? { ...epoch, id: `epoch-replanned-${String(index + 1).padStart(4, '0')}` }
          : epoch)
      epochs = [
        {
          ...state.activeEpoch,
          caseIds: activePendingCaseIds,
          estimatedInputTokens: 0,
          estimatedOutputTokens: activePendingCaseIds.length * capacity.caseOutputTokens,
        },
        ...remaining,
      ].map((epoch, index, items) => ({ ...epoch, index, total: items.length }))
    }
    state = updateCodexTestState(state, {
      stage: 'executing',
      completedCaseIds: [...completedCaseIds],
      epochCount: epochs.length,
    })
    await writePrivateJson(statePath, state)

    const currentSessionBindingFingerprint = sessionBindingFingerprint(host, runtime)
    // Legacy injected thread factories are deterministic unit-test seams; a
    // real AgentHost must prove that its configured Control MCP reaches the
    // model before any browser or business operation is attempted.
    const capabilityPreflightRequired = !usesLegacyThreadFactory
    let thread: AgentHostSession | undefined
    let threadId = state.threadId ?? resumeThreadId
    const capacityRecoveryAttempts = new Set<string>()
    const rateLimitRecoveryAttempts = new Set<string>()
    const freshlySplitEpochIds = new Set<string>()
    for (let epochIndex = 0; epochIndex < epochs.length; epochIndex += 1) {
      const epoch = epochs[epochIndex]!
      if (epoch.caseIds.every((caseId) => completedCaseIds.has(caseId))) continue
      const scopedManifest = manifestForAgentExecutionEpoch(options.manifest, epoch)
      const deliveryPath = epochDeliveryPath(workspace, epoch)
      const scrubEpochArtifacts = async (): Promise<void> => {
        await promoteReplayBrowserState(workspace, options.profile.origins)
        await scrubGeneratedArtifacts()
        await redactAgentTextArtifact(deliveryPath, redactionSecrets)
      }
      await activateExecutionEpoch(workspace, epoch)
      progress.setContext({ epochIndex: epoch.index + 1, epochTotal: epoch.total, threadGeneration: state.threadGeneration })
      const resumingEpoch = state.activeEpoch?.id === epoch.id && !freshlySplitEpochIds.delete(epoch.id)
      const initialEpochStage = resumingEpoch ? state.activeEpoch!.stage : 'executing'
      const storedEpochThreadId = resumingEpoch ? state.activeEpoch?.threadId ?? threadId : undefined
      const bindingChanged = Boolean(
        storedEpochThreadId &&
        state.sessionBindingFingerprint &&
        state.sessionBindingFingerprint !== currentSessionBindingFingerprint,
      )
      const epochThreadId = bindingChanged ? undefined : storedEpochThreadId
      if (bindingChanged) {
        progress.report('warning', '当前 Provider/模型绑定与已保存的物理 AgentHost session 不同，正在保留原 Run 并启动新的恢复线程')
      }
      if (epochThreadId && !host.capabilities.sessionResume) {
        throw new Error(`${host.displayName} 不支持恢复既有会话；为避免重复业务写入，本次 Run 已安全阻断`)
      }
      thread = epochThreadId
        ? await host.resume({ ...threadOptions, resumeId: epochThreadId })
        : await host.start(threadOptions)
      activeThread = thread
      threadId = epochThreadId ?? thread.id ?? undefined
      const { threadId: _previousThreadId, ...stateWithoutPreviousThread } = state
      const epochUsage: CodexTurnUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
      const persistThreadId = async (id: string): Promise<void> => {
        threadId = id
        state = updateCodexTestState(state, {
          threadId: id,
          ...(state.activeEpoch ? { activeEpoch: { ...state.activeEpoch, threadId: id } } : {}),
        })
        await writePrivateJson(statePath, state)
      }
      const stateForEpoch = epochThreadId ? state : stateWithoutPreviousThread
      state = updateCodexTestState(stateForEpoch, {
        stage: 'executing',
        ...(!epochThreadId ? {
          threadGeneration: state.threadGeneration + 1,
          sessionBindingFingerprint: currentSessionBindingFingerprint,
        } : {}),
        activeEpoch: {
          id: epoch.id,
          index: epoch.index,
          total: epoch.total,
          caseIds: epoch.caseIds,
          stage: initialEpochStage,
          ...(thread.id ? { threadId: thread.id } : {}),
        },
        ...(thread.id ? { threadId: thread.id } : {}),
      })
      await writePrivateJson(statePath, state)
      progress.setContext({ threadGeneration: state.threadGeneration })
      const receiptRecorder = await ExecutionReceiptRecorder.create(workspace.executionReceiptsPath, epoch.caseIds, epoch.id)
      const recordUsage = async (usage: CodexTurnUsage): Promise<void> => {
        epochUsage.inputTokens = usage.inputTokens
        epochUsage.cachedInputTokens = usage.cachedInputTokens
        epochUsage.outputTokens = usage.outputTokens
        state = updateCodexTestState(state, { lastUsage: { ...epochUsage } })
        await writePrivateJson(statePath, state)
      }
      const invalidatePhysicalSession = async (): Promise<void> => {
        const currentThread = thread
        thread = undefined
        if (activeThread === currentThread) activeThread = undefined
        try {
          await currentThread?.close?.()
        } catch {
          // The provider has already failed; preserve the logical Run even if
          // closing its physical transport also reports an error.
        }
        const { threadId: _runThreadId, activeEpoch: currentEpoch, ...stateWithoutThread } = state
        const nextEpoch = currentEpoch
          ? (() => {
              const { threadId: _epochThreadId, ...epochWithoutThread } = currentEpoch
              return epochWithoutThread
            })()
          : undefined
        state = updateCodexTestState(stateWithoutThread, nextEpoch ? { activeEpoch: nextEpoch } : {})
        threadId = undefined
        await writePrivateJson(statePath, state)
      }
      // A logical Run may cold-resume on one replacement physical session,
      // but only after the original resume attempt proves incompatible.
      let resumeCompatibilityPending = Boolean(epochThreadId)
      let sessionRotationAttempted = false
      let capabilityPreflightCompleted = false
      const verifyControlMcpCapability = async (): Promise<void> => {
        if (!capabilityPreflightRequired) {
          capabilityPreflightCompleted = true
          return
        }
        if (capabilityPreflightCompleted) return
        if (!thread) throw new Error('AgentHost thread is unavailable for the Control MCP capability preflight')
        let completedContractCalls = 0
        let unexpectedTool: string | undefined
        await runTurn(
          thread,
          host.id,
          [{ type: 'text', text: controlMcpPreflightPrompt(host.id) }],
          eventsPath,
          redactionSecrets,
          progress,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          (event) => {
            if (isCompletedControlContractCall(event)) completedContractCalls += 1
            else if (isPreflightActionEvent(event) && !isControlContractToolEvent(event)) {
              unexpectedTool = [event.server, event.tool].filter(Boolean).join('.') || 'unknown'
            }
          },
        )
        if (completedContractCalls !== 1 || unexpectedTool) {
          const details = [
            ...(completedContractCalls !== 1 ? [`expected one completed auto-test-control.test_contract call, observed ${completedContractCalls}`] : []),
            ...(unexpectedTool ? [`unexpected tool call observed: ${unexpectedTool}`] : []),
          ]
          throw new Error(`Auto-Test Control MCP capability preflight failed: ${details.join('; ')}`)
        }
        capabilityPreflightCompleted = true
      }
      const invokeEpochTurn = async (
        input: AgentInputPart[],
        outputSchema?: unknown,
      ): Promise<string> => {
        if (!thread) throw new Error('AgentHost thread is unavailable for the active execution epoch')
        await verifyControlMcpCapability()
        return runTurn(
          thread,
          host.id,
          input,
          eventsPath,
          redactionSecrets,
          progress,
          persistThreadId,
          outputSchema,
          receiptRecorder,
          recordUsage,
          scrubEpochArtifacts,
        )
      }
      const confirmSessionBinding = async (): Promise<void> => {
        if (state.sessionBindingFingerprint === currentSessionBindingFingerprint) return
        state = updateCodexTestState(state, { sessionBindingFingerprint: currentSessionBindingFingerprint })
        await writePrivateJson(statePath, state)
      }
      const startReplacementSession = async (message: string): Promise<void> => {
        if (thread || threadId || state.threadId || state.activeEpoch?.threadId) await invalidatePhysicalSession()
        thread = await host.start(threadOptions)
        activeThread = thread
        capabilityPreflightCompleted = false
        threadId = thread.id ?? undefined
        if (!state.activeEpoch) throw new Error('Cannot rotate an AgentHost session without an active execution epoch')
        const { threadId: _oldThreadId, ...stateWithoutThread } = state
        const { threadId: _oldEpochThreadId, ...activeEpochWithoutThread } = state.activeEpoch
        state = updateCodexTestState(stateWithoutThread, {
          threadGeneration: state.threadGeneration + 1,
          sessionBindingFingerprint: currentSessionBindingFingerprint,
          activeEpoch: {
            ...activeEpochWithoutThread,
            ...(thread.id ? { threadId: thread.id } : {}),
          },
          ...(thread.id ? { threadId: thread.id } : {}),
        })
        await writePrivateJson(statePath, state)
        progress.setContext({ threadGeneration: state.threadGeneration })
        progress.report('warning', message)
      }
      const rotateIncompatibleSession = async (): Promise<string> => {
        sessionRotationAttempted = true
        resumeCompatibilityPending = false
        await startReplacementSession('已保留逻辑 Run、epoch 和 Mutation Ledger，并启动新的 AgentHost 线程恢复现场')
        return invokeEpochTurn(
          hostInput(host, runtime, agentTestResumePrompt(fullAgentAccess, epoch, deliveryPath), []),
        )
      }
      const runEpochTurn = async (
        input: AgentInputPart[],
        outputSchema?: unknown,
        isResumePrompt = false,
        allowCapacityRecovery = false,
      ): Promise<string> => {
        try {
          const response = await invokeEpochTurn(input, outputSchema)
          if (resumeCompatibilityPending) {
            resumeCompatibilityPending = false
            await confirmSessionBinding()
          }
          return response
        } catch (error) {
          if (error instanceof AgentHostError && error.kind === 'quota') {
            const recoveryKey = epoch.id
            if (isTransientProviderRateLimitError(error) && !rateLimitRecoveryAttempts.has(recoveryKey)) {
              rateLimitRecoveryAttempts.add(recoveryKey)
              const delayMs = providerRetryDelayMs(error)
              progress.report('warning', `Provider 暂时限流，${delayMs > 0 ? `等待 ${Math.ceil(delayMs / 1000)} 秒后` : ''}自动恢复当前 epoch`)
              await waitForProviderRateLimit(error)
              const stageBeforeRecovery = state.activeEpoch?.stage ?? state.stage
              await startReplacementSession('已保留逻辑 Run、epoch 和 Mutation Ledger，并启动新的 AgentHost 线程恢复限流中的工作')
              const recoveryInput = isResumePrompt || stageBeforeRecovery === 'checkpointing' || stageBeforeRecovery === 'finalizing'
                ? input
                : hostInput(host, runtime, agentTestResumePrompt(fullAgentAccess, epoch, deliveryPath), [])
              return invokeEpochTurn(recoveryInput, outputSchema)
            }
            if (allowCapacityRecovery && isContextOrOutputCapacityError(error) && !capacityRecoveryAttempts.has(recoveryKey)) {
              capacityRecoveryAttempts.add(recoveryKey)
              await startReplacementSession('当前物理线程已达到模型容量，正在保留原 Run 并自动换新线程继续')
              return runEpochTurn(input, outputSchema, isResumePrompt, false)
            }
            await invalidatePhysicalSession()
            throw error
          }
          const sessionIncompatible = error instanceof AgentHostError && error.kind === 'session_incompatible'
          if (!sessionIncompatible || !resumeCompatibilityPending || sessionRotationAttempted) throw error
          const recoveredResponse = await rotateIncompatibleSession()
          return isResumePrompt ? recoveredResponse : invokeEpochTurn(input, outputSchema)
        }
      }

      if (initialEpochStage === 'executing') {
        progress.report('stage', `正在执行当前 epoch（${epoch.caseIds.length} 条）`)
        const input = resumingEpoch
          ? hostInput(host, runtime, agentTestResumePrompt(fullAgentAccess, epoch, deliveryPath), [])
          : hostInput(host, runtime, agentTestPrompt({
                manifest: scopedManifest,
                environmentContext: options.environmentContext,
                secretAliases: workspace.secretAliases,
                allowedOrigins: options.profile.origins,
                testDataAccess: options.testDataAccess ?? 'direct',
                inputDirectory: workspace.inputDirectory,
                manifestPath: workspace.manifestPath,
                deliveryArtifactPath: deliveryPath,
                ...(state.checkpointPath ? { checkpointPath: state.checkpointPath } : {}),
                executionEpoch: epoch,
                ...(workspace.sourceFilePath ? { sourceFilePath: workspace.sourceFilePath } : {}),
                ...(workspace.briefFilePath ? { briefFilePath: workspace.briefFilePath } : {}),
                ...(workspace.runValuesPath ? { runValuesPath: workspace.runValuesPath } : {}),
                ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
              }), imagePathsForExecutionEpoch(workspace, scopedManifest))
        try {
          await runEpochTurn(input, undefined, resumingEpoch)
        } catch (error) {
          if (!isContextOrOutputCapacityError(error) && !isTransientProviderRateLimitError(error)) throw error
          const deliveryExists = await access(deliveryPath).then(() => true, () => false)
          if (deliveryExists) {
            state = updateCodexTestState(state, {
              stage: 'finalizing',
              activeEpoch: { ...state.activeEpoch!, stage: 'finalizing' },
            })
            await writePrivateJson(statePath, state)
            await startReplacementSession('执行交付已落盘但原线程达到模型容量，正在换新线程完成确定性核对')
          } else {
            const ledger = await readMutationLedger(workspace.mutationLedgerPath)
            const hasPendingMutation = ledger.some((entry) => entry.status === 'pending')
            const receipts = await readExecutionReceipts(workspace.executionReceiptsPath)
            const hasInteractionReceipt = receipts.some((receipt) => epoch.caseIds.includes(receipt.caseId ?? '') && receipt.kind === 'interaction')
            if (isContextOrOutputCapacityError(error) && capabilityPreflightCompleted && ledger.length === 0 && !hasInteractionReceipt && epoch.caseIds.length > 1) {
              const replacements = splitAgentExecutionEpoch(options.manifest, epoch)
              epochs.splice(epochIndex, 1, ...replacements)
              epochs = epochs.map((item, index, items) => ({ ...item, index, total: items.length }))
              replacements.forEach((item) => freshlySplitEpochIds.add(item.id))
              const nextEpoch = epochs[epochIndex]!
              state = updateCodexTestState(state, {
                stage: 'executing',
                epochCount: epochs.length,
                activeEpoch: {
                  id: nextEpoch.id,
                  index: nextEpoch.index,
                  total: nextEpoch.total,
                  caseIds: nextEpoch.caseIds,
                  stage: 'executing',
                },
              })
              await activateExecutionEpoch(workspace, nextEpoch)
              await writePrivateJson(statePath, state)
              progress.setContext({ epochIndex: nextEpoch.index + 1, epochTotal: nextEpoch.total, threadGeneration: state.threadGeneration })
              progress.report('warning', `当前 epoch 遭遇可恢复的模型容量/限流边界，已自动拆分为 ${replacements.map((item) => item.caseIds.length).join(' + ')} 条并继续执行`)
              epochIndex -= 1
              continue
            }
            if (!isContextOrOutputCapacityError(error)) throw error
            const recoveryKey = `${epoch.id}:execution`
            if (capacityRecoveryAttempts.has(recoveryKey)) throw error
            capacityRecoveryAttempts.add(recoveryKey)
            await startReplacementSession(hasPendingMutation
              ? '当前物理线程达到模型容量，正在换新线程优先核对未完成业务写入'
              : '当前单 case epoch 达到模型容量，正在换新线程自动恢复一次')
            await runEpochTurn(
              hostInput(host, runtime, agentTestResumePrompt(fullAgentAccess, epoch, deliveryPath), []),
              undefined,
              true,
            )
          }
        }
        state = updateCodexTestState(state, {
          stage: 'finalizing',
          activeEpoch: { ...state.activeEpoch!, stage: 'finalizing', ...(thread?.id ? { threadId: thread.id } : {}) },
          ...(thread?.id ? { threadId: thread.id } : {}),
        })
        await writePrivateJson(statePath, state)
      } else {
        progress.report('stage', `正在恢复 epoch ${epoch.id} 的结构化交付，不重复业务执行`)
      }

      const ledgerBeforeFinalization = await readMutationLedger(workspace.mutationLedgerPath)
      if (ledgerBeforeFinalization.some((entry) => entry.status === 'pending')) {
        progress.report('stage', `epoch ${epoch.id} 存在未核销业务写入，正在由同一线程恢复核对`)
        await runEpochTurn(
          hostInput(host, runtime, agentTestResumePrompt(fullAgentAccess, epoch, deliveryPath), []),
          undefined,
          true,
          true,
        )
      }

      let deliveryProblems: string[] = []
      let lastRecoveredEpochCases: CodexTestCaseResult[] = []
      const recoverExistingEpochDelivery = async (): Promise<CodexTestAgentResult | undefined> => {
        const recovered = await recoverAgentDeliveryResult({ artifactPath: deliveryPath, manifest: scopedManifest, startedAt: state.startedAt })
        if (!recovered.result) {
          deliveryProblems = recovered.problems
          return undefined
        }
        lastRecoveredEpochCases = recovered.result.cases
        const requirements = await reconcileEnvironmentRequirementCaseLinks(
          workspace.environmentRequirementsPath,
          recovered.result.cases,
        )
        const scopedRequirements = environmentRequirementsForCases(requirements, epoch.caseIds)
        const executionReceipts = await readExecutionReceipts(workspace.executionReceiptsPath)
        const normalized = { ...recovered.result, environmentRequirements: scopedRequirements }
        const replayProblems = await replayProblemsForResult(eventsPath, normalized)
        const problems = finalResultProblems(normalized, scopedManifest, scopedRequirements, executionReceipts, replayProblems)
        const replayVerification = problems.length === 0
          ? await replayVerificationProblems({ outputDirectory, eventsPath, result: normalized, manifest: scopedManifest, workspace, profile: options.profile })
          : []
        deliveryProblems = [...problems, ...replayVerification]
        if (deliveryProblems.length > 0) return undefined
        return enforceMutationLedger(enforceEnvironmentRequirements(normalized, scopedRequirements), await readMutationLedger(workspace.mutationLedgerPath))
      }
      // A complete epoch artifact is already an auditable delivery contract;
      // do not spend another model turn merely to re-serialize those facts.
      let epochResult: CodexTestAgentResult | undefined = await recoverExistingEpochDelivery()
      const maxFinalizationTurns = options.maxFinalizationTurns ?? 2
      for (let turn = 0; !epochResult && turn <= maxFinalizationTurns; turn++) {
        if (turn > 0) progress.report('stage', `epoch ${epoch.id} 的结构化交付仍有 ${deliveryProblems.length} 项问题，正在修正`)
        const prompt = turn === 0
          ? agentTestFinalPrompt(epoch)
          : `${agentTestFinalPrompt(epoch)}\n\nThe previous result had these deterministic contract problems:\n- ${deliveryProblems.join('\n- ')}\nCorrect only this epoch from existing evidence. Do not repeat business writes.`
        try {
          const finalResponse = await runEpochTurn(
            hostInput(host, runtime, prompt, []),
            host.capabilities.structuredOutput ? agentTestStructuredOutputSchema : undefined,
            false,
            true,
          )
          const candidate = parseAgentTestCandidate(finalResponse)
          const requirements = await reconcileEnvironmentRequirementCaseLinks(workspace.environmentRequirementsPath, candidate.cases)
          const scopedRequirements = environmentRequirementsForCases(requirements, epoch.caseIds)
          const executionReceipts = await readExecutionReceipts(workspace.executionReceiptsPath)
          const normalized = {
            ...candidate,
            startedAt: state.startedAt,
            finishedAt: new Date().toISOString(),
            mutations: [],
            environmentRequirements: scopedRequirements,
          }
          const replayProblems = await replayProblemsForResult(eventsPath, normalized)
          deliveryProblems = finalResultProblems(normalized, scopedManifest, scopedRequirements, executionReceipts, replayProblems)
          if (deliveryProblems.length > 0) continue
          deliveryProblems = await replayVerificationProblems({
            outputDirectory,
            eventsPath,
            result: normalized,
            manifest: scopedManifest,
            workspace,
            profile: options.profile,
          })
          if (deliveryProblems.length > 0) continue
          epochResult = enforceMutationLedger(enforceEnvironmentRequirements(normalized, scopedRequirements), await readMutationLedger(workspace.mutationLedgerPath))
          break
        } catch (error) {
          const message = redactAgentValue(error instanceof Error ? error.message : String(error), redactionSecrets)
          deliveryProblems = [message]
          if (isOperationalBlock(message, error)) {
            const interruption = infrastructureBlockDetails(message)
            runInterruption = {
              code: interruption.code,
              stage: interruptionStage(state),
              summary: interruption.reason,
              nextAction: interruption.nextAction,
              occurredAt: new Date().toISOString(),
            }
          }
          if (isOperationalBlock(message, error) && !await access(deliveryPath).then(() => true, () => false)) throw error
          if (isOperationalBlock(message, error)) break
        }
      }

      if (!epochResult) {
        const ledger = await readMutationLedger(workspace.mutationLedgerPath)
        const recovered = await recoverExistingEpochDelivery()
        if (recovered) {
          epochResult = recovered
        } else {
          const requirements = await readJsonOr<CodexTestEnvironmentRequirement[]>(workspace.environmentRequirementsPath, [])
          epochResult = deliveryBlockedResult(scopedManifest, state, deliveryProblems.join('; ') || `epoch ${epoch.id} 没有可验证的结构化交付`, ledger, environmentRequirementsForCases(requirements, epoch.caseIds), lastRecoveredEpochCases)
        }
      }

      if (epochResult.mutations.some((mutation) => mutation.status === 'pending')) {
        const requirements = await readJsonOr<CodexTestEnvironmentRequirement[]>(workspace.environmentRequirementsPath, [])
        const ledger = await readMutationLedger(workspace.mutationLedgerPath)
        const allRecords = await readCaseResultRecords(resultDirectory, options.manifest)
        const cases = [...allRecords.map((record) => record.result), ...epochResult.cases]
        const completed = new Set(cases.map((item) => item.caseId))
        const remainingManifest = {
          ...options.manifest,
          phases: options.manifest.phases.filter((phase) => !completed.has(phase.id)),
        }
        if (remainingManifest.phases.length > 0) {
          cases.push(...deliveryBlockedResult(
            remainingManifest,
            state,
            `Suite scheduling stopped because ${epoch.id} has unrecovered business mutations.`,
            ledger,
            [],
          ).cases)
        }
        const result = redactAgentJsonArtifact(enforceMutationLedger(enforceEnvironmentRequirements(aggregateCaseResults({ manifest: options.manifest, caseResults: cases, requirements, startedAt: state.startedAt }), requirements), ledger), redactionSecrets)
        await writePrivateJson(resultPath, result)
        await writePrivateJson(workspace.caseResultsPath, deliveryArtifactFromResult(result))
        state = updateCodexTestState(state, {
          status: 'completed', stage: 'completed', outcome: 'blocked', resultPath, finishedAt: new Date().toISOString(),
          ...(runInterruption ? { runInterruption } : {}),
        })
        await writePrivateJson(statePath, state)
        return { state, result }
      }

      epochResult = redactAgentJsonArtifact(epochResult, redactionSecrets)
      await writePrivateJson(epochResultPath(workspace, epoch), epochResult)
      await writeCaseResultRecords(resultDirectory, options.manifest, epoch.id, epochResult.cases)
      for (const item of epochResult.cases) completedCaseIds.add(item.caseId)
      const { activeEpoch: _activeEpoch, ...stateWithoutActiveEpoch } = state
      state = updateCodexTestState(stateWithoutActiveEpoch, {
        stage: 'executing',
        completedCaseIds: [...completedCaseIds],
        lastUsage: { ...epochUsage },
      })
      await writePrivateJson(statePath, state)
      progress.report('stage', `当前 epoch 已完成，累计 ${completedCaseIds.size}/${options.manifest.phases.length} 条`)

      if (epoch.index < epochs.length - 1) {
        const checkpointPath = resolve(checkpointDirectory, `${epoch.id}.json`)
        const previousCheckpointPath = state.checkpointPath
        await mkdir(checkpointDirectory, { recursive: true, mode: 0o700 })
        state = updateCodexTestState(state, {
          stage: 'executing',
          checkpointPath,
          activeEpoch: {
            id: epoch.id,
            index: epoch.index,
            total: epoch.total,
            caseIds: epoch.caseIds,
            stage: 'checkpointing',
            ...(threadId ? { threadId } : {}),
          },
        })
        await writePrivateJson(statePath, state)
        progress.report('stage', '正在保存当前 epoch 的 AgentHost 工作记忆 checkpoint')
        let checkpointSaved = false
        try {
          await runEpochTurn(hostInput(host, runtime, agentTestCheckpointPrompt(epoch, checkpointPath), []))
          checkpointSaved = true
        } catch (error) {
          if (!isContextOrOutputCapacityError(error)) throw error
          progress.report('warning', 'checkpoint 线程仍达到模型容量；case 结果已经落盘，将跳过本次工作记忆并继续下一 epoch')
        }
        const { activeEpoch: _checkpointedEpoch, checkpointPath: _attemptedCheckpointPath, ...checkpointedState } = state
        state = updateCodexTestState(checkpointedState, {
          stage: 'executing',
          ...(checkpointSaved ? { checkpointPath } : previousCheckpointPath ? { checkpointPath: previousCheckpointPath } : {}),
        })
        await writePrivateJson(statePath, state)
        await thread?.close?.()
        thread = undefined
        threadId = undefined
      }
    }

    const requirements = await readJsonOr<CodexTestEnvironmentRequirement[]>(workspace.environmentRequirementsPath, [])
    const ledger = await readMutationLedger(workspace.mutationLedgerPath)
    const records = await readCaseResultRecords(resultDirectory, options.manifest)
    let result: CodexTestAgentResult
    try {
      result = enforceMutationLedger(enforceEnvironmentRequirements(aggregateCaseResults({ manifest: options.manifest, caseResults: records.map((record) => record.result), requirements, startedAt: state.startedAt }), requirements), ledger)
      const problems = finalResultProblems(
        result,
        options.manifest,
        requirements,
        await readExecutionReceipts(workspace.executionReceiptsPath),
        await replayProblemsForResult(eventsPath, result),
      )
      if (problems.length > 0) throw new Error(`Adaptive epoch aggregation failed deterministic validation: ${problems.join('; ')}`)
    } catch (error) {
      result = deliveryBlockedResult(
        options.manifest,
        state,
        error instanceof Error ? error.message : String(error),
        ledger,
        requirements,
        records.map((record) => record.result),
      )
    }
    result = redactAgentJsonArtifact(result, redactionSecrets)
    await writePrivateJson(resultPath, result)
    await writePrivateJson(workspace.caseResultsPath, deliveryArtifactFromResult(result))
    state = updateCodexTestState(state, {
      status: 'completed',
      stage: 'completed',
      outcome: result.outcome,
      resultPath,
      finishedAt: new Date().toISOString(),
      completedCaseIds: [...completedCaseIds],
      ...(runInterruption ? { runInterruption } : {}),
      ...(threadId ? { threadId } : {}),
    })
    await writePrivateJson(statePath, state)
    progress.report('stage', `全部 ${epochs.length} 个执行 epoch 已完成：${result.outcome}`)
    return { state, result }
  } catch (error) {
    const message = redactAgentValue(error instanceof Error ? error.message : String(error), redactionSecrets)
    if (isOperationalBlock(message, error)) {
      progress.report('warning', '模型、浏览器、MCP 或本地网络暂时不可用，正在保存可恢复的 blocked 结果')
      let ledger: CodexTestMutationLedgerEntry[] = []
      let ledgerError: string | undefined
      if (mutationLedgerPath) {
        try {
          ledger = await readMutationLedger(mutationLedgerPath)
        } catch (ledgerReadError) {
          ledgerError = redactAgentValue(ledgerReadError instanceof Error ? ledgerReadError.message : String(ledgerReadError), redactionSecrets)
        }
      }
      const environmentRequirements = environmentRequirementsPath
        ? await readJsonOr<CodexTestEnvironmentRequirement[]>(environmentRequirementsPath, [])
        : []
      let recordedCases: CodexTestCaseResult[] = []
      let caseStoreError: string | undefined
      if (mutationLedgerPath) {
        try {
          recordedCases = (await readCaseResultRecords(caseResultDirectory(outputDirectory), options.manifest)).map((record) => record.result)
        } catch (caseReadError) {
          caseStoreError = redactAgentValue(caseReadError instanceof Error ? caseReadError.message : String(caseReadError), redactionSecrets)
        }
      }
      const result = redactAgentJsonArtifact(
        ledgerError || caseStoreError || isMutationLedgerViolation(message)
          ? deliveryBlockedResult(options.manifest, state, ledgerError ?? caseStoreError ?? message, ledger, environmentRequirements, recordedCases)
          : blockedResult(options.manifest, state, message, ledger, environmentRequirements, recordedCases),
        redactionSecrets,
      )
      await writePrivateJson(resultPath, result)
      const interruption = infrastructureBlockDetails(message)
      state = updateCodexTestState(state, {
        status: 'completed', stage: 'completed', outcome: 'blocked', resultPath, finishedAt: new Date().toISOString(),
        runInterruption: {
          code: interruption.code,
          stage: interruptionStage(state),
          summary: interruption.reason,
          nextAction: interruption.nextAction,
          occurredAt: new Date().toISOString(),
        },
        ...(activeThread?.id ? { threadId: activeThread.id } : {}),
      })
      await writePrivateJson(statePath, state)
      return { state, result }
    }
    progress.report('warning', '框架执行发生未恢复错误，正在保存失败状态和诊断信息')
    state = updateCodexTestState(state, {
      status: 'failed', stage: 'failed', error: message,
      ...(activeThread?.id ? { threadId: activeThread.id } : {}),
    })
    await writePrivateJson(statePath, state)
    return { state }
  } finally {
    await activeThread?.close?.()
    progress.close()
  }
}

/**
 * Compatibility name for integrations that predate the AgentHost boundary.
 * New callers should use runAgentTest and select a host explicitly.
 */
export async function runCodexTestAgent(
  options: AgentTestOptions,
  dependencies: AgentTestDependencies = {},
): Promise<AgentTestRun> {
  return runAgentTest(options, dependencies)
}
