import { Codex, type Input, type Thread, type ThreadEvent } from '@openai/codex-sdk'
import { chromium } from '@playwright/test'
import { constants as fsConstants } from 'node:fs'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EnvironmentProfile } from '../workflow/environment-profile.js'
import type { ModelProfile } from '../workflow/model-profile.js'
import type { WorkflowIntakeManifest } from '../workflow/types.js'
import { buildCodexExecutionEpochs, capacityForModelProfile, manifestForExecutionEpoch, type CodexExecutionEpoch } from './execution-epochs.js'
import { caseResultDirectory, readCaseResultRecords, writeCaseResultRecords } from './case-result-store.js'
import type { CodexTestControlConfig } from './control-types.js'
import { reconcileEnvironmentRequirementCaseLinks, reconcileEnvironmentRequirements } from './environment-requirements.js'
import { recoverCodexDeliveryResult } from './delivery-recovery.js'
import { ExecutionReceiptRecorder, readExecutionReceipts } from './execution-receipts.js'
import { codexTestAgentCheckpointPrompt, codexTestAgentFinalPrompt, codexTestAgentPrompt, codexTestAgentResumePrompt } from './prompt.js'
import { CodexTestProgressReporter, type CodexTestAgentProgressSink } from './progress.js'
import { redactAgentValue, secretValues, transientAgentEventValues } from './redact.js'
import { codexTestResultSchema, enforceMutationLedger, parseCodexTestResult } from './result.js'
import { initialCodexTestState, updateCodexTestState, writePrivateJson } from './state.js'
import type { CodexTestAgentResult, CodexTestAgentState, CodexTestEnvironmentRequirement, CodexTestExecutionReceipt, CodexTestMutationLedgerEntry } from './types.js'
import { prepareCodexAgentWorkspace, type CodexAgentWorkspace } from './workspace.js'

export interface CodexTestAgentOptions {
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
  codexExecutable?: string
  codexHome?: string
  maxFinalizationTurns?: number
  resume?: boolean
  onProgress?: CodexTestAgentProgressSink
  progressHeartbeatMs?: number
  testDataAccess?: 'direct' | 'opaque'
  modelProfile?: ModelProfile
}

export interface CodexTestAgentRun {
  state: CodexTestAgentState
  result?: CodexTestAgentResult
}

interface AgentThread {
  readonly id: string | null
  runStreamed(input: Input, options?: { outputSchema?: unknown }): Promise<{ events: AsyncGenerator<ThreadEvent> }>
}

interface CodexTurnUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

export interface CodexTestAgentDependencies {
  startThread?: (options: { workspaceDirectory: string; agentHome: string; model?: string; codexExecutable: string; playwrightConfigPath: string; playwrightSecretsPath: string; controlConfigPath: string; codexEnvironment: Record<string, string>; mcpEnvironment: Record<string, string>; fullAgentAccess: boolean }) => AgentThread
  resumeThread?: (options: { threadId: string; workspaceDirectory: string; agentHome: string; model?: string; codexExecutable: string; playwrightConfigPath: string; playwrightSecretsPath: string; controlConfigPath: string; codexEnvironment: Record<string, string>; mcpEnvironment: Record<string, string>; fullAgentAccess: boolean }) => AgentThread
  browserExecutablePath?: string
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))

function packageFilePath(packageName: string, fileName: string): string {
  const packagePath = import.meta.resolve(`${packageName}/package.json`)
  return resolve(dirname(fileURLToPath(packagePath)), fileName)
}

function controlServerPath(): string {
  const extension = extname(fileURLToPath(import.meta.url)) === '.ts' ? '.ts' : '.js'
  return resolve(moduleDirectory, `control-server${extension}`)
}

function executableNames(command: string, environment: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32' || extname(command)) return [command]
  const extensions = (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)]
}

async function executableFromPath(command: string, environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const pathValue = environment.Path ?? environment.PATH ?? ''
  const directories = pathValue.split(delimiter).filter((directory) => {
    if (!directory) return false
    return !/[\\/]node_modules[\\/]\.bin(?:[\\/]|$)/i.test(directory)
  })
  for (const directory of directories) {
    for (const name of executableNames(command, environment)) {
      const candidate = resolve(directory, name)
      try {
        await access(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        // Continue searching the user PATH.
      }
    }
  }
  return undefined
}

async function resolveCodexExecutable(options: CodexTestAgentOptions): Promise<string> {
  const configured = options.codexExecutable || process.env.AUTO_TEST_CODEX_BIN
  if (configured) {
    const candidate = isAbsolute(configured) ? configured : resolve(configured)
    await access(candidate, fsConstants.X_OK).catch(() => {
      throw new Error(`Configured Codex CLI executable is unavailable: ${candidate}`)
    })
    return candidate
  }
  const candidate = await executableFromPath('codex', process.env)
  if (!candidate) {
    throw new Error('Current Codex CLI executable was not found outside dependency node_modules/.bin directories. Install Codex CLI or set AUTO_TEST_CODEX_BIN.')
  }
  return candidate
}

function startSdkThread(options: {
  workspaceDirectory: string
  agentHome: string
  model?: string
  codexExecutable: string
  playwrightConfigPath: string
  playwrightSecretsPath: string
  controlConfigPath: string
  codexEnvironment: Record<string, string>
  mcpEnvironment: Record<string, string>
  threadId?: string
  fullAgentAccess: boolean
}): Thread {
  const playwrightCli = packageFilePath('@playwright/mcp', 'cli.js')
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'))
  const controlServer = controlServerPath()
  const restrictedPlaywrightTools = [
    'browser_click',
    'browser_check',
    'browser_close',
    'browser_console_messages',
    'browser_drag',
    'browser_drop',
    'browser_file_upload',
    'browser_fill_form',
    'browser_find',
    'browser_handle_dialog',
    'browser_hover',
    'browser_navigate',
    'browser_navigate_back',
    'browser_navigate_forward',
    'browser_network_request',
    'browser_network_requests',
    'browser_press_key',
    'browser_reload',
    'browser_resize',
    'browser_select_option',
    'browser_snapshot',
    'browser_tabs',
    'browser_take_screenshot',
    'browser_type',
    'browser_uncheck',
    'browser_verify_element_visible',
    'browser_verify_list_visible',
    'browser_verify_text_visible',
    'browser_verify_value',
    'browser_wait_for',
    'browser_cookie_clear',
    'browser_localstorage_clear',
    'browser_sessionstorage_clear',
    'browser_set_storage_state',
  ]
  const playwrightServer = {
    command: process.execPath,
    args: [playwrightCli, '--config', options.playwrightConfigPath, '--secrets', options.playwrightSecretsPath],
    cwd: options.workspaceDirectory,
    env: options.mcpEnvironment,
    required: true,
    startup_timeout_sec: 60,
    tool_timeout_sec: 180,
    default_tools_approval_mode: 'approve',
    ...(!options.fullAgentAccess ? { enabled_tools: restrictedPlaywrightTools } : {}),
  }
  const codex = new Codex({
    codexPathOverride: options.codexExecutable,
    env: {
      ...options.codexEnvironment,
      CODEX_HOME: options.agentHome,
    },
    config: {
      developer_instructions: options.fullAgentAccess
        ? 'Act as the primary test engineer. Use the raw run inputs, shell, writable workspace, network, and full Playwright MCP autonomously. Follow workspace AGENTS.md. Do not edit files outside the run workspace.'
        : 'Operate only as the Auto-Test web testing agent. Follow the workspace AGENTS.md and configured MCP instructions. Do not modify source code.',
      features: {
        shell_tool: options.fullAgentAccess,
        apps: false,
        multi_agent: options.fullAgentAccess,
        remote_plugin: false,
        hooks: false,
        memories: false,
      },
      tools: { web_search: options.fullAgentAccess },
      mcp_servers: {
        playwright: playwrightServer,
        'auto-test-control': {
          command: process.execPath,
          args: [tsxCli, controlServer, options.controlConfigPath],
          cwd: options.workspaceDirectory,
          env: options.mcpEnvironment,
          required: true,
          startup_timeout_sec: 60,
          tool_timeout_sec: 60,
          default_tools_approval_mode: 'approve',
        },
      },
    },
  })
  const threadOptions = {
    ...(options.model ? { model: options.model } : {}),
    sandboxMode: options.fullAgentAccess ? 'workspace-write' : 'read-only',
    workingDirectory: options.workspaceDirectory,
    skipGitRepoCheck: true,
    modelReasoningEffort: 'xhigh',
    networkAccessEnabled: options.fullAgentAccess,
    webSearchMode: options.fullAgentAccess ? 'live' : 'disabled',
    approvalPolicy: 'never',
  } as const
  return options.threadId
    ? codex.resumeThread(options.threadId, threadOptions)
    : codex.startThread(threadOptions)
}

async function appendEvent(
  path: string,
  event: ThreadEvent,
  secrets: string[],
  receiptRecorder?: ExecutionReceiptRecorder,
): Promise<void> {
  const serialized = redactAgentValue(JSON.stringify(event), [...secrets, ...transientAgentEventValues(event)])
  await writeFile(path, `${serialized}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 })
  if (process.platform !== 'win32') await chmod(path, 0o600)
  await receiptRecorder?.observe(event)
}

async function runTurn(
  thread: AgentThread,
  input: Input,
  eventsPath: string,
  secrets: string[],
  progress: CodexTestProgressReporter,
  onThreadStarted?: (threadId: string) => Promise<void>,
  outputSchema?: unknown,
  receiptRecorder?: ExecutionReceiptRecorder,
  onUsage?: (usage: CodexTurnUsage) => Promise<void> | void,
): Promise<string> {
  const streamed = await thread.runStreamed(input, outputSchema ? { outputSchema } : undefined)
  let finalResponse = ''
  for await (const event of streamed.events) {
    await appendEvent(eventsPath, event, secrets, receiptRecorder)
    progress.observe(event)
    if (event.type === 'turn.completed') {
      const usage = (event as ThreadEvent & { usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } }).usage
      if (usage) await onUsage?.({
        inputTokens: usage.input_tokens ?? 0,
        cachedInputTokens: usage.cached_input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      })
    }
    if (event.type === 'thread.started') await onThreadStarted?.(event.thread_id)
    if (event.type === 'item.completed' && event.item.type === 'agent_message') finalResponse = event.item.text
    if (event.type === 'turn.failed') throw new Error(event.error.message)
    if (event.type === 'error' && !/^Reconnecting\.\.\. \d+\/\d+/i.test(event.message)) throw new Error(event.message)
  }
  if (!finalResponse) throw new Error('Codex test agent returned no final response')
  return finalResponse
}

function finalResultProblems(
  result: CodexTestAgentResult,
  manifest: WorkflowIntakeManifest,
  recordedEnvironmentRequirements: CodexTestEnvironmentRequirement[] = [],
  executionReceipts: CodexTestExecutionReceipt[] = [],
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
    // Receipts are passively captured audit evidence. They are validated when
    // the agent cites them, but missing optional case bookkeeping must not
    // prevent the primary Codex thread from exploring or delivering facts.
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
  return problems
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

function isOperationalBlock(message: string): boolean {
  return /usage limit|quota|credit|rate.?limit|at capacity|capacity|context (?:length|window)|maximum context|too many tokens|token limit|output limit|try a different model|\b429\b|\b5\d\d\b|bad gateway|upstream|reconnect|timed? out|timeout|connection|network|dns|certificate|tls|unauthorized|forbidden|\b401\b|\b403\b|mcp|chromium executable|spawn .*enoent|no final response/i.test(message)
}

function infrastructureBlockDetails(message: string): { reason: string; nextAction: string } {
  if (/context (?:length|window)|maximum context|too many tokens|token limit|output limit/i.test(message)) {
    return {
      reason: '当前执行 epoch 超出模型上下文或单次输出容量。',
      nextAction: '在模型 Profile 中登记准确的容量参数或切换到容量更大的模型后，使用原结果目录继续上次测试。',
    }
  }
  if (/at capacity|capacity|try a different model/i.test(message)) {
    return {
      reason: '当前模型供应商容量不足或所选模型暂时不可用。',
      nextAction: '使用 --model-profile 切换到另一个已注册的模型供应商后，使用原结果目录继续上次测试。',
    }
  }
  if (/usage limit|quota|credit|rate.?limit|\b429\b/i.test(message)) {
    return {
      reason: '模型服务额度不足或调用频率受限。',
      nextAction: '恢复或切换可用的模型 API 额度后，使用原结果目录继续上次测试。',
    }
  }
  if (/unauthorized|forbidden|\b401\b|\b403\b/i.test(message)) {
    return {
      reason: '模型或本地执行依赖的身份验证失败。',
      nextAction: '修复 Provider 或执行依赖的认证配置后，使用原结果目录继续上次测试。',
    }
  }
  if (/bad gateway|upstream|\b5\d\d\b/i.test(message)) {
    return {
      reason: '模型服务或上游接口暂时不可用。',
      nextAction: '等待模型服务恢复后，使用原结果目录继续上次测试。',
    }
  }
  if (/chromium executable|spawn .*enoent/i.test(message)) {
    return {
      reason: '浏览器或本地执行程序未正确安装，或无法启动。',
      nextAction: '运行环境检查并修复 Chromium/Codex CLI 后，使用原结果目录继续上次测试。',
    }
  }
  if (/mcp/i.test(message)) {
    return {
      reason: '浏览器控制服务（MCP）暂时不可用。',
      nextAction: '恢复 MCP 或重启 Auto-Test 运行依赖后，使用原结果目录继续上次测试。',
    }
  }
  if (/no final response/i.test(message)) {
    return {
      reason: 'Codex 本轮没有返回完整执行结果。',
      nextAction: '使用原结果目录继续同一 Codex 线程，不要重复已验证的业务写入。',
    }
  }
  if (/reconnect|timed? out|timeout|connection|network|dns|certificate|tls/i.test(message)) {
    return {
      reason: '模型、浏览器或本地网络连接中断。',
      nextAction: '恢复网络和运行依赖后，使用原结果目录继续上次测试。',
    }
  }
  return {
    reason: 'Auto-Test 的执行依赖出现异常，测试尚未完成。',
    nextAction: '查看运行诊断并修复执行依赖后，使用原结果目录继续上次测试。',
  }
}

function blockedResult(
  manifest: WorkflowIntakeManifest,
  state: CodexTestAgentState,
  message: string,
  ledger: CodexTestMutationLedgerEntry[],
  environmentRequirements: CodexTestEnvironmentRequirement[] = [],
): CodexTestAgentResult {
  const details = infrastructureBlockDetails(message)
  const result: CodexTestAgentResult = {
    version: '1.0',
    workflowId: manifest.workflowId,
    sourceSha256: manifest.source.sha256,
    outcome: 'blocked',
    summary: details.reason,
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    cases: manifest.phases.map((phase) => ({
      caseId: phase.id,
      title: phase.title,
      outcome: 'blocked',
      summary: details.reason,
      failureSource: 'infrastructure',
      failureKind: 'execution',
      evidence: [{ kind: 'observation', description: 'Execution dependency failure recorded in codex-agent.events.jsonl.' }],
    })),
    mutations: [],
    environmentRequirements,
    blockers: [details.reason],
    productDefects: [],
    nextActions: [details.nextAction],
  }
  return enforceMutationLedger(result, ledger)
}

function deliveryBlockedResult(
  manifest: WorkflowIntakeManifest,
  state: CodexTestAgentState,
  message: string,
  ledger: CodexTestMutationLedgerEntry[],
  environmentRequirements: CodexTestEnvironmentRequirement[],
): CodexTestAgentResult {
  return enforceMutationLedger({
    version: '1.0',
    workflowId: manifest.workflowId,
    sourceSha256: manifest.source.sha256,
    outcome: 'blocked',
    summary: 'Codex completed the execution turn but did not produce a complete evidence-based delivery result.',
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    cases: manifest.phases.map((phase) => ({
      caseId: phase.id,
      title: phase.title,
      outcome: 'blocked',
      summary: message,
      failureSource: 'agent_execution',
      failureKind: 'execution',
      evidence: [{ kind: 'observation', description: 'Structured delivery validation did not complete.' }],
    })),
    mutations: [],
    environmentRequirements,
    blockers: [message],
    productDefects: [],
    nextActions: ['Resume the same Codex thread and complete the structured evidence-based result without repeating verified writes.'],
  }, ledger)
}

async function readMutationLedger(path: string): Promise<CodexTestMutationLedgerEntry[]> {
  return JSON.parse(await readFile(path, 'utf8')) as CodexTestMutationLedgerEntry[]
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
    summary: `Codex adaptive execution completed ${cases.length} cases: ${counts.passed} passed, ${counts.productFailed} product-failed, ${counts.blocked} blocked.`,
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
  workspace: CodexAgentWorkspace,
  epoch: CodexExecutionEpoch,
): Promise<void> {
  const config = JSON.parse(await readFile(workspace.controlConfigPath, 'utf8')) as CodexTestControlConfig
  await writePrivateJson(workspace.controlConfigPath, { ...config, activeCaseIds: epoch.caseIds })
  await writePrivateJson(resolve(workspace.workspaceDirectory, 'active-execution-epoch.json'), epoch)
}

function epochResultPath(workspace: CodexAgentWorkspace, epoch: CodexExecutionEpoch): string {
  return resolve(workspace.privateDirectory, 'execution-epochs', `${epoch.id}.result.json`)
}

function epochDeliveryPath(workspace: CodexAgentWorkspace, epoch: CodexExecutionEpoch): string {
  return resolve(workspace.workspaceDirectory, `case-results.${epoch.id}.json`)
}

function imagePathsForExecutionEpoch(workspace: CodexAgentWorkspace, manifest: WorkflowIntakeManifest): string[] {
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

export async function runCodexTestAgent(
  options: CodexTestAgentOptions,
  dependencies: CodexTestAgentDependencies = {},
): Promise<CodexTestAgentRun> {
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
    const { resultPath: _resultPath, outcome: _outcome, error: _error, ...unfinishedState } = state
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
  let activeThread: AgentThread | undefined
  const progress = new CodexTestProgressReporter(options.onProgress, options.progressHeartbeatMs)
  await writePrivateJson(statePath, state)
  const redactionSecrets = secretValues(options.secrets)
  try {
    progress.report('stage', options.resume
      ? '正在恢复原 Codex 线程、浏览器会话和 Mutation Ledger'
      : '正在检查 Chromium 并准备隔离测试工作区')
    progress.startHeartbeat()
    const browserExecutablePath = dependencies.browserExecutablePath ?? chromium.executablePath()
    if (!options.resume) {
      await access(browserExecutablePath).catch(() => {
        throw new Error(`Chromium executable is unavailable: ${browserExecutablePath}. Run Playwright browser installation first.`)
      })
    }
    const workspace = await prepareCodexAgentWorkspace({
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
      sourceCodexHome: options.codexHome ?? process.env.CODEX_HOME ?? process.env.AUTO_TEST_CODEX_HOME ?? resolve(process.env.HOME ?? '.', '.codex'),
      environment: process.env,
      testDataAccess: options.testDataAccess ?? 'direct',
      ...(options.resume ? { resume: true } : {}),
      ...(options.modelProfile ? { modelProfile: options.modelProfile } : {}),
    })
    mutationLedgerPath = workspace.mutationLedgerPath
    environmentRequirementsPath = workspace.environmentRequirementsPath
    executionReceiptsPath = workspace.executionReceiptsPath
    await reconcileEnvironmentRequirements(environmentRequirementsPath, options.profile.origins)
    if (options.resume) {
      const ledger = await readMutationLedger(workspace.mutationLedgerPath)
      if (!ledger.some((entry) => entry.status === 'pending')) {
        const recovered = await recoverCodexDeliveryResult({
          artifactPath: workspace.caseResultsPath,
          manifest: options.manifest,
          startedAt: state.startedAt,
        })
        if (recovered.result) {
          const environmentRequirements = await reconcileEnvironmentRequirementCaseLinks(
            workspace.environmentRequirementsPath,
            recovered.result.cases,
          )
          const executionReceipts = await readExecutionReceipts(workspace.executionReceiptsPath)
          const recoveryProblems = finalResultProblems(
            recovered.result,
            options.manifest,
            environmentRequirements,
            executionReceipts,
          )
          if (recoveryProblems.length === 0) {
            const result = enforceMutationLedger(
              enforceEnvironmentRequirements(recovered.result, environmentRequirements),
              ledger,
            )
            await writePrivateJson(resultPath, result)
            progress.report('stage', `已有逐 case 交付通过确定性校验，无需再次启动浏览器或 Codex：${result.outcome}`)
            state = updateCodexTestState(state, {
              status: 'completed',
              stage: 'completed',
              outcome: result.outcome,
              resultPath,
              finishedAt: new Date().toISOString(),
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
    progress.report('stage', '隔离测试工作区已准备，正在启动 Codex 测试线程')
    const activeCodexExecutable = await resolveCodexExecutable(options)
    const threadOptions = {
      workspaceDirectory: workspace.workspaceDirectory,
      agentHome: workspace.agentHome,
      ...(options.model ? { model: options.model } : {}),
      codexExecutable: activeCodexExecutable,
      playwrightConfigPath: workspace.playwrightConfigPath,
      playwrightSecretsPath: workspace.playwrightSecretsPath,
      controlConfigPath: workspace.controlConfigPath,
      codexEnvironment: workspace.codexEnvironment,
      mcpEnvironment: workspace.mcpEnvironment,
      fullAgentAccess: (options.testDataAccess ?? 'direct') === 'direct',
    }
    const fullAgentAccess = (options.testDataAccess ?? 'direct') === 'direct'
    const resultDirectory = caseResultDirectory(outputDirectory)
    const existingRecords = await readCaseResultRecords(resultDirectory, options.manifest)
    const completedCaseIds = new Set([
      ...state.completedCaseIds,
      ...existingRecords.map((record) => record.result.caseId),
    ])
    const capacity = capacityForModelProfile(options.modelProfile)
    let epochs = buildCodexExecutionEpochs(options.manifest, capacity, completedCaseIds)
    const activePendingCaseIds = options.resume && state.activeEpoch?.stage === 'finalizing'
      ? state.activeEpoch?.caseIds.filter((caseId) => !completedCaseIds.has(caseId)) ?? []
      : []
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

    let thread: AgentThread | undefined
    let threadId = state.threadId ?? resumeThreadId
    const startThread = dependencies.startThread ?? ((input) => startSdkThread(input))
    const resumeThread = dependencies.resumeThread ?? ((input) => startSdkThread(input))
    const checkpointDirectory = resolve(workspace.privateDirectory, 'checkpoints')

    for (const epoch of epochs) {
      if (epoch.caseIds.every((caseId) => completedCaseIds.has(caseId))) continue
      const scopedManifest = manifestForExecutionEpoch(options.manifest, epoch)
      const deliveryPath = epochDeliveryPath(workspace, epoch)
      await activateExecutionEpoch(workspace, epoch)
      const resumingEpoch = options.resume && state.activeEpoch?.id === epoch.id
      const initialEpochStage = resumingEpoch ? state.activeEpoch!.stage : 'executing'
      const epochThreadId = resumingEpoch ? state.activeEpoch?.threadId ?? threadId : undefined
      thread = epochThreadId
        ? resumeThread({ threadId: epochThreadId, ...threadOptions })
        : startThread(threadOptions)
      activeThread = thread
      threadId = epochThreadId ?? threadId
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
        ...(!epochThreadId ? { threadGeneration: state.threadGeneration + 1 } : {}),
        activeEpoch: {
          id: epoch.id,
          index: epoch.index,
          total: epoch.total,
          caseIds: epoch.caseIds,
          stage: initialEpochStage,
          ...(epochThreadId ? { threadId: epochThreadId } : {}),
        },
        ...(epochThreadId ? { threadId: epochThreadId } : {}),
      })
      await writePrivateJson(statePath, state)
      const receiptRecorder = await ExecutionReceiptRecorder.create(workspace.executionReceiptsPath, epoch.caseIds, epoch.id)
      const recordUsage = async (usage: CodexTurnUsage): Promise<void> => {
        epochUsage.inputTokens = usage.inputTokens
        epochUsage.cachedInputTokens = usage.cachedInputTokens
        epochUsage.outputTokens = usage.outputTokens
        state = updateCodexTestState(state, { lastUsage: { ...epochUsage } })
        await writePrivateJson(statePath, state)
      }

      if (initialEpochStage === 'executing') {
        progress.report('stage', `正在执行 epoch ${epoch.index + 1}/${epoch.total}（${epoch.caseIds.length} 条，thread generation ${state.threadGeneration}）`)
        const input: Input = resumingEpoch
          ? [{ type: 'text', text: codexTestAgentResumePrompt(fullAgentAccess, epoch, deliveryPath) }]
          : [
              { type: 'text', text: codexTestAgentPrompt({
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
              }) },
              ...imagePathsForExecutionEpoch(workspace, scopedManifest).map((path) => ({ type: 'local_image' as const, path })),
            ]
        await runTurn(thread, input, eventsPath, redactionSecrets, progress, persistThreadId, undefined, receiptRecorder, recordUsage)
        state = updateCodexTestState(state, {
          stage: 'finalizing',
          activeEpoch: { ...state.activeEpoch!, stage: 'finalizing', ...(thread.id ? { threadId: thread.id } : {}) },
          ...(thread.id ? { threadId: thread.id } : {}),
        })
        await writePrivateJson(statePath, state)
      } else {
        progress.report('stage', `正在恢复 epoch ${epoch.id} 的结构化交付，不重复业务执行`)
      }

      const ledgerBeforeFinalization = await readMutationLedger(workspace.mutationLedgerPath)
      if (ledgerBeforeFinalization.some((entry) => entry.status === 'pending')) {
        progress.report('stage', `epoch ${epoch.id} 存在未核销业务写入，正在由同一线程恢复核对`)
        await runTurn(
          thread,
          [{ type: 'text', text: codexTestAgentResumePrompt(fullAgentAccess, epoch, deliveryPath) }],
          eventsPath,
          redactionSecrets,
          progress,
          persistThreadId,
          undefined,
          receiptRecorder,
          recordUsage,
        )
      }

      let epochResult: CodexTestAgentResult | undefined
      let deliveryProblems: string[] = []
      const maxFinalizationTurns = options.maxFinalizationTurns ?? 2
      for (let turn = 0; turn <= maxFinalizationTurns; turn++) {
        if (turn > 0) progress.report('stage', `epoch ${epoch.id} 的结构化交付仍有 ${deliveryProblems.length} 项问题，正在修正`)
        const prompt = turn === 0
          ? codexTestAgentFinalPrompt(epoch)
          : `${codexTestAgentFinalPrompt(epoch)}\n\nThe previous result had these deterministic contract problems:\n- ${deliveryProblems.join('\n- ')}\nCorrect only this epoch from existing evidence. Do not repeat business writes.`
        try {
          const finalResponse = await runTurn(
            thread,
            [{ type: 'text', text: prompt }],
            eventsPath,
            redactionSecrets,
            progress,
            persistThreadId,
            codexTestResultSchema,
            receiptRecorder,
            recordUsage,
          )
          const candidate = parseCodexTestResult(finalResponse)
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
          deliveryProblems = finalResultProblems(normalized, scopedManifest, scopedRequirements, executionReceipts)
          if (deliveryProblems.length > 0) continue
          epochResult = enforceMutationLedger(enforceEnvironmentRequirements(normalized, scopedRequirements), await readMutationLedger(workspace.mutationLedgerPath))
          break
        } catch (error) {
          const message = redactAgentValue(error instanceof Error ? error.message : String(error), redactionSecrets)
          deliveryProblems = [message]
          if (isOperationalBlock(message) && !await access(deliveryPath).then(() => true, () => false)) throw error
          if (isOperationalBlock(message)) break
        }
      }

      if (!epochResult) {
        const ledger = await readMutationLedger(workspace.mutationLedgerPath)
        const recovered = await recoverCodexDeliveryResult({ artifactPath: deliveryPath, manifest: scopedManifest, startedAt: state.startedAt })
        if (recovered.result) {
          const requirements = await reconcileEnvironmentRequirementCaseLinks(
            workspace.environmentRequirementsPath,
            recovered.result.cases,
          )
          const scopedRequirements = environmentRequirementsForCases(requirements, epoch.caseIds)
          const executionReceipts = await readExecutionReceipts(workspace.executionReceiptsPath)
          const normalized = { ...recovered.result, environmentRequirements: scopedRequirements }
          const problems = finalResultProblems(normalized, scopedManifest, scopedRequirements, executionReceipts)
          epochResult = problems.length === 0
            ? enforceMutationLedger(enforceEnvironmentRequirements(normalized, scopedRequirements), ledger)
            : deliveryBlockedResult(scopedManifest, state, problems.join('; '), ledger, scopedRequirements)
        } else {
          const requirements = await readJsonOr<CodexTestEnvironmentRequirement[]>(workspace.environmentRequirementsPath, [])
          epochResult = deliveryBlockedResult(scopedManifest, state, deliveryProblems.join('; ') || recovered.problems.join('; ') || `epoch ${epoch.id} 没有可验证的结构化交付`, ledger, environmentRequirementsForCases(requirements, epoch.caseIds))
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
        const result = enforceMutationLedger(enforceEnvironmentRequirements(aggregateCaseResults({ manifest: options.manifest, caseResults: cases, requirements, startedAt: state.startedAt }), requirements), ledger)
        await writePrivateJson(resultPath, result)
        await writePrivateJson(workspace.caseResultsPath, deliveryArtifactFromResult(result))
        state = updateCodexTestState(state, { status: 'completed', stage: 'completed', outcome: 'blocked', resultPath, finishedAt: new Date().toISOString() })
        await writePrivateJson(statePath, state)
        return { state, result }
      }

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
      progress.report('stage', `epoch ${epoch.id} 已完成，累计 ${completedCaseIds.size}/${options.manifest.phases.length} 条`)

      if (epoch.index < epochs.length - 1) {
        const checkpointPath = resolve(checkpointDirectory, `${epoch.id}.json`)
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
        progress.report('stage', `正在保存 ${epoch.id} 的 Codex 工作记忆 checkpoint`)
        await runTurn(thread, [{ type: 'text', text: codexTestAgentCheckpointPrompt(epoch, checkpointPath) }], eventsPath, redactionSecrets, progress, persistThreadId, undefined, receiptRecorder, recordUsage)
        const { activeEpoch: _checkpointedEpoch, ...checkpointedState } = state
        state = updateCodexTestState(checkpointedState, { stage: 'executing', checkpointPath })
        await writePrivateJson(statePath, state)
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
      const problems = finalResultProblems(result, options.manifest, requirements, await readExecutionReceipts(workspace.executionReceiptsPath))
      if (problems.length > 0) throw new Error(`Adaptive epoch aggregation failed deterministic validation: ${problems.join('; ')}`)
    } catch (error) {
      result = deliveryBlockedResult(options.manifest, state, error instanceof Error ? error.message : String(error), ledger, requirements)
    }
    await writePrivateJson(resultPath, result)
    await writePrivateJson(workspace.caseResultsPath, deliveryArtifactFromResult(result))
    state = updateCodexTestState(state, {
      status: 'completed',
      stage: 'completed',
      outcome: result.outcome,
      resultPath,
      finishedAt: new Date().toISOString(),
      completedCaseIds: [...completedCaseIds],
      ...(threadId ? { threadId } : {}),
    })
    await writePrivateJson(statePath, state)
    progress.report('stage', `全部 ${epochs.length} 个执行 epoch 已完成：${result.outcome}`)
    return { state, result }
  } catch (error) {
    const message = redactAgentValue(error instanceof Error ? error.message : String(error), redactionSecrets)
    if (isOperationalBlock(message)) {
      progress.report('warning', '模型、浏览器、MCP 或本地网络暂时不可用，正在保存可恢复的 blocked 结果')
      const ledger = mutationLedgerPath ? await readMutationLedger(mutationLedgerPath).catch(() => []) : []
      const environmentRequirements = environmentRequirementsPath
        ? await readJsonOr<CodexTestEnvironmentRequirement[]>(environmentRequirementsPath, [])
        : []
      const result = blockedResult(options.manifest, state, message, ledger, environmentRequirements)
      await writePrivateJson(resultPath, result)
      state = updateCodexTestState(state, {
        status: 'completed', stage: 'completed', outcome: 'blocked', resultPath, finishedAt: new Date().toISOString(),
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
    progress.close()
  }
}
