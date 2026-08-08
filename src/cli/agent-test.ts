#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgentTest } from '../agent/runner.js'
import { limitManifestToCases } from '../agent/execution-epochs.js'
import { assessAgentIntakeReadiness } from '../agent/intake-readiness.js'
import { readEnvironmentRequirements } from '../agent/environment-requirements.js'
import { writeResultWorkbook } from '../agent/result-workbook.js'
import { isBuiltInAgentHostId } from '../agent/host-registry.js'
import type { AgentHostId } from '../agent/host.js'
import { initialCodexTestState, updateCodexTestState, writePrivateJson } from '../agent/state.js'
import type { CodexTestAgentResult, CodexTestFailureKind } from '../agent/types.js'
import { redactSensitiveContent, redactSensitiveText } from '../input/text.js'
import { ensureEnvironmentAuthentication } from '../workflow/auth-broker.js'
import {
  defaultEnvironmentProfileRegistryPath,
  loadEnvironmentProfileContext,
  loadEnvironmentProfileRegistry,
  loadEnvironmentProfileSecrets,
  selectEnvironmentProfile,
} from '../workflow/environment-profile.js'
import {
  defaultModelProfileRegistryPath,
  hasModelProfileEnvironment,
  loadModelProfileRegistry,
  modelProfileEnvironmentNames,
  parseModelProfile,
  resolveModelProfileEnvironment,
  resolveModelProfileRequest,
  selectConfiguredModelProfile,
  shouldPreserveSourceModelProviderOnResume,
  type ModelProfile,
} from '../workflow/model-profile.js'
import { discoverWorkflowInputBundle } from '../workflow/input-bundle.js'
import { workflowSecretEnvironment } from '../workflow/intake-secrets.js'
import { intakeWorkflowXlsx } from '../workflow/intake.js'
import { environmentTargetUrls } from '../workflow/target-urls.js'
import type { EnvironmentProfile } from '../workflow/environment-profile.js'
import type { WorkflowIntakeManifest } from '../workflow/types.js'

export interface AgentTestCliOptions {
  filePath: string
  urls: string[]
  images: string[]
  briefPath?: string
  profileId?: string
  profileRegistryPath: string
  outputDirectory: string
  model?: string
  headed: boolean
  slowMo?: number
  maxIterations?: number
  maxFinalizationTurns?: number
  caseLimit?: number
  resume?: boolean
  testDataAccess: 'direct' | 'opaque'
  modelProfileId?: string
  modelProfileRegistryPath: string
  agentHostId?: AgentHostId
  agentExecutable?: string
  agentSourceHome?: string
}

interface AgentEnvironmentSelection {
  profileId: string
  origins: string[]
  policy: EnvironmentProfile['policy']
  authenticatedOrigins: string[]
  /** Digest of the exact run-scoped test/auth values without persisting them. */
  testDataSha256: string
  testDataAccess?: 'direct' | 'opaque'
}

interface InputBundleIdentity {
  briefSha256: string
  imageSha256s: string[]
  bundleSha256: string
}

function inputBundleIdentity(bundle: Awaited<ReturnType<typeof discoverWorkflowInputBundle>>): InputBundleIdentity {
  const imageSha256s = [...bundle.imageSha256s].sort()
  const canonical = JSON.stringify({ briefSha256: bundle.briefSha256, imageSha256s })
  return {
    briefSha256: bundle.briefSha256,
    imageSha256s,
    bundleSha256: createHash('sha256').update(canonical).digest('hex'),
  }
}

function sameInputBundleIdentity(left: InputBundleIdentity, right: InputBundleIdentity): boolean {
  return left.bundleSha256 === right.bundleSha256 &&
    left.briefSha256 === right.briefSha256 &&
    JSON.stringify([...left.imageSha256s].sort()) === JSON.stringify([...right.imageSha256s].sort())
}

function testDataIdentitySha256(secrets: Record<string, string | string[]>): string {
  const entries = Object.entries(secrets)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => [name, Array.isArray(value) ? [...value] : value])
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

function testDataSecrets(
  secrets: Record<string, string | string[]>,
  profile: EnvironmentProfile,
): Record<string, string | string[]> {
  const authenticationRefs = new Set(profile.auth.flatMap((adapter) => adapter.login
    ? [adapter.login.usernameSecretRef, adapter.login.passwordSecretRef]
    : []))
  return Object.fromEntries(Object.entries(secrets).filter(([name]) => !authenticationRefs.has(name)))
}

function timestamp(): string {
  const now = new Date()
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
}

function defaultAgentRunDirectory(filePath: string): string {
  const stem = basename(filePath, extname(filePath)).replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 48) || 'workflow'
  return resolve('artifacts', 'runs', `${timestamp()}-${stem}-${Date.now().toString(36).slice(-5)}`)
}

function help(): string {
  return [
    '用法:',
    '  npm run agent:test -- --file <cases.xlsx> --url <url> [--url <url> ...] [选项]',
    '',
    '输入与环境:',
    '  --file <path>               测试用例 Excel',
    '  --url <url>                 新 Run 的目标网站，可重复；Excel 中的其他链接仅作为材料上下文',
    '  --image <path>              补充截图，可重复',
    '  --brief <path>              测试工程师补充说明',
    '  --profile <id>              指定已注册环境；省略时必须恰好匹配一个环境',
    `  --profile-registry <path>   环境注册表，默认 ${defaultEnvironmentProfileRegistryPath()}`,
    '',
    '执行:',
    '  --agent-host <codex|omp>   选择测试代理宿主，默认 codex；两者遵守同一测试结果合同',
    '  --agent-bin <path>         当前宿主的可执行文件；也可设置 AUTO_TEST_AGENT_BIN',
    '  --agent-home <path>        当前宿主的原生 provider/auth 源目录；运行仍使用隔离副本',
    '  --output-dir <path>         本次运行目录',
    '  --model <id>                当前 AgentHost 使用的模型（由 Codex/OMP 各自配置解释）',
    '  --headed | --headless       显示或隐藏浏览器，默认 headless',
    '  --slow-mo <ms>              浏览器动作减速',
    '  --max-iterations <count>    列表型数据最多执行 N 条',
    '  --max-finalization-turns N  结果契约修复轮数，默认 2',
    '  --case-limit <count>        只执行输入材料中的前 N 条 case；--one 是它的快捷方式',
    '  --codex-bin/--omp-bin       --agent-bin 的兼容别名，并同时选择对应内置宿主',
    '  --codex-home/--omp-home     --agent-home 的兼容别名，并同时选择对应内置宿主',
    '  --model-profile <id>        选择模型供应商 Profile；默认 deepseek，内置 deepseek/volcengine，也支持自定义注册表',
    `  --model-profile-registry <path>  模型 Profile 注册表，默认 ${defaultModelProfileRegistryPath()}`,
    '  --opaque-test-data          启用旧的受限模式：不提供原始工作簿/测试值，禁用 shell、网络和完整 Playwright',
    '  --resume                    恢复同一输出目录中的逻辑 Run、active epoch 与 Mutation Ledger',
  ].join('\n')
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} 必须提供取值`)
  return value
}

function valuesAfter(args: string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== name) continue
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} 必须提供取值`)
    values.push(value)
  }
  return values
}

function positiveInteger(args: string[], name: string): number | undefined {
  const raw = valueAfter(args, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`)
  return value
}

function nonNegativeInteger(args: string[], name: string): number | undefined {
  const raw = valueAfter(args, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数`)
  return value
}

export function parseAgentTestArgs(args: string[]): AgentTestCliOptions {
  if (args.includes('--help') || args.includes('-h')) throw new Error(help())
  const filePath = valueAfter(args, '--file')
  if (!filePath) throw new Error('必须提供 --file')
  if (extname(filePath).toLowerCase() !== '.xlsx') throw new Error('--file 必须是 .xlsx 文件')
  if (args.includes('--headed') && args.includes('--headless')) throw new Error('--headed 与 --headless 不能同时使用')
  const maxIterations = positiveInteger(args, '--max-iterations')
  const maxFinalizationTurns = positiveInteger(args, '--max-finalization-turns')
  if (args.includes('--one') && args.includes('--case-limit')) throw new Error('--one 与 --case-limit 不能同时使用')
  const caseLimit = args.includes('--one') ? 1 : positiveInteger(args, '--case-limit')
  const urls = valuesAfter(args, '--url')
  if (!args.includes('--resume') && urls.length === 0) {
    throw new Error('新 AgentHost Run 必须至少提供一个 --url；Excel 中的链接仅作为测试材料上下文')
  }
  const slowMo = nonNegativeInteger(args, '--slow-mo')
  const cliHost = valueAfter(args, '--agent-host')
  // A resume must inherit the frozen host from the run state unless the user
  // explicitly supplies a host or host-specific executable. Ambient defaults
  // must not silently switch an OMP run back to Codex (or vice versa).
  const ambientHost = process.env.AUTO_TEST_AGENT_HOST?.trim() || undefined
  const explicitHost = cliHost ?? (args.includes('--resume') ? undefined : ambientHost)
  const agentBin = valueAfter(args, '--agent-bin')
  const agentHome = valueAfter(args, '--agent-home')
  const codexBin = valueAfter(args, '--codex-bin')
  const codexHome = valueAfter(args, '--codex-home')
  const ompBin = valueAfter(args, '--omp-bin')
  const ompHome = valueAfter(args, '--omp-home')
  if (agentBin && (codexBin || ompBin)) throw new Error('--agent-bin 不能与 --codex-bin 或 --omp-bin 同时使用')
  if (agentHome && (codexHome || ompHome)) throw new Error('--agent-home 不能与 --codex-home 或 --omp-home 同时使用')
  if ((codexBin || codexHome) && (ompBin || ompHome)) throw new Error('Codex 专用参数不能与 OMP 专用参数同时使用')
  let binHost: 'codex' | 'omp' | undefined
  if (ompBin || ompHome) binHost = 'omp'
  else if (codexBin || codexHome) binHost = 'codex'
  if (explicitHost && binHost && explicitHost !== binHost) throw new Error('--agent-host 与宿主专用可执行文件参数不一致')
  const requestedHost = explicitHost ?? binHost ?? 'codex'
  if (!isBuiltInAgentHostId(requestedHost)) throw new Error(`--agent-host 只支持 codex 或 omp，收到：${requestedHost}`)
  const resolvedFilePath = resolve(filePath)
  return {
    filePath: resolvedFilePath,
    urls,
    images: valuesAfter(args, '--image').map((path) => resolve(path)),
    ...(valueAfter(args, '--brief') ? { briefPath: resolve(valueAfter(args, '--brief')!) } : {}),
    ...(valueAfter(args, '--profile') ? { profileId: valueAfter(args, '--profile')! } : {}),
    profileRegistryPath: resolve(valueAfter(args, '--profile-registry') ?? defaultEnvironmentProfileRegistryPath()),
    outputDirectory: resolve(valueAfter(args, '--output-dir') ?? defaultAgentRunDirectory(resolvedFilePath)),
    ...(valueAfter(args, '--model') ? { model: valueAfter(args, '--model')! } : {}),
    headed: args.includes('--headed'),
    resume: args.includes('--resume'),
    testDataAccess: args.includes('--opaque-test-data') ? 'opaque' : 'direct',
    ...(slowMo !== undefined ? { slowMo } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(maxFinalizationTurns !== undefined ? { maxFinalizationTurns } : {}),
    ...(caseLimit !== undefined ? { caseLimit } : {}),
    ...((explicitHost || binHost || !args.includes('--resume')) ? { agentHostId: requestedHost } : {}),
    ...(agentBin || codexBin || ompBin ? { agentExecutable: resolve((agentBin ?? codexBin ?? ompBin)!) } : {}),
    ...(agentHome || codexHome || ompHome ? { agentSourceHome: resolve((agentHome ?? codexHome ?? ompHome)!) } : {}),
    ...(valueAfter(args, '--model-profile') ? { modelProfileId: valueAfter(args, '--model-profile')! } : {}),
    modelProfileRegistryPath: resolve(valueAfter(args, '--model-profile-registry') ?? defaultModelProfileRegistryPath()),
  }
}

function sameSecret(left: string | string[], right: string | string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export interface RecordedModelSelection {
  id?: string
  model?: string
  profile?: ModelProfile
}

export function parseRecordedModelSelection(content: string): RecordedModelSelection {
  const parsed = JSON.parse(content) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('模型选择记录必须是对象')
  }
  const record = parsed as Record<string, unknown>
  const id = record.id
  const model = record.model
  if (id !== undefined && (typeof id !== 'string' || id.trim() === '')) {
    throw new Error('模型选择记录的 id 无效')
  }
  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    throw new Error('模型选择记录的 model 无效')
  }
  let profile: ModelProfile | undefined
  if (record.profile !== undefined) {
    profile = parseModelProfile(record.profile)
  } else if (
    typeof id === 'string' && typeof model === 'string' &&
    typeof record.providerId === 'string' && typeof record.baseUrl === 'string' &&
    typeof record.envKey === 'string' && (record.api !== undefined || record.wireApi !== undefined)
  ) {
    profile = parseModelProfile({
      id,
      model,
      providerId: record.providerId,
      baseUrl: record.baseUrl,
      envKey: record.envKey,
      ...(record.api !== undefined ? { api: record.api } : {}),
      ...(record.wireApi !== undefined ? { wireApi: record.wireApi } : {}),
    })
  }
  if (profile && typeof id === 'string' && profile.id !== id) {
    throw new Error('模型选择记录的 profile.id 与 id 不一致')
  }
  if (id === undefined && model === undefined && !profile) {
    throw new Error('模型选择记录缺少 id 或 model')
  }
  const recordedId = typeof id === 'string' ? id : profile?.id
  const recordedModel = typeof model === 'string' ? model : profile?.model
  return {
    ...(recordedId !== undefined ? { id: recordedId } : {}),
    ...(recordedModel !== undefined ? { model: recordedModel } : {}),
    ...(profile ? { profile } : {}),
  }
}

export function mergeAgentSecrets(
  profileSecrets: Record<string, string | string[]>,
  intakeSecrets: Record<string, string | string[]>,
  requiredRefs?: Iterable<string>,
): Record<string, string | string[]> {
  const refs = new Set(requiredRefs ?? [...Object.keys(profileSecrets), ...Object.keys(intakeSecrets)])
  const result: Record<string, string | string[]> = {}
  for (const secretRef of refs) {
    const profileValue = profileSecrets[secretRef]
    const intakeValue = intakeSecrets[secretRef]
    if (profileValue !== undefined && intakeValue !== undefined && !sameSecret(profileValue, intakeValue)) {
      throw new Error(`环境与测试用例为 secretRef ${secretRef} 提供了不同值；请消除歧义后重试`)
    }
    const value = intakeValue ?? profileValue
    if (value === undefined) throw new Error(`缺少测试所需 secretRef：${secretRef}`)
    result[secretRef] = value
  }
  return result
}

export function scopeEnvironmentProfile(
  profile: EnvironmentProfile,
  manifest: WorkflowIntakeManifest,
  additionalOrigins: string[] = [],
): EnvironmentProfile {
  const origins = new Set([
    ...environmentTargetUrls(manifest).map((url) => new URL(url).origin),
    ...additionalOrigins.map((origin) => new URL(origin).origin),
  ])
  return {
    ...profile,
    origins: profile.origins.filter((origin) => origins.has(origin)),
    auth: profile.auth.filter((adapter) => origins.has(adapter.origin)),
  }
}

function originSet(origins: string[]): Set<string> {
  return new Set(origins.map((origin) => new URL(origin).origin))
}

function isAppendOnlyOrigins(previous: string[], current: string[]): boolean {
  const next = originSet(current)
  return [...originSet(previous)].every((origin) => next.has(origin))
}

function isAppendOnlyEnvironmentSelection(
  previous: AgentEnvironmentSelection,
  current: AgentEnvironmentSelection,
): boolean {
  return previous.profileId === current.profileId &&
    JSON.stringify(previous.policy) === JSON.stringify(current.policy) &&
    (previous.testDataSha256 === undefined || previous.testDataSha256 === current.testDataSha256) &&
    (previous.testDataAccess === undefined || previous.testDataAccess === current.testDataAccess) &&
    isAppendOnlyOrigins(previous.origins, current.origins) &&
    isAppendOnlyOrigins(previous.authenticatedOrigins, current.authenticatedOrigins)
}

function requiredSecretRefs(manifest: WorkflowIntakeManifest, profile: EnvironmentProfile): Set<string> {
  return new Set([
    ...manifest.phases.flatMap((phase) => phase.secretBindings.map((binding) => binding.secretRef)),
    ...profile.auth.flatMap((adapter) => adapter.login
      ? [adapter.login.usernameSecretRef, adapter.login.passwordSecretRef]
      : []),
  ])
}

async function persistAssets(
  outputDirectory: string,
  assets: Awaited<ReturnType<typeof intakeWorkflowXlsx>>['assets'],
): Promise<string[]> {
  const mediaDirectory = resolve(outputDirectory, 'media')
  await mkdir(mediaDirectory, { recursive: true, mode: 0o700 })
  const index: Array<{ id: string; sourceFileName: string; path: string; sha256: string }> = []
  for (const asset of assets) {
    const extension = extname(asset.metadata.fileName).toLowerCase()
    const path = resolve(mediaDirectory, `${asset.metadata.id}${extension}`)
    await writeFile(path, asset.content, { mode: 0o600 })
    if (process.platform !== 'win32') await chmod(path, 0o600)
    index.push({ id: asset.metadata.id, sourceFileName: basename(asset.metadata.fileName), path, sha256: asset.metadata.sha256 })
  }
  await writePrivateJson(resolve(outputDirectory, 'media-index.json'), index)
  return index.map((item) => item.path)
}

type PreExecutionBlockClassification =
  | { failureSource: 'input'; failureKind: Extract<CodexTestFailureKind, 'data' | 'validation'> }
  | { failureSource: 'environment'; failureKind: Extract<CodexTestFailureKind, 'authentication' | 'data' | 'environment'> }
  | { failureSource: 'infrastructure'; failureKind: Extract<CodexTestFailureKind, 'execution'> }

const preExecutionBlockCopy: Record<PreExecutionBlockClassification['failureSource'], {
  summary: string
  nextAction: string
}> = {
  input: {
    summary: '测试在浏览器执行前被输入资料问题阻断。',
    nextAction: '修正 Excel 与同名 .auto-test sidecar 输入包后，使用新结果目录开始测试。',
  },
  environment: {
    summary: '测试在浏览器执行前被目标环境条件阻断。',
    nextAction: '补充或修复所列环境条件后，使用同一 Excel 和环境 Profile 重新执行。',
  },
  infrastructure: {
    summary: '测试在浏览器执行前被执行基础设施阻断。',
    nextAction: '修复模型 Provider 或 AgentHost 配置与可用性后，使用同一 Excel 和环境 Profile 重新执行。',
  },
}

export function createPreExecutionBlockedResult(
  manifest: WorkflowIntakeManifest,
  message: string,
  classification: PreExecutionBlockClassification,
): CodexTestAgentResult {
  const now = new Date().toISOString()
  const copy = preExecutionBlockCopy[classification.failureSource]
  return {
    version: '1.0',
    workflowId: manifest.workflowId,
    sourceSha256: manifest.source.sha256,
    outcome: 'blocked',
    summary: copy.summary,
    startedAt: now,
    finishedAt: now,
    cases: manifest.phases.map((phase) => ({
      caseId: phase.id,
      title: phase.title,
      outcome: 'blocked',
      summary: message,
      failureSource: classification.failureSource,
      failureKind: classification.failureKind,
      evidence: [{ kind: 'observation', description: 'Pre-execution validation did not permit browser execution.' }],
    })),
    mutations: [],
    environmentRequirements: [],
    blockers: [message],
    productDefects: [],
    nextActions: [copy.nextAction],
  }
}

async function writeResultWorkbookDelivery(options: {
  outputDirectory: string
  sourceFilePath: string
  manifest: WorkflowIntakeManifest
  result: CodexTestAgentResult
}): Promise<string> {
  const artifact = await writeResultWorkbook(options)
  const statePath = resolve(options.outputDirectory, 'codex-agent.state.json')
  const state = JSON.parse(await readFile(statePath, 'utf8')) as ReturnType<typeof initialCodexTestState>
  await writePrivateJson(statePath, updateCodexTestState(state, { resultWorkbookPath: artifact.path }))
  return artifact.path
}

async function writePreExecutionBlock(
  outputDirectory: string,
  sourceFilePath: string,
  manifest: WorkflowIntakeManifest,
  error: unknown,
  classification: PreExecutionBlockClassification,
  agentHostId: AgentHostId,
): Promise<number> {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error))
  const resultPath = resolve(outputDirectory, 'codex-agent.result.json')
  const statePath = resolve(outputDirectory, 'codex-agent.state.json')
  const result = createPreExecutionBlockedResult(manifest, message, classification)
  await writePrivateJson(resultPath, result)
  const state = updateCodexTestState(initialCodexTestState(manifest.workflowId, manifest.source.sha256), {
    status: 'completed',
    stage: 'completed',
    outcome: 'blocked',
    agentHost: agentHostId,
    resultPath,
    finishedAt: result.finishedAt,
  })
  await writePrivateJson(statePath, state)
  const workbookPath = await writeResultWorkbookDelivery({ outputDirectory, sourceFilePath, manifest, result })
  console.log(`测试结果：blocked`)
  console.log(`阻断原因：${message}`)
  console.log(`结果文件：${resultPath}`)
  console.log(`测试用例结果文件：${workbookPath}`)
  return 3
}

export async function runAgentTestCli(options: AgentTestCliOptions): Promise<number> {
  process.umask(0o027)
  if (!options.resume && options.urls.length === 0) {
    throw new Error('新 AgentHost Run 必须至少提供一个 --url；Excel 中的链接仅作为测试材料上下文')
  }
  const printProgress = (message: string): void => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    console.log(`[${time}] ${message}`)
  }
  const priorStatePath = resolve(options.outputDirectory, 'codex-agent.state.json')
  const priorLedgerPath = resolve(options.outputDirectory, '.agent-private', 'mutation-ledger.json')
  let effectiveAgentHostId = options.agentHostId
  if (options.resume) {
    for (const path of [priorStatePath, priorLedgerPath]) {
      if (!await access(path).then(() => true, () => false)) {
        throw new Error(`恢复运行缺少已有测试状态：${path}`)
      }
    }
    if (!effectiveAgentHostId) {
      const priorState = JSON.parse(await readFile(priorStatePath, 'utf8')) as { agentHost?: AgentHostId }
      effectiveAgentHostId = priorState.agentHost === 'omp' ? 'omp' : 'codex'
    }
  } else {
    for (const path of [priorStatePath, priorLedgerPath]) {
      if (await access(path).then(() => true, () => false)) {
        throw new Error(`输出目录包含已有测试状态，已拒绝覆盖：${path}。请为本次运行使用新的 --output-dir。`)
      }
    }
  }
  effectiveAgentHostId ??= 'codex'
  await mkdir(options.outputDirectory, { recursive: true, mode: 0o700 })
  printProgress(options.resume ? '正在读取原运行状态和测试输入' : '正在读取测试用例、URL 和图片')
  const inputBundle = await discoverWorkflowInputBundle({
    filePath: options.filePath,
    ...(options.briefPath ? { briefPath: options.briefPath } : {}),
    imagePaths: options.images,
  })
  const currentInputBundleIdentity = inputBundleIdentity(inputBundle)
  const intake = await intakeWorkflowXlsx({
    filePath: options.filePath,
    additionalUrls: options.urls,
    supplementalImagePaths: inputBundle.imagePaths,
  })
  const manifestPath = resolve(options.outputDirectory, 'intake.workflow.json')
  let manifest: WorkflowIntakeManifest
  if (options.resume) manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as WorkflowIntakeManifest
  else if (options.caseLimit === undefined) manifest = intake.manifest
  else manifest = limitManifestToCases(intake.manifest, options.caseLimit)
  if (manifest.workflowId !== intake.manifest.workflowId || manifest.source.sha256 !== intake.manifest.source.sha256) {
    throw new Error('恢复运行的冻结 Manifest 与当前 Excel 身份不一致')
  }
  const currentPrefix = intake.manifest.phases.slice(0, manifest.phases.length)
  if (currentPrefix.length !== manifest.phases.length || currentPrefix.some((phase, index) => phase.id !== manifest.phases[index]?.id)) {
    throw new Error('恢复运行的冻结 Manifest case 范围与当前 Excel 不一致')
  }
  if (options.resume && options.caseLimit !== undefined && manifest.phases.length !== Math.min(options.caseLimit, intake.manifest.phases.length)) {
    throw new Error('恢复运行不能改变原始 case 范围；请复用原输出目录中的冻结 Manifest')
  }
  printProgress(`测试材料解析完成：${manifest.phases.length} 个测试阶段，${intake.assets.length} 个图片资源`)
  const inputBundlePath = resolve(options.outputDirectory, 'input-bundle.json')
  if (options.resume) {
    const previousInputBundle = JSON.parse(await readFile(inputBundlePath, 'utf8')) as Partial<InputBundleIdentity>
    const previousImageSha256s = previousInputBundle.imageSha256s
    if (
      typeof previousInputBundle.briefSha256 !== 'string' ||
      !Array.isArray(previousImageSha256s) ||
      previousImageSha256s.some((value) => typeof value !== 'string') ||
      typeof previousInputBundle.bundleSha256 !== 'string' ||
      !sameInputBundleIdentity(currentInputBundleIdentity, {
        briefSha256: previousInputBundle.briefSha256,
        imageSha256s: previousImageSha256s as string[],
        bundleSha256: previousInputBundle.bundleSha256,
      })
    ) {
      throw new Error('恢复运行的 Excel/.auto-test 输入包与原运行不一致；请修正输入后创建新的 run')
    }
  } else {
    await writePrivateJson(manifestPath, manifest)
    await writePrivateJson(resolve(options.outputDirectory, 'intake.diagnostics.json'), intake.report)
    await writePrivateJson(inputBundlePath, { ...currentInputBundleIdentity, sidecarDirectory: inputBundle.sidecarDirectory })
  }
  const imagePaths = options.resume ? [] : await persistAssets(options.outputDirectory, intake.assets)
  if (intake.report.summary.errors > 0) {
    if (options.resume) throw new Error(`恢复输入解析发现 ${intake.report.summary.errors} 个阻塞问题`)
    return writePreExecutionBlock(
      options.outputDirectory,
      options.filePath,
      manifest,
      `测试用例解析发现 ${intake.report.summary.errors} 个阻塞问题`,
      { failureSource: 'input', failureKind: 'data' },
      effectiveAgentHostId,
    )
  }
  const readiness = assessAgentIntakeReadiness(manifest)
  if (!readiness.executable) {
    const message = `测试输入无法建立稳定执行合同：${readiness.problems.join('；')}`
    if (options.resume) throw new Error(message)
    return writePreExecutionBlock(
      options.outputDirectory,
      options.filePath,
      manifest,
      message,
      { failureSource: 'input', failureKind: 'validation' },
      effectiveAgentHostId,
    )
  }

  let profile
  let secrets: Record<string, string | string[]>
  let environmentContext: string
  try {
    printProgress('正在匹配环境 Profile、权限策略和登录状态')
    const registry = await loadEnvironmentProfileRegistry(options.profileRegistryPath)
    const environmentSelectionPath = resolve(options.outputDirectory, 'environment-selection.json')
    const priorSelection = options.resume
      ? JSON.parse(await readFile(environmentSelectionPath, 'utf8')) as AgentEnvironmentSelection
      : undefined
    const priorRequirements = options.resume
      ? await readEnvironmentRequirements(resolve(options.outputDirectory, '.agent-private', 'environment-requirements.json'))
      : []
    const additionalOrigins = priorRequirements
      .flatMap((requirement) => requirement.kind === 'origin' && requirement.origin ? [requirement.origin] : [])
    const requestedProfileId = options.profileId ?? priorSelection?.profileId
    profile = scopeEnvironmentProfile(
      selectEnvironmentProfile(registry, environmentTargetUrls(manifest), requestedProfileId),
      manifest,
      additionalOrigins,
    )
    secrets = mergeAgentSecrets(
      await loadEnvironmentProfileSecrets(profile),
      intake.secretMaterial,
      requiredSecretRefs(manifest, profile),
    )
    const profileContext = await loadEnvironmentProfileContext(profile)
    const brief = redactSensitiveContent(inputBundle.brief)
    environmentContext = [profileContext, brief].filter(Boolean).join('\n\n')
    await ensureEnvironmentAuthentication(
      profile,
      workflowSecretEnvironment(secrets),
      { headless: !options.headed, ...(options.slowMo !== undefined ? { slowMo: options.slowMo } : {}) },
    )
    printProgress(`环境“${profile.id}”已就绪，正在启动 ${effectiveAgentHostId} AgentHost`)
    const environmentSelection: AgentEnvironmentSelection = {
      profileId: profile.id,
      origins: profile.origins,
      policy: profile.policy,
      authenticatedOrigins: profile.auth.map((adapter) => adapter.origin),
      testDataSha256: testDataIdentitySha256(testDataSecrets(secrets, profile)),
      testDataAccess: options.testDataAccess,
    }
    if (options.resume) {
      if (!priorSelection || !isAppendOnlyEnvironmentSelection(priorSelection, environmentSelection)) {
        throw new Error('恢复运行所选环境与原运行不一致；仅允许在同一 Profile 和策略下追加已登记 origin')
      }
    }
    // Persist the effective selection on both initial and resumed runs. A
    // resumed run may append a previously registered origin; leaving the old
    // snapshot in place would make later contract comparison lie about the
    // environment actually used for the final delivery.
    await writePrivateJson(environmentSelectionPath, environmentSelection)
  } catch (error) {
    if (options.resume) throw error
    return writePreExecutionBlock(
      options.outputDirectory,
      options.filePath,
      manifest,
      error,
      { failureSource: 'environment', failureKind: 'environment' },
      effectiveAgentHostId,
    )
  }

  const modelSelectionPath = resolve(options.outputDirectory, 'model-selection.json')
  let modelProfile
  let effectiveModel = options.model
  try {
    const registry = await loadModelProfileRegistry(options.modelProfileRegistryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    let recorded: RecordedModelSelection | undefined
    let recordedSelectionFound = false
    if (!options.modelProfileId && options.resume) {
      try {
        recorded = parseRecordedModelSelection(await readFile(modelSelectionPath, 'utf8'))
        recordedSelectionFound = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const request = resolveModelProfileRequest(options.modelProfileId, options.model, recorded)
    const requestedId = request.profileId
    effectiveModel = request.model
    const preserveSourceProvider = shouldPreserveSourceModelProviderOnResume(
      options.resume,
      options.modelProfileId,
      options.model,
      recordedSelectionFound,
    )
    let selection: ReturnType<typeof selectConfiguredModelProfile>
    if (!preserveSourceProvider) {
      selection = !options.modelProfileId && recorded?.profile
        ? { explicit: true, profile: resolveModelProfileEnvironment(recorded.profile, process.env) }
        : selectConfiguredModelProfile(registry, requestedId, process.env)
    }
    if (preserveSourceProvider) {
      printProgress(`恢复旧版运行：未找到模型选择记录，继续使用原 Run 的 ${effectiveAgentHostId} Provider`)
    }
    if (selection) {
      if (!hasModelProfileEnvironment(selection.profile, process.env)) {
        throw new Error(`模型 Profile“${selection.profile.id}”需要环境变量 ${modelProfileEnvironmentNames(selection.profile).join(' 或 ')}`)
      }
      modelProfile = selection.profile
      const selectedModel = effectiveModel ?? selection.profile.model
      printProgress(`使用模型 Profile“${selection.profile.id}”（${selectedModel} @ ${selection.profile.baseUrl}）`)
      // Persist the effective control-plane selection after a provider switch
      // so a later bare --resume does not silently revert to the old profile.
      await writePrivateJson(modelSelectionPath, {
        version: '2.0',
        agentHost: effectiveAgentHostId,
        id: selection.profile.id,
        model: selectedModel,
        providerId: selection.profile.providerId,
        baseUrl: selection.profile.baseUrl,
        api: selection.profile.api,
        envKey: selection.profile.envKey,
        profile: selection.profile,
      })
    }
  } catch (error) {
    if (options.resume) throw error
    return writePreExecutionBlock(
      options.outputDirectory,
      options.filePath,
      manifest,
      error,
      { failureSource: 'infrastructure', failureKind: 'execution' },
      effectiveAgentHostId,
    )
  }

  const run = await runAgentTest({
    outputDirectory: options.outputDirectory,
    manifest,
    profile,
    secrets,
    environmentContext,
    sourceFilePath: options.filePath,
    ...(inputBundle.briefPath ? { briefFilePath: inputBundle.briefPath } : {}),
    imagePaths,
    headed: options.headed,
    ...(options.slowMo !== undefined ? { slowMo: options.slowMo } : {}),
    ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(options.maxFinalizationTurns !== undefined ? { maxFinalizationTurns: options.maxFinalizationTurns } : {}),
    ...(options.resume ? { resume: true } : {}),
    testDataAccess: options.testDataAccess,
    ...(modelProfile ? { modelProfile } : {}),
    ...(effectiveAgentHostId ? { agentHostId: effectiveAgentHostId } : {}),
    ...(options.agentExecutable ? { agentExecutable: options.agentExecutable } : {}),
    ...(options.agentSourceHome ? { agentSourceHome: options.agentSourceHome } : {}),
    onProgress: (progress) => printProgress(progress.message),
  })
  console.log(`测试状态：${run.state.status}`)
  console.log(`测试宿主：${run.state.agentHost ?? effectiveAgentHostId}`)
  console.log(`测试结果：${run.result?.outcome ?? 'failed'}`)
  console.log(`状态文件：${resolve(options.outputDirectory, 'codex-agent.state.json')}`)
  if (run.result) console.log(`结果文件：${resolve(options.outputDirectory, 'codex-agent.result.json')}`)
  if (run.result) {
    try {
      const workbookPath = await writeResultWorkbookDelivery({
        outputDirectory: options.outputDirectory,
        sourceFilePath: options.filePath,
        manifest,
        result: run.result,
      })
      console.log(`测试用例结果文件：${workbookPath}`)
    } catch (error) {
      console.error(`测试用例结果文件生成失败：${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }
  for (const requirement of run.result?.environmentRequirements ?? []) {
    const target = requirement.origin ?? requirement.kind
    console.log(`环境需求：${target}（${requirement.status}，${requirement.condition}）`)
  }
  if (run.state.error) console.log(`错误：${redactSensitiveText(run.state.error)}`)
  if (run.result?.outcome === 'passed') return 0
  if (run.result?.outcome === 'product_failed') return 2
  if (run.result?.outcome === 'blocked') return 3
  return 1
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(help())
    return
  }
  process.exitCode = await runAgentTestCli(parseAgentTestArgs(args))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(`Codex 测试代理启动失败：${redactSensitiveText(error instanceof Error ? error.message : String(error))}`)
    process.exitCode = 1
  })
}
