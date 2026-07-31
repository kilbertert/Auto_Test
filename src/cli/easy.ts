#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { access, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, extname, resolve } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { chromium } from '@playwright/test'
import crossSpawn from 'cross-spawn'
import {
  matchingEnvironmentProfiles,
  normalizeTargetUrls,
  registerEnvironment,
  safeProfileId,
  type EasyRiskLevel,
} from '../usability/environment-registration.js'
import { friendlyRunSummary } from '../usability/result-summary.js'
import { defaultEnvironmentProfileRegistryPath } from '../workflow/environment-profile.js'

interface EasyRunOptions {
  filePath: string
  urls: string[]
  profileId?: string
  maxIterations?: number
  outputDirectory?: string
  headed?: boolean
  slowMo?: number
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

async function chooseRisk(): Promise<EasyRiskLevel> {
  console.log('\n本环境允许的最高操作范围：')
  console.log('  1. 只读查看（推荐）')
  console.log('  2. 允许新增、修改、启动等写入操作')
  console.log('  3. 允许本轮测试数据的停止、删除、结算等清理操作')
  const value = await ask('请选择', '1')
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

async function registerInteractive(initialUrls: string[] = []): Promise<string> {
  const urls = initialUrls.length > 0
    ? normalizeTargetUrls(initialUrls)
    : normalizeTargetUrls(urlValues(await ask('粘贴需要访问的网站 URL；多个地址用空格分开')))
  const suggested = safeProfileId('', urls)
  const profileId = safeProfileId(await ask('给这个测试环境起个简短名称', suggested), urls)
  const captureLogin = await confirm('这些网站是否需要登录', true)
  const risk = await chooseRisk()
  console.log('\n正在注册环境，请不要关闭本窗口……')
  const result = await registerEnvironment({
    profileId,
    urls,
    risk,
    captureLogin,
    ...(captureLogin ? { waitForLogin: waitForManualLogin } : {}),
  })
  console.log(`\n环境“${result.profile.id}”已注册。后续测试会自动复用登录状态和权限设置。`)
  console.log(`配置位置：${result.registryPath}`)
  return result.profile.id
}

function timestamp(): string {
  const now = new Date()
  const value = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  return value
}

function defaultRunDirectory(filePath: string): string {
  const stem = basename(filePath, extname(filePath)).replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 48) || 'workflow'
  return resolve('artifacts', 'runs', `${timestamp()}-${stem}-${Date.now().toString(36).slice(-5)}`)
}

function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
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
  await access(filePath)
  const urls = normalizeTargetUrls(options.urls)
  let profileId = options.profileId
  if (!profileId) {
    const profiles = await matchingEnvironmentProfiles(urls)
    if (profiles.length === 1) profileId = profiles[0]!.id
    else if (profiles.length > 1) {
      console.log(`找到多个匹配环境：${profiles.map((profile) => profile.id).join('、')}`)
      profileId = await ask('请输入本次使用的环境名称', profiles[0]!.id)
    } else if (input.isTTY) {
      console.log('这些网站尚未注册，先用向导完成一次环境注册。')
      profileId = await registerInteractive(urls)
    } else {
      throw new Error('这些网站尚未注册。请先运行 npm run easy，选择“注册或更新测试环境”。')
    }
  }
  const outputDirectory = resolve(options.outputDirectory ?? defaultRunDirectory(filePath))
  await mkdir(outputDirectory, { recursive: true, mode: 0o750 })
  console.log(`\n本次结果目录：${outputDirectory}`)
  const args = [
    'run', 'autonomous:workflow', '--',
    '--file', filePath,
    ...urls.flatMap((url) => ['--url', url]),
    ...(profileId ? ['--profile', profileId] : []),
    ...(options.maxIterations ? ['--max-iterations', String(options.maxIterations)] : []),
    options.headed ? '--headed' : '--headless',
    ...(options.slowMo !== undefined ? ['--slow-mo', String(options.slowMo)] : []),
    '--output-dir', outputDirectory,
  ]
  const exitCode = await spawnInherited(npmExecutable(), args)
  const statePath = resolve(outputDirectory, 'autonomous-job.state.json')
  try {
    await printSummary(statePath)
  } catch {
    console.log('\n框架未能生成结果摘要，请查看上方错误信息。')
  }
  return exitCode
}

async function runInteractive(): Promise<void> {
  const selected = await windowsExcelPicker()
  const filePath = selected ?? stripDraggedPath(await ask('将测试用例 Excel 拖到窗口中，然后按回车'))
  console.log(`已选择：${filePath}`)
  const urls = urlValues(await ask('粘贴网站 URL；多个地址用空格分开'))
  const single = await confirm('是否先只执行一条数据进行安全验证', true)
  const headed = await confirm('是否显示浏览器中的自动化操作', process.platform === 'win32')
  await runEasyWorkflow({
    filePath,
    urls,
    ...(single ? { maxIterations: 1 } : {}),
    headed,
    ...(headed ? { slowMo: 150 } : {}),
  })
}

async function latestStatePath(): Promise<string | undefined> {
  const root = resolve('artifacts', 'runs')
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true })
    const candidates = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name === 'autonomous-job.state.json')
      .map(async (entry) => {
        const path = resolve(entry.parentPath, entry.name)
        return { path, modified: (await stat(path)).mtimeMs }
      }))
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

async function doctor(): Promise<boolean> {
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
  const nodeCheck = { label: `Node.js ${process.version}`, ok: Number(process.versions.node.split('.')[0]) >= 24 }
  const codexInstallCheck = { label: 'Codex CLI 已安装', ok: codexInstalled }
  const providerCheck = { label: 'Codex 自定义 API Provider 已配置', ok: providerConfigured }
  const apiKeyCheck = { label: `模型 API Key 已加载（${providerEnvironmentName}）`, ok: apiKeyAvailable }
  const chromiumCheck = {
    label: 'Chromium 浏览器已安装',
    ok: await access(chromium.executablePath()).then(() => true, () => false),
  }
  const checks = [nodeCheck, codexInstallCheck, providerCheck, apiKeyCheck, chromiumCheck]
  console.log('\n环境检查：')
  for (const check of checks) console.log(`${check.ok ? '✓' : '✗'} ${check.label}`)
  if (!providerCheck.ok || !apiKeyCheck.ok) {
    console.log('  Windows 修复方式：关闭窗口后重新双击内部私有包中的 Auto-Test.cmd，安装器会自动恢复模型配置。')
  }
  if (!chromiumCheck.ok && input.isTTY && await confirm('现在安装 Chromium 浏览器', true)) {
    chromiumCheck.ok = await spawnInherited('npx', ['playwright', 'install', 'chromium']) === 0
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
    if (!await doctor()) process.exitCode = 1
    return
  }
  if (command === 'register') {
    const urls = valuesAfter(args, '--url')
    if (urls.length === 0) throw new Error('register 必须至少提供一个 --url')
    const risk = valueAfter(args, '--risk') ?? 'read'
    if (!['read', 'write', 'destructive'].includes(risk)) throw new Error('--risk 必须是 read、write 或 destructive')
    if (!args.includes('--no-login') && !input.isTTY) throw new Error('捕获登录状态需要交互终端；无需登录时请加 --no-login')
    const result = await registerEnvironment({
      profileId: valueAfter(args, '--profile') ?? safeProfileId('', urls),
      urls,
      risk: risk as EasyRiskLevel,
      captureLogin: !args.includes('--no-login'),
      ...(!args.includes('--no-login') ? { waitForLogin: waitForManualLogin } : {}),
    })
    console.log(`环境已注册：${result.profile.id}`)
    return
  }
  if (command === 'run') {
    const filePath = valueAfter(args, '--file')
    const urls = valuesAfter(args, '--url')
    if (!filePath || urls.length === 0) throw new Error('run 必须提供 --file 和至少一个 --url')
    if (args.includes('--headed') && args.includes('--headless')) throw new Error('--headed 与 --headless 不能同时使用')
    const slowMoValue = valueAfter(args, '--slow-mo')
    const slowMo = slowMoValue === undefined ? undefined : Number(slowMoValue)
    if (slowMo !== undefined && (!Number.isInteger(slowMo) || slowMo < 0)) throw new Error('--slow-mo 必须是非负整数')
    const code = await runEasyWorkflow({
      filePath,
      urls,
      ...(valueAfter(args, '--profile') ? { profileId: valueAfter(args, '--profile')! } : {}),
      ...(args.includes('--one') ? { maxIterations: 1 } : {}),
      ...(valueAfter(args, '--output-dir') ? { outputDirectory: valueAfter(args, '--output-dir')! } : {}),
      headed: args.includes('--headed'),
      ...(slowMo !== undefined ? { slowMo } : {}),
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
    console.log('      npm run easy -- run --file cases.xlsx --url https://example.test/ [--headed|--headless] [--slow-mo 150]')
    console.log('      npm run easy -- register --profile test --url https://example.test/')
    console.log('      npm run easy -- status')
    console.log('      npm run easy -- doctor')
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
