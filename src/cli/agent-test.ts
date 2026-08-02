#!/usr/bin/env node
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCodexTestAgent } from '../agent/runner.js'
import { readEnvironmentRequirements } from '../agent/environment-requirements.js'
import { initialCodexTestState, updateCodexTestState, writePrivateJson } from '../agent/state.js'
import type { CodexTestAgentResult } from '../agent/types.js'
import { redactSensitiveContent } from '../input/text.js'
import { ensureEnvironmentAuthentication } from '../workflow/auth-broker.js'
import {
  defaultEnvironmentProfileRegistryPath,
  loadEnvironmentProfileContext,
  loadEnvironmentProfileRegistry,
  loadEnvironmentProfileSecrets,
  selectEnvironmentProfile,
} from '../workflow/environment-profile.js'
import { discoverWorkflowInputBundle } from '../workflow/input-bundle.js'
import { workflowSecretEnvironment } from '../workflow/intake-secrets.js'
import { intakeWorkflowXlsx } from '../workflow/intake.js'
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
  codexExecutable?: string
  codexHome?: string
  resume?: boolean
}

interface AgentEnvironmentSelection {
  profileId: string
  origins: string[]
  policy: EnvironmentProfile['policy']
  authenticatedOrigins: string[]
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
    '  --url <url>                 目标网站，可重复；工作流型 Excel 也可从单元格发现 URL',
    '  --image <path>              补充截图，可重复',
    '  --brief <path>              测试工程师补充说明',
    '  --profile <id>              指定已注册环境；省略时必须恰好匹配一个环境',
    `  --profile-registry <path>   环境注册表，默认 ${defaultEnvironmentProfileRegistryPath()}`,
    '',
    '执行:',
    '  --output-dir <path>         本次运行目录',
    '  --model <id>                Codex 模型',
    '  --headed | --headless       显示或隐藏浏览器，默认 headless',
    '  --slow-mo <ms>              浏览器动作减速',
    '  --max-iterations <count>    列表型数据最多执行 N 条',
    '  --max-finalization-turns N  结果契约修复轮数，默认 2',
    '  --codex-bin <path>          显式 Codex 可执行文件；通常无需设置',
    '  --codex-home <path>         源 Codex 配置目录；运行仍使用隔离副本',
    '  --resume                    恢复同一输出目录中的中断 run、Codex thread 与 Mutation Ledger',
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
  const slowMo = nonNegativeInteger(args, '--slow-mo')
  const resolvedFilePath = resolve(filePath)
  return {
    filePath: resolvedFilePath,
    urls: valuesAfter(args, '--url'),
    images: valuesAfter(args, '--image').map((path) => resolve(path)),
    ...(valueAfter(args, '--brief') ? { briefPath: resolve(valueAfter(args, '--brief')!) } : {}),
    ...(valueAfter(args, '--profile') ? { profileId: valueAfter(args, '--profile')! } : {}),
    profileRegistryPath: resolve(valueAfter(args, '--profile-registry') ?? defaultEnvironmentProfileRegistryPath()),
    outputDirectory: resolve(valueAfter(args, '--output-dir') ?? defaultAgentRunDirectory(resolvedFilePath)),
    ...(valueAfter(args, '--model') ? { model: valueAfter(args, '--model')! } : {}),
    headed: args.includes('--headed'),
    resume: args.includes('--resume'),
    ...(slowMo !== undefined ? { slowMo } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(maxFinalizationTurns !== undefined ? { maxFinalizationTurns } : {}),
    ...(valueAfter(args, '--codex-bin') ? { codexExecutable: resolve(valueAfter(args, '--codex-bin')!) } : {}),
    ...(valueAfter(args, '--codex-home') ? { codexHome: resolve(valueAfter(args, '--codex-home')!) } : {}),
  }
}

function sameSecret(left: string | string[], right: string | string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
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

function targetOrigins(manifest: WorkflowIntakeManifest, additionalOrigins: string[] = []): Set<string> {
  return new Set([
    ...manifest.targetUrls.map((url) => new URL(url).origin),
    ...additionalOrigins.map((origin) => new URL(origin).origin),
  ])
}

export function scopeEnvironmentProfile(
  profile: EnvironmentProfile,
  manifest: WorkflowIntakeManifest,
  additionalOrigins: string[] = [],
): EnvironmentProfile {
  const origins = targetOrigins(manifest, additionalOrigins)
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
  previous: { profileId: string; origins: string[]; policy: EnvironmentProfile['policy']; authenticatedOrigins: string[] },
  current: { profileId: string; origins: string[]; policy: EnvironmentProfile['policy']; authenticatedOrigins: string[] },
): boolean {
  return previous.profileId === current.profileId &&
    JSON.stringify(previous.policy) === JSON.stringify(current.policy) &&
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

function preExecutionBlockedResult(manifest: WorkflowIntakeManifest, message: string): CodexTestAgentResult {
  const now = new Date().toISOString()
  return {
    version: '1.0',
    workflowId: manifest.workflowId,
    sourceSha256: manifest.source.sha256,
    outcome: 'blocked',
    summary: '测试在浏览器执行前被环境或输入条件阻断。',
    startedAt: now,
    finishedAt: now,
    cases: manifest.phases.map((phase) => ({
      caseId: phase.id,
      title: phase.title,
      outcome: 'blocked',
      summary: message,
      evidence: [{ kind: 'observation', description: 'Pre-execution validation did not permit browser execution.' }],
    })),
    mutations: [],
    environmentRequirements: [],
    blockers: [message],
    productDefects: [],
    nextActions: ['补充或修复所列环境条件后，使用同一 Excel 和环境 Profile 重新执行。'],
  }
}

async function writePreExecutionBlock(outputDirectory: string, manifest: WorkflowIntakeManifest, error: unknown): Promise<number> {
  const message = error instanceof Error ? error.message : String(error)
  const resultPath = resolve(outputDirectory, 'codex-agent.result.json')
  const statePath = resolve(outputDirectory, 'codex-agent.state.json')
  const result = preExecutionBlockedResult(manifest, message)
  await writePrivateJson(resultPath, result)
  const state = updateCodexTestState(initialCodexTestState(manifest.workflowId, manifest.source.sha256), {
    status: 'completed',
    stage: 'completed',
    outcome: 'blocked',
    resultPath,
  })
  await writePrivateJson(statePath, state)
  console.log(`测试结果：blocked`)
  console.log(`阻断原因：${message}`)
  console.log(`结果文件：${resultPath}`)
  return 3
}

export async function runAgentTestCli(options: AgentTestCliOptions): Promise<number> {
  process.umask(0o027)
  const printProgress = (message: string): void => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    console.log(`[${time}] ${message}`)
  }
  const priorStatePath = resolve(options.outputDirectory, 'codex-agent.state.json')
  const priorLedgerPath = resolve(options.outputDirectory, '.agent-private', 'mutation-ledger.json')
  if (options.resume) {
    for (const path of [priorStatePath, priorLedgerPath]) {
      if (!await access(path).then(() => true, () => false)) {
        throw new Error(`恢复运行缺少已有测试状态：${path}`)
      }
    }
  } else {
    for (const path of [priorStatePath, priorLedgerPath]) {
      if (await access(path).then(() => true, () => false)) {
        throw new Error(`输出目录包含已有测试状态，已拒绝覆盖：${path}。请为本次运行使用新的 --output-dir。`)
      }
    }
  }
  await mkdir(options.outputDirectory, { recursive: true, mode: 0o700 })
  printProgress(options.resume ? '正在读取原运行状态和测试输入' : '正在读取测试用例、URL 和图片')
  const inputBundle = await discoverWorkflowInputBundle({
    filePath: options.filePath,
    ...(options.briefPath ? { briefPath: options.briefPath } : {}),
    imagePaths: options.images,
  })
  const intake = await intakeWorkflowXlsx({
    filePath: options.filePath,
    additionalUrls: options.urls,
    supplementalImagePaths: inputBundle.imagePaths,
  })
  printProgress(`测试材料解析完成：${intake.manifest.phases.length} 个测试阶段，${intake.assets.length} 个图片资源`)
  if (!options.resume) {
    await writePrivateJson(resolve(options.outputDirectory, 'intake.workflow.json'), intake.manifest)
    await writePrivateJson(resolve(options.outputDirectory, 'intake.diagnostics.json'), intake.report)
    await writePrivateJson(resolve(options.outputDirectory, 'input-bundle.json'), {
      briefSha256: inputBundle.briefSha256,
      imageSha256s: inputBundle.imageSha256s,
      sidecarDirectory: inputBundle.sidecarDirectory,
    })
  }
  const imagePaths = options.resume ? [] : await persistAssets(options.outputDirectory, intake.assets)
  if (intake.report.summary.errors > 0) {
    if (options.resume) throw new Error(`恢复输入解析发现 ${intake.report.summary.errors} 个阻塞问题`)
    return writePreExecutionBlock(options.outputDirectory, intake.manifest, `测试用例解析发现 ${intake.report.summary.errors} 个阻塞问题`)
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
      .map((requirement) => requirement.origin)
    const requestedProfileId = options.profileId ?? priorSelection?.profileId
    profile = scopeEnvironmentProfile(
      selectEnvironmentProfile(registry, intake.manifest.targetUrls, requestedProfileId),
      intake.manifest,
      additionalOrigins,
    )
    secrets = mergeAgentSecrets(
      await loadEnvironmentProfileSecrets(profile),
      intake.secretMaterial,
      requiredSecretRefs(intake.manifest, profile),
    )
    const profileContext = await loadEnvironmentProfileContext(profile)
    const brief = redactSensitiveContent(inputBundle.brief)
    environmentContext = [profileContext, brief].filter(Boolean).join('\n\n')
    await ensureEnvironmentAuthentication(
      profile,
      workflowSecretEnvironment(secrets),
      { headless: !options.headed, ...(options.slowMo !== undefined ? { slowMo: options.slowMo } : {}) },
    )
    printProgress(`环境“${profile.id}”已就绪，正在启动 Codex-native 测试代理`)
    const environmentSelection: AgentEnvironmentSelection = {
      profileId: profile.id,
      origins: profile.origins,
      policy: profile.policy,
      authenticatedOrigins: profile.auth.map((adapter) => adapter.origin),
    }
    if (options.resume) {
      if (!priorSelection || !isAppendOnlyEnvironmentSelection(priorSelection, environmentSelection)) {
        throw new Error('恢复运行所选环境与原运行不一致；仅允许在同一 Profile 和策略下追加已登记 origin')
      }
    } else {
      await writePrivateJson(environmentSelectionPath, environmentSelection)
    }
  } catch (error) {
    if (options.resume) throw error
    return writePreExecutionBlock(options.outputDirectory, intake.manifest, error)
  }

  const run = await runCodexTestAgent({
    outputDirectory: options.outputDirectory,
    manifest: intake.manifest,
    profile,
    secrets,
    environmentContext,
    imagePaths,
    headed: options.headed,
    ...(options.slowMo !== undefined ? { slowMo: options.slowMo } : {}),
    ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.codexExecutable ? { codexExecutable: options.codexExecutable } : {}),
    ...(options.codexHome ? { codexHome: options.codexHome } : {}),
    ...(options.maxFinalizationTurns !== undefined ? { maxFinalizationTurns: options.maxFinalizationTurns } : {}),
    ...(options.resume ? { resume: true } : {}),
    onProgress: (progress) => printProgress(progress.message),
  })
  console.log(`测试状态：${run.state.status}`)
  console.log(`测试结果：${run.result?.outcome ?? 'failed'}`)
  console.log(`状态文件：${resolve(options.outputDirectory, 'codex-agent.state.json')}`)
  if (run.result) console.log(`结果文件：${resolve(options.outputDirectory, 'codex-agent.result.json')}`)
  for (const requirement of run.result?.environmentRequirements ?? []) {
    console.log(`环境需求：${requirement.origin}（${requirement.status}，完成注册后使用 --resume）`)
  }
  if (run.state.error) console.log(`错误：${run.state.error}`)
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
    console.error(`Codex 测试代理启动失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
