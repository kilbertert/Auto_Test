#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { access, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, extname, resolve } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { chromium } from '@playwright/test'
import crossSpawn from 'cross-spawn'
import { runAgentTestCli } from './agent-test.js'
import {
  normalizeTargetUrls,
  registerEnvironment,
  riskForPolicy,
  safeProfileId,
  type EasyRiskLevel,
} from '../usability/environment-registration.js'
import { friendlyRunSummary } from '../usability/result-summary.js'
import { planEasyRegistration, preflightEasyWorkflow } from '../usability/workflow-preflight.js'
import { defaultEnvironmentProfileRegistryPath, type EnvironmentProfile } from '../workflow/environment-profile.js'
import {
  BUILT_IN_MODEL_PROFILES,
  DEFAULT_MODEL_PROFILE_ID,
  defaultModelProfileRegistryPath,
  hasModelProfileEnvironment,
  loadModelProfileRegistry,
  modelProfileEnvironmentNames,
  runtimeModelProfileFromEnvironment,
  selectConfiguredModelProfile,
  type ModelProfile,
} from '../workflow/model-profile.js'
import { isBuiltInAgentHostId } from '../agent/host-registry.js'
import type { AgentHostId } from '../agent/host.js'
import { defaultRunDirectory, defaultRunRoot } from '../usability/run-directory.js'

interface EasyRunOptions {
  filePath: string
  urls: string[]
  images?: string[]
  briefPath?: string
  profileId?: string
  maxIterations?: number
  caseLimit?: number
  outputDirectory?: string
  model?: string
  headed?: boolean
  slowMo?: number
  resume?: boolean
  testDataAccess?: 'direct' | 'opaque'
  modelProfileId?: string
  agentHostId?: AgentHostId
  agentExecutable?: string
  agentSourceHome?: string
}

const rl = createInterface({ input, output })

function banner(): void {
  console.log('\n========================================')
  console.log(' Auto-Test 跨场景 AI 自动化测试')
  console.log('========================================\n')
}

function stripDraggedPath(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '')
}

function urlValues(value: string): string[] {
  return value.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean)
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  const value = index >= 0 ? args[index + 1] : undefined
  if (index >= 0 && (!value || value.startsWith('--'))) throw new Error(`${name} 后缺少内容`)
  return value
}

function valuesAfter(args: string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name) {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${name} 后缺少内容`)
      values.push(value)
    }
  }
  return values
}

async function ask(prompt: string, fallback?: string): Promise<string> {
  const suffix = fallback ? `（直接回车使用 ${fallback}）` : ''
  const value = (await rl.question(`${prompt}${suffix}：`)).trim()
  return value || fallback || ''
}

async function confirm(prompt: string, defaultYes = true): Promise<boolean> {
  const marker = defaultYes ? 'Y/n' : 'y/N'
  const answer = (await rl.question(`${prompt} [${marker}]：`)).trim().toLowerCase()
  if (!answer) return defaultYes
  return ['y', 'yes', '是', '1'].includes(answer)
}

async function chooseRisk(defaultRisk: EasyRiskLevel = 'read'): Promise<EasyRiskLevel> {
  console.log('\n本环境允许的最高操作范围：')
  console.log('  1. 只读查看（推荐）')
  console.log('  2. 允许新增、修改、启动等写入操作')
  console.log('  3. 允许本轮测试数据的停止、删除、结算等清理操作')
  const defaultValue = defaultRisk === 'destructive' ? '3' : defaultRisk === 'write' ? '2' : '1'
  const value = await ask('请选择', defaultValue)
  if (value === '1') return 'read'
  if (value === '2') return 'write'
  if (value === '3') {
    if (!await confirm('确认只对已授权的测试环境及本轮测试数据执行高风险操作', false)) return 'read'
    return 'destructive'
  }
  throw new Error('请选择 1、2 或 3')
}

async function waitForManualLogin(origins: string[]): Promise<void> {
  console.log('\n浏览器已经打开。请在每个网站中正常完成登录。')
  console.log(`需要确认的网站：${origins.join('、')}`)
  console.log('全部登录完成并看到业务页面后，回到这里按回车。')
  await rl.question('')
}

async function registerInteractive(
  initialUrls: string[] = [],
  defaults: { profileId?: string; existingProfile?: EnvironmentProfile } = {},
): Promise<string> {
  const urls = initialUrls.length > 0
    ? normalizeTargetUrls(initialUrls)
    : normalizeTargetUrls(urlValues(await ask('粘贴需要访问的网站 URL；多个地址用空格分开')))
  const suggested = defaults.existingProfile?.id ?? defaults.profileId ?? safeProfileId('', urls)
  const profileId = defaults.existingProfile
    ? defaults.existingProfile.id
    : safeProfileId(await ask('给这个测试环境起个简短名称', suggested), urls)
  if (defaults.existingProfile) console.log(`正在更新环境：${profileId}`)
  const captureLogin = defaults.existingProfile
    ? await confirm('是否更新供普通业务用例复用的登录状态', false)
    : await confirm('是否保存当前登录状态（测试登录/登出时请选否）', false)
  const risk = await chooseRisk(defaults.existingProfile ? riskForPolicy(defaults.existingProfile.policy) : 'read')
  console.log('\n正在注册环境，请不要关闭本窗口……')
  const result = await registerEnvironment({
    profileId,
    urls,
    risk,
    captureLogin,
    ...(captureLogin ? { waitForLogin: waitForManualLogin } : {}),
  })
  const authentication = captureLogin
    ? '已保存可选会话种子；认证类用例仍会先建立用例要求的干净状态'
    : '未要求预先登录；认证步骤由测试代理按用例执行'
  console.log(`\n环境“${result.profile.id}”已注册。${authentication}，权限设置将自动复用。`)
  console.log(`配置位置：${result.registryPath}`)
  return result.profile.id
}

async function windowsExcelPicker(): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined
  const script = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    '$dialog.Title = "选择测试用例 Excel"',
    '$dialog.Filter = "Excel 测试用例 (*.xlsx)|*.xlsx"',
    '$dialog.Multiselect = $false',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.FileName) }',
  ].join('; ')
  return new Promise((done) => {
    const child = crossSpawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', () => done(undefined))
    child.on('close', (code) => {
      const value = Buffer.concat(chunks).toString('utf8').trim()
      done(code === 0 && value ? value : undefined)
    })
  })
}

function spawnInherited(executable: string, args: string[], cwd = process.cwd()): Promise<number> {
  return new Promise((done, reject) => {
    const child = crossSpawn(executable, args, { cwd, stdio: 'inherit', env: process.env })
    child.on('error', reject)
    child.on('close', (code) => done(code ?? 1))
  })
}

async function printSummary(statePath: string): Promise<void> {
  const summary = await friendlyRunSummary(statePath)
  console.log('\n----------------------------------------')
  console.log(summary.title)
  console.log('----------------------------------------')
  for (const line of summary.lines) console.log(`- ${line}`)
}

export async function runEasyWorkflow(options: EasyRunOptions): Promise<number> {
  const filePath = resolve(stripDraggedPath(options.filePath))
  if (extname(filePath).toLowerCase() !== '.xlsx') throw new Error('请选择 .xlsx 测试用例文件')
  const configuredHost = process.env.AUTO_TEST_AGENT_HOST
  if (configuredHost && !isBuiltInAgentHostId(configuredHost)) throw new Error(`AUTO_TEST_AGENT_HOST 只支持 codex 或 omp，收到：${configuredHost}`)
  let effectiveAgentHostId = options.agentHostId
  if (!effectiveAgentHostId && configuredHost && !options.resume) effectiveAgentHostId = configuredHost as AgentHostId
  await access(filePath)
  const suppliedUrls = normalizeTargetUrls(options.urls)
  if (suppliedUrls.length === 0) {
    throw new Error('run 必须至少提供一个 --url；Excel 中的链接仅作为测试材料上下文')
  }
  console.log('\n正在分析测试用例中的网站范围……')
  const preflight = await preflightEasyWorkflow(filePath, suppliedUrls)
  // Intake reads the workbook again. Pass only user-declared URLs to the
  // execution boundary; incidental material links remain Agent context.
  const agentExecutionUrls = suppliedUrls
  if (preflight.materialOrigins.length > 0) {
    console.log(
      `测试材料中另有链接：${preflight.materialOrigins.join('、')}（保留给 Agent 理解，不作为预执行环境注册要求）`,
    )
  }
  const plan = await planEasyRegistration({
    suppliedUrls,
    isTTY: input.isTTY,
    ...(options.profileId ? { profileId: options.profileId } : {}),
  })
  let profileId: string | undefined
  switch (plan.kind) {
    case 'error':
      throw new Error(plan.message)
    case 'use':
      profileId = plan.profileId
      break
    case 'choose':
      console.log(`找到多个匹配环境：${plan.profiles.map((profile) => profile.id).join('、')}`)
      profileId = await ask('请输入本次使用的环境名称', plan.profiles[0]!.id)
      break
    case 'register': {
      console.log(plan.message)
      let defaults = plan.defaults
      if (plan.related && plan.related.length > 1) {
        const suggestedProfileId = await ask('请输入要更新的环境名称', plan.related[0]!.profile.id)
        const existingProfile = plan.related.find((match) => match.profile.id === suggestedProfileId)?.profile
        defaults = existingProfile ? { existingProfile } : { profileId: suggestedProfileId }
      }
      profileId = await registerInteractive(plan.registrationUrls, defaults)
      break
    }
  }
  const outputDirectory = resolve(options.outputDirectory ?? defaultRunDirectory(filePath))
  await mkdir(outputDirectory, { recursive: true, mode: 0o750 })
  console.log(`\n本次结果目录：${outputDirectory}`)
  const exitCode = await runAgentTestCli({
    filePath,
    urls: agentExecutionUrls,
    images: options.images ?? [],
    ...(options.briefPath ? { briefPath: resolve(options.briefPath) } : {}),
    ...(profileId ? { profileId } : {}),
    profileRegistryPath: defaultEnvironmentProfileRegistryPath(),
    outputDirectory,
    ...(options.model ? { model: options.model } : {}),
    headed: options.headed === true,
    ...(options.slowMo !== undefined ? { slowMo: options.slowMo } : {}),
    ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
    ...(options.caseLimit !== undefined ? { caseLimit: options.caseLimit } : {}),
    ...(options.resume ? { resume: true } : {}),
    ...(options.modelProfileId ? { modelProfileId: options.modelProfileId } : {}),
    ...(effectiveAgentHostId ? { agentHostId: effectiveAgentHostId } : {}),
    ...(options.agentExecutable ? { agentExecutable: options.agentExecutable } : {}),
    ...(options.agentSourceHome ? { agentSourceHome: options.agentSourceHome } : {}),
    modelProfileRegistryPath: defaultModelProfileRegistryPath(),
    testDataAccess: options.testDataAccess ?? 'direct',
  })
  const statePath = resolve(outputDirectory, 'codex-agent.state.json')
  try {
    await printSummary(statePath)
  } catch {
    console.log('\n框架未能生成结果摘要，请查看上方错误信息。')
    console.log(`运行诊断：${resolve(outputDirectory, 'codex-agent.events.jsonl')}`)
  }
  return exitCode
}

async function chooseModelProfile(): Promise<string | undefined> {
  const registry = await loadModelProfileRegistry(defaultModelProfileRegistryPath()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  const profiles = visibleModelProfiles(registry)
  const defaultId = selectConfiguredModelProfile(registry)?.profile.id ?? DEFAULT_MODEL_PROFILE_ID
  if (profiles.length === 1) return profiles[0]!.id
  console.log('\n可用模型 Profile：')
  for (const profile of profiles) {
    const marker = profile.id === defaultId ? '（默认）' : ''
    const ready = hasModelProfileEnvironment(profile, process.env) ? '✓' : '✗'
    console.log(`  ${ready} ${profile.id}：${profile.displayName ?? profile.model} @ ${profile.baseUrl}${marker}`)
  }
  return ask('请输入本次使用的模型 Profile 名称', defaultId)
}

function visibleModelProfiles(registry: Awaited<ReturnType<typeof loadModelProfileRegistry>> | undefined): ModelProfile[] {
  const configuredProfiles = registry?.profiles ?? []
  const configuredNames = new Set(configuredProfiles.flatMap((profile) => [profile.id, ...(profile.aliases ?? [])]))
  const runtimeProfile = runtimeModelProfileFromEnvironment(process.env)
  const profiles = [
    ...configuredProfiles,
    ...(runtimeProfile && !configuredNames.has(runtimeProfile.id) ? [runtimeProfile] : []),
  ]
  const visibleNames = new Set(profiles.flatMap((profile) => [profile.id, ...(profile.aliases ?? [])]))
  return [
    ...profiles,
    ...BUILT_IN_MODEL_PROFILES.filter((profile) => !visibleNames.has(profile.id)),
  ]
}

function configuredAgentHost(): 'codex' | 'omp' {
  const value = process.env.AUTO_TEST_AGENT_HOST?.trim() || 'codex'
  if (!isBuiltInAgentHostId(value)) throw new Error(`AUTO_TEST_AGENT_HOST 只支持 codex 或 omp，收到：${value}`)
  return value
}

async function chooseAgentHost(): Promise<'codex' | 'omp'> {
  console.log('\n测试代理宿主：')
  console.log('  1. Codex CLI（默认）')
  console.log('  2. OMP / oh-my-pi RPC')
  const fallback = configuredAgentHost() === 'omp' ? '2' : '1'
  const value = await ask('请选择', fallback)
  if (value === '1') return 'codex'
  if (value === '2') return 'omp'
  throw new Error('请选择 1 或 2')
}

async function runInteractive(): Promise<void> {
  const selected = await windowsExcelPicker()
  const filePath = selected ?? stripDraggedPath(await ask('将测试用例 Excel 拖到窗口中，然后按回车'))
  console.log(`已选择：${filePath}`)
  const urls = urlValues(await ask('粘贴网站 URL；多个地址用空格分开'))
  const single = await confirm('是否先只执行一条数据进行安全验证', true)
  const headed = await confirm('是否显示浏览器中的自动化操作', process.platform === 'win32')
  const configuredHost = process.env.AUTO_TEST_AGENT_HOST
  const agentHostId = configuredHost && isBuiltInAgentHostId(configuredHost)
    ? (console.log(`\n使用已配置的测试代理宿主：${configuredHost}`), configuredHost)
    : await chooseAgentHost()
  const modelProfileId = await chooseModelProfile()
  await runEasyWorkflow({
    filePath,
    urls,
    ...(single ? { caseLimit: 1 } : {}),
    headed,
    ...(headed ? { slowMo: 150 } : {}),
    ...(modelProfileId ? { modelProfileId } : {}),
    agentHostId,
  })
}

async function latestStatePath(): Promise<string | undefined> {
  const root = defaultRunRoot()
  const candidates: { path: string; modified: number }[] = []
  try {
    // Walk one directory at a time: `readdir(recursive + withFileTypes)`
    // reports unreliable Dirent types on Windows, so `isFile()` there can
    // miss every candidate. A per-directory walk keeps the same result on
    // every platform.
    const pending = [root]
    while (pending.length > 0) {
      const directory = pending.pop()!
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) pending.push(resolve(directory, entry.name))
        else if (entry.isFile() && entry.name === 'codex-agent.state.json') {
          const path = resolve(directory, entry.name)
          candidates.push({ path, modified: (await stat(path)).mtimeMs })
        }
      }
    }
    return candidates.sort((left, right) => right.modified - left.modified)[0]?.path
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function commandAvailable(command: string, args: string[]): Promise<boolean> {
  return new Promise((done) => {
    const child = crossSpawn(command, args, { stdio: 'ignore' })
    child.on('error', () => done(false))
    child.on('close', (code) => done(code === 0))
  })
}

async function doctor(agentHostId: 'codex' | 'omp' = configuredAgentHost()): Promise<boolean> {
  if (agentHostId === 'omp') {
    const ompExecutable = process.env.AUTO_TEST_OMP_BIN || 'omp'
    const modelRegistryPath = defaultModelProfileRegistryPath()
    const modelRegistry = await loadModelProfileRegistry(modelRegistryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    const defaultModelProfile = selectConfiguredModelProfile(modelRegistry)?.profile
    if (!defaultModelProfile) throw new Error('内置默认模型 Profile 不可用')
    const checks = [
      { label: `Node.js ${process.version}`, ok: Number(process.versions.node.split('.')[0]) >= 24 },
      { label: 'OMP / oh-my-pi CLI 已安装', ok: await commandAvailable(ompExecutable, ['--version']) },
      {
        label: `默认模型 Profile 已就绪（${defaultModelProfile.id}；env ${modelProfileEnvironmentNames(defaultModelProfile).join('|')}）`,
        ok: hasModelProfileEnvironment(defaultModelProfile, process.env),
      },
      { label: 'Chromium 浏览器已安装', ok: await access(chromium.executablePath()).then(() => true, () => false) },
    ]
    console.log('\n环境检查（AgentHost: omp）：')
    for (const check of checks) console.log(`${check.ok ? '✓' : '✗'} ${check.label}`)
    console.log('OMP 通过 AgentHost Provider 适配器消费 Auto-Test 的通用 Model Profile；适配器生成隔离 models.yml，并由 OMP 负责协议和请求执行。')
    if (!hasModelProfileEnvironment(defaultModelProfile, process.env)) {
      console.log(`  请为默认 Profile“${defaultModelProfile.id}”设置 ${modelProfileEnvironmentNames(defaultModelProfile).join(' 或 ')}。`)
    }
    console.log(`环境配置目录：${defaultEnvironmentProfileRegistryPath()}`)
    return checks.every((check) => check.ok)
  }
  const codexExecutable = process.env.AUTO_TEST_CODEX_BIN || 'codex'
  const codexInstalled = await commandAvailable(codexExecutable, ['--version'])
  const codexHome = process.env.CODEX_HOME || resolve(homedir(), '.codex')
  const codexConfigPath = resolve(codexHome, 'config.toml')
  const codexConfig = await readFile(codexConfigPath, 'utf8').catch(() => '')
  const providerId = /model_provider\s*=\s*"([^"]+)"/.exec(codexConfig)?.[1]
  const escapedProviderId = providerId?.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')
  const providerSection = escapedProviderId
    ? new RegExp('\\[model_providers\\.' + escapedProviderId + '\\]([\\s\\S]*?)(?=\\n\\s*\\[|$)').exec(codexConfig)?.[1]
    : undefined
  const configuredEnvironmentName = providerSection
    ? /env_key\s*=\s*"([^"]+)"/.exec(providerSection)?.[1]
    : undefined
  const providerEnvironmentName = process.env.AUTO_TEST_CODEX_ENV_KEY ||
    configuredEnvironmentName ||
    'AUTO_TEST_MODEL_API_KEY'
  const providerConfigured = Boolean(providerId && providerSection)
  const apiKeyAvailable = Boolean(process.env[providerEnvironmentName])
  const modelRegistryPath = defaultModelProfileRegistryPath()
  const modelRegistry = await loadModelProfileRegistry(modelRegistryPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  const visibleProfiles = visibleModelProfiles(modelRegistry)
  const sourceProviderReady = providerConfigured && apiKeyAvailable
  const defaultModelProfile = selectConfiguredModelProfile(modelRegistry)?.profile
  if (!defaultModelProfile) throw new Error('内置默认模型 Profile 不可用')
  const defaultModelProfileReady = hasModelProfileEnvironment(defaultModelProfile, process.env)
  const nodeCheck = { label: `Node.js ${process.version}`, ok: Number(process.versions.node.split('.')[0]) >= 24 }
  const codexInstallCheck = { label: 'Codex CLI 已安装', ok: codexInstalled }
  const providerCheck = {
    label: `默认模型 Profile 已就绪（${defaultModelProfile.id}；env ${modelProfileEnvironmentNames(defaultModelProfile).join('|')}）`,
    ok: defaultModelProfileReady,
  }
  const chromiumCheck = {
    label: 'Chromium 浏览器已安装',
    ok: await access(chromium.executablePath()).then(() => true, () => false),
  }
  const checks = [nodeCheck, codexInstallCheck, providerCheck, chromiumCheck]
  console.log('\n环境检查（AgentHost: codex）：')
  for (const check of checks) console.log(`${check.ok ? '✓' : '✗'} ${check.label}`)
  if (!providerCheck.ok) {
    console.log(`  请为默认 Profile“${defaultModelProfile.id}”设置 ${modelProfileEnvironmentNames(defaultModelProfile).join(' 或 ')}。`)
  }
  if (!chromiumCheck.ok && input.isTTY && await confirm('现在安装 Chromium 浏览器', true)) {
    chromiumCheck.ok = await spawnInherited('npx', ['playwright', 'install', 'chromium']) === 0
  }
  if (modelRegistry && modelRegistry.profiles.length > 0) {
    console.log(`\n模型 Profile 注册表：${modelRegistryPath}`)
    for (const profile of modelRegistry.profiles) {
      const keyReady = hasModelProfileEnvironment(profile, process.env)
      const marker = profile.id === defaultModelProfile.id ? '（默认）' : ''
      console.log(`  ${keyReady ? '✓' : '✗'} ${profile.id}：${profile.displayName ?? profile.model} @ ${profile.baseUrl}（env ${modelProfileEnvironmentNames(profile).join('|')}）${marker}`)
    }
  } else {
    console.log(`\n模型 Profile 注册表：未配置（${modelRegistryPath}）`)
  }
  console.log('\n运行时和内置模型 Profile：')
  const configuredIds = new Set(modelRegistry?.profiles.map((profile) => profile.id) ?? [])
  for (const profile of visibleProfiles.filter((profile) => !configuredIds.has(profile.id))) {
    const keyReady = hasModelProfileEnvironment(profile, process.env)
    const marker = profile.id === defaultModelProfile.id ? '（默认）' : ''
    console.log(`  ${keyReady ? '✓' : '✗'} ${profile.id}：${profile.displayName ?? profile.model} @ ${profile.baseUrl}（env ${modelProfileEnvironmentNames(profile).join('|')}）${marker}`)
  }
  console.log(`  新 Run 未指定 Profile 时使用 ${defaultModelProfile.id}；显式 --model-profile 或注册表 defaultProfileId 可覆盖。`)
  if (providerConfigured) {
    console.log(`  ${sourceProviderReady ? '✓' : '✗'} 源 Codex Provider（env ${providerEnvironmentName}；仅兼容旧版无模型选择记录的恢复）`)
  }
  console.log(`\n环境配置目录：${defaultEnvironmentProfileRegistryPath()}`)
  console.log(`Codex API 配置：${codexConfigPath}`)
  return checks.every((check) => check.ok)
}

async function menu(): Promise<void> {
  while (true) {
    banner()
    console.log('  1. 开始一次新测试')
    console.log('  2. 注册或更新测试环境')
    console.log('  3. 查看最近一次结果')
    console.log('  4. 检查运行环境')
    console.log('  0. 退出')
    const choice = await ask('请选择', '1')
    if (choice === '0') return
    try {
      if (choice === '1') await runInteractive()
      else if (choice === '2') await registerInteractive()
      else if (choice === '3') {
        const path = await latestStatePath()
        if (path) await printSummary(path)
        else console.log('还没有找到历史测试结果。')
      } else if (choice === '4') await doctor()
      else console.log('请输入 0 到 4。')
    } catch (error) {
      console.error(`\n操作失败：${error instanceof Error ? error.message : String(error)}`)
    }
    await rl.question('\n按回车返回主菜单……')
  }
}

async function main(): Promise<void> {
  process.umask(0o027)
  if (process.env.AUTO_TEST_CODEX_BIN) {
    const codexDirectory = dirname(process.env.AUTO_TEST_CODEX_BIN)
    process.env.PATH = `${codexDirectory}${delimiter}${process.env.PATH ?? ''}`
  }
  if (process.env.AUTO_TEST_OMP_BIN) {
    const ompDirectory = dirname(process.env.AUTO_TEST_OMP_BIN)
    process.env.PATH = `${ompDirectory}${delimiter}${process.env.PATH ?? ''}`
  }
  if (!process.env.CODEX_HOME) {
    if (process.env.AUTO_TEST_CODEX_HOME) {
      process.env.CODEX_HOME = process.env.AUTO_TEST_CODEX_HOME
    } else if (process.platform === 'win32' && process.env.APPDATA) {
      process.env.CODEX_HOME = resolve(process.env.APPDATA, 'auto-test', 'codex-home')
    }
  }
  const args = process.argv.slice(2)
  const command = args[0]
  if (!command) {
    if (!input.isTTY) throw new Error('非交互模式请使用 easy run、easy register 或 easy doctor')
    banner()
    if (!await doctor()) {
      console.log('\n有项目尚未就绪。修复后可继续使用菜单中的“检查运行环境”。')
      await rl.question('按回车进入主菜单……')
    }
    await menu()
    return
  }
  if (command === 'doctor') {
    const requestedHost = valueAfter(args, '--agent-host') ?? configuredAgentHost()
    if (!isBuiltInAgentHostId(requestedHost)) throw new Error('--agent-host 只支持 codex 或 omp')
    if (!await doctor(requestedHost)) process.exitCode = 1
    return
  }
  if (command === 'register') {
    const urls = valuesAfter(args, '--url')
    if (urls.length === 0) throw new Error('register 必须至少提供一个 --url')
    const risk = valueAfter(args, '--risk') ?? 'read'
    if (!['read', 'write', 'destructive'].includes(risk)) throw new Error('--risk 必须是 read、write 或 destructive')
    if (args.includes('--capture-login') && args.includes('--no-login')) throw new Error('--capture-login 与 --no-login 不能同时使用')
    const captureLogin = args.includes('--capture-login')
    if (captureLogin && !input.isTTY) throw new Error('捕获登录状态需要交互终端')
    const result = await registerEnvironment({
      profileId: valueAfter(args, '--profile') ?? safeProfileId('', urls),
      urls,
      risk: risk as EasyRiskLevel,
      captureLogin,
      ...(captureLogin ? { waitForLogin: waitForManualLogin } : {}),
    })
    console.log(`环境已注册：${result.profile.id}`)
    return
  }
  if (command === 'run') {
    if (args.includes('--legacy-runtime')) throw new Error('未知参数：--legacy-runtime')
    const filePath = valueAfter(args, '--file')
    const urls = valuesAfter(args, '--url')
    if (!filePath) throw new Error('run 必须提供 --file')
    if (urls.length === 0) throw new Error('run 必须至少提供一个 --url；Excel 中的链接仅作为测试材料上下文')
    if (args.includes('--headed') && args.includes('--headless')) throw new Error('--headed 与 --headless 不能同时使用')
    if (args.includes('--resume') && !valueAfter(args, '--output-dir')) throw new Error('--resume 必须同时提供原运行的 --output-dir')
    const slowMoValue = valueAfter(args, '--slow-mo')
    const slowMo = slowMoValue === undefined ? undefined : Number(slowMoValue)
    if (slowMo !== undefined && (!Number.isInteger(slowMo) || slowMo < 0)) throw new Error('--slow-mo 必须是非负整数')
    if (args.includes('--one') && args.includes('--case-limit')) throw new Error('--one 与 --case-limit 不能同时使用')
    const caseLimitValue = valueAfter(args, '--case-limit')
    let caseLimit: number | undefined
    if (args.includes('--one')) caseLimit = 1
    else if (caseLimitValue !== undefined) caseLimit = Number(caseLimitValue)
    if (caseLimit !== undefined && (!Number.isInteger(caseLimit) || caseLimit < 1)) throw new Error('--case-limit 必须是正整数')
    const agentHostId = valueAfter(args, '--agent-host')
    if (agentHostId && !isBuiltInAgentHostId(agentHostId)) throw new Error('--agent-host 只支持 codex 或 omp')
    const agentBin = valueAfter(args, '--agent-bin')
    const agentHome = valueAfter(args, '--agent-home')
    const codexBin = valueAfter(args, '--codex-bin')
    const codexHome = valueAfter(args, '--codex-home')
    const ompBin = valueAfter(args, '--omp-bin')
    const ompHome = valueAfter(args, '--omp-home')
    if (agentBin && (codexBin || ompBin)) throw new Error('--agent-bin 不能与 --codex-bin 或 --omp-bin 同时使用')
    if (agentHome && (codexHome || ompHome)) throw new Error('--agent-home 不能与 --codex-home 或 --omp-home 同时使用')
    if ((codexBin || codexHome) && (ompBin || ompHome)) throw new Error('Codex 专用参数不能与 OMP 专用参数同时使用')
    let legacyHost: 'codex' | 'omp' | undefined
    if (ompBin || ompHome) legacyHost = 'omp'
    else if (codexBin || codexHome) legacyHost = 'codex'
    if (legacyHost && agentHostId && agentHostId !== legacyHost) throw new Error('宿主专用参数与 --agent-host 不一致')
    let effectiveAgentHostId = agentHostId
    if (!effectiveAgentHostId && legacyHost) effectiveAgentHostId = legacyHost
    const code = await runEasyWorkflow({
      filePath,
      urls,
      images: valuesAfter(args, '--image'),
      ...(valueAfter(args, '--brief') ? { briefPath: valueAfter(args, '--brief')! } : {}),
      ...(valueAfter(args, '--profile') ? { profileId: valueAfter(args, '--profile')! } : {}),
      ...(caseLimit !== undefined ? { caseLimit } : {}),
      ...(valueAfter(args, '--output-dir') ? { outputDirectory: valueAfter(args, '--output-dir')! } : {}),
      ...(valueAfter(args, '--model') ? { model: valueAfter(args, '--model')! } : {}),
      ...(valueAfter(args, '--model-profile') ? { modelProfileId: valueAfter(args, '--model-profile')! } : {}),
      ...(effectiveAgentHostId ? { agentHostId: effectiveAgentHostId } : {}),
      ...(agentBin || codexBin || ompBin ? { agentExecutable: resolve((agentBin ?? codexBin ?? ompBin)!) } : {}),
      ...(agentHome || codexHome || ompHome ? { agentSourceHome: resolve((agentHome ?? codexHome ?? ompHome)!) } : {}),
      headed: args.includes('--headed'),
      ...(slowMo !== undefined ? { slowMo } : {}),
      resume: args.includes('--resume'),
      testDataAccess: args.includes('--opaque-test-data') ? 'opaque' : 'direct',
    })
    process.exitCode = code
    return
  }
  if (command === 'status') {
    const statePath = valueAfter(args, '--state') ?? await latestStatePath()
    if (!statePath) throw new Error('还没有找到历史测试结果')
    await printSummary(resolve(statePath))
    return
  }
  if (command === '--help' || command === 'help') {
    console.log('用法：npm run easy（交互菜单）')
    console.log('      npm run easy -- run --file cases.xlsx --url https://example.test/ [--agent-host codex|omp] [--agent-bin path] [--agent-home path] [--headed|--headless] [--case-limit N|--one]')
    console.log('      AgentHost 会按模型容量自动规划执行 epoch，并在需要时轮换或恢复会话；无需手工切分用例')
    console.log('      Codex 和 OMP 获得相同原始材料、可写 run 工作区、shell、网络、完整 Playwright 与结果合同')
    console.log('      中断恢复：在原命令后加入 --resume，并复用原 --output-dir')
    console.log('      AgentHost 通用模型供应商：默认 deepseek；--model-profile volcengine 或自定义 Profile 可切换；Codex/OMP 各自生成原生隔离配置')
    console.log('      默认 AgentHost 为 codex；使用 --agent-host omp 切换到 OMP RPC')
    console.log('      npm run easy -- register --profile test --url https://example.test/ [--capture-login]')
    console.log('      npm run easy -- status')
    console.log('      npm run easy -- doctor [--agent-host codex|omp]')
    return
  }
  throw new Error(`未知命令：${command}`)
}

void main()
  .catch((error: unknown) => {
    console.error(`操作失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
  .finally(() => rl.close())
