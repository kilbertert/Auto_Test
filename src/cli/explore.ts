#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AssertionIR, Diagnostic, StepIR, TestCaseIR, TestSuiteIR } from '../core/types.js'
import { applyLocatorCandidate } from '../exploration/apply-candidate.js'
import { PlaywrightCliSession } from '../exploration/cli-session.js'
import { parsePlaywrightLocator } from '../exploration/locator-parser.js'
import type { ExplorationSessionManifest, LocatorCandidateReport, LocatorInspection } from '../exploration/types.js'
import { redactSensitiveContent, slugify } from '../input/text.js'
import { resolveDataBindings, secretEnvironmentName } from '../runtime/data.js'
import { locatorExpression } from '../runtime/locator.js'
import { validateSuite } from '../validation/schema.js'

const root = process.cwd()
const artifactsRoot = resolve(root, 'artifacts/exploration')

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function requireValue(args: string[], name: string): string {
  const value = valueAfter(args, name)
  if (!value) throw new Error(`必须提供 ${name}`)
  return value
}

function assertSessionName(session: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(session)) throw new Error('session 只能包含字母、数字、下划线和连字符，最长 64 字符')
}

function manifestPath(session: string): string {
  assertSessionName(session)
  return resolve(artifactsRoot, 'sessions', `${session}.json`)
}

async function readSuite(path: string): Promise<TestSuiteIR> {
  const input = JSON.parse(await readFile(path, 'utf8')) as unknown
  const schema = validateSuite(input)
  if (!schema.valid) throw new Error(schema.diagnostics.map((item) => item.message).join('; '))
  return input as TestSuiteIR
}

async function readManifest(session: string): Promise<ExplorationSessionManifest> {
  return JSON.parse(await readFile(manifestPath(session), 'utf8')) as ExplorationSessionManifest
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o750 })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
}

function selectedCase(suite: TestSuiteIR, caseId: string): TestCaseIR {
  const testCase = suite.cases.find((item) => item.id === caseId)
  if (!testCase) throw new Error(`找不到用例: ${caseId}`)
  return testCase
}

function assertExplorationAllowed(testCase: TestCaseIR, args: string[]): void {
  if (testCase.review.status !== 'approved') throw new Error('探索会话要求用例先完成业务语义审核')
  if (testCase.review.ambiguities.length) throw new Error('用例仍有未解决歧义')
  if (testCase.risk === 'write' && !args.includes('--allow-write')) throw new Error('写入用例需要显式 --allow-write')
  if (testCase.risk === 'destructive' && !args.includes('--allow-destructive')) throw new Error('破坏性用例需要显式 --allow-destructive')
}

function normalizedOrigins(values: string[]): string[] {
  return [...new Set(values.map((value) => new URL(value).origin))]
}

function secretValues(testCase: TestCaseIR): string[] {
  return (testCase.dataBindings ?? [])
    .filter((binding) => binding.source === 'secret' && binding.secretRef)
    .map((binding) => process.env[secretEnvironmentName(binding.secretRef!)])
    .filter((value): value is string => Boolean(value))
}

function redactKnownSecrets(value: string, testCase: TestCaseIR): string {
  let redacted = redactSensitiveContent(value)
  for (const secret of secretValues(testCase)) redacted = redacted.replaceAll(secret, '<redacted-secret>')
  return redacted
}

function assertAllowedUrl(url: string, origins: string[]): void {
  const parsed = new URL(url)
  if (!origins.includes(parsed.origin)) throw new Error(`浏览器已离开 allowedOrigins: ${parsed.origin}`)
}

function findTarget(testCase: TestCaseIR, targetId: string): {
  targetType: 'step' | 'assertion' | 'cleanup'
  target: StepIR | AssertionIR
} {
  const step = testCase.steps.find((item) => item.id === targetId)
  if (step) return { targetType: 'step', target: step }
  const assertion = testCase.assertions.find((item) => item.id === targetId)
  if (assertion) return { targetType: 'assertion', target: assertion }
  const cleanup = testCase.cleanupSteps?.find((item) => item.id === targetId)
  if (cleanup) return { targetType: 'cleanup', target: cleanup }
  throw new Error(`找不到步骤或断言: ${targetId}`)
}

function inspectionProblem(target: StepIR | AssertionIR, targetType: 'step' | 'assertion' | 'cleanup', inspection: LocatorInspection): string | undefined {
  if (targetType === 'assertion') {
    const assertion = target as AssertionIR
    if (assertion.kind === 'count') return undefined
    if (assertion.kind === 'hidden') return inspection.count <= 1 ? undefined : `matched ${inspection.count}; expected 0 or 1`
    return inspection.count === 1 ? undefined : `matched ${inspection.count}; expected exactly 1`
  }
  const step = target as StepIR
  if (inspection.count !== 1) return `matched ${inspection.count}; expected exactly 1`
  if (inspection.visible !== true) return 'element is not visible'
  if (['click', 'fill', 'select', 'check', 'uncheck', 'press', 'upload'].includes(step.action) && inspection.enabled !== true) return 'element is not enabled'
  if (step.action === 'fill' && inspection.editable !== true) return 'element is not editable'
  return undefined
}

async function openCommand(args: string[]): Promise<void> {
  const irPath = resolve(requireValue(args, '--ir'))
  const suite = await readSuite(irPath)
  const caseId = requireValue(args, '--case')
  const testCase = selectedCase(suite, caseId)
  assertExplorationAllowed(testCase, args)
  const session = valueAfter(args, '--session') ?? `auto-test-${slugify(caseId)}-${Date.now().toString(36)}`
  assertSessionName(session)
  const workspaceDir = resolve(artifactsRoot, 'workspaces', session)
  const manifest: ExplorationSessionManifest = {
    version: '1.0',
    session,
    suiteId: suite.suiteId,
    caseId,
    irPath,
    baseUrl: suite.target.baseUrl,
    allowedOrigins: normalizedOrigins(suite.target.allowedOrigins),
    workspaceDir,
    headed: !args.includes('--headless'),
    createdAt: new Date().toISOString(),
  }
  assertAllowedUrl(manifest.baseUrl, manifest.allowedOrigins)
  const cli = new PlaywrightCliSession(session, workspaceDir, root)
  try {
    await cli.open(manifest.baseUrl, manifest.headed)
    assertAllowedUrl(await cli.pageUrl(), manifest.allowedOrigins)
    await writeJson(manifestPath(session), manifest)
  } catch (error) {
    try {
      await cli.close()
    } catch {
      // The browser may not have started far enough to create a session.
    }
    await cli.removeWorkspace()
    throw error
  }
  console.log(`Exploration session: ${session}`)
  console.log(`Snapshot: npm run explore -- snapshot --session ${session}`)
  console.log(`Candidate: npm run explore -- candidate --session ${session} --target <step-or-assertion-id> --ref <snapshot-ref>`)
  console.log(`Close: npm run explore -- close --session ${session}`)
}

async function snapshotCommand(args: string[]): Promise<void> {
  const session = requireValue(args, '--session')
  const manifest = await readManifest(session)
  const suite = await readSuite(manifest.irPath)
  const testCase = selectedCase(suite, manifest.caseId)
  const cli = new PlaywrightCliSession(session, manifest.workspaceDir, root)
  assertAllowedUrl(await cli.pageUrl(), manifest.allowedOrigins)
  const snapshot = redactKnownSecrets(await cli.snapshot(), testCase)
  const output = resolve(artifactsRoot, 'snapshots', `${session}-${Date.now()}.yml`)
  await mkdir(resolve(output, '..'), { recursive: true, mode: 0o750 })
  await writeFile(output, `${snapshot}\n`, { encoding: 'utf8', mode: 0o640 })
  console.log(snapshot)
  console.log(`Snapshot file: ${output}`)
}

async function candidateCommand(args: string[]): Promise<void> {
  const session = requireValue(args, '--session')
  const targetId = requireValue(args, '--target')
  const snapshotRef = requireValue(args, '--ref')
  if (!/^[a-zA-Z0-9]+$/.test(snapshotRef)) throw new Error('snapshot ref 格式非法')
  const manifest = await readManifest(session)
  const suite = await readSuite(manifest.irPath)
  const testCase = selectedCase(suite, manifest.caseId)
  const { targetType, target } = findTarget(testCase, targetId)
  const cli = new PlaywrightCliSession(session, manifest.workspaceDir, root)
  assertAllowedUrl(await cli.pageUrl(), manifest.allowedOrigins)
  const generatedExpression = await cli.generateLocator(snapshotRef)
  if (secretValues(testCase).some((value) => generatedExpression.includes(value))) {
    throw new Error('CLI 生成的定位器依赖秘密值，禁止持久化')
  }
  const locator = parsePlaywrightLocator(generatedExpression)
  const expression = locatorExpression(locator)
  const current = await cli.inspectLocator(expression)
  assertAllowedUrl(current.url, manifest.allowedOrigins)
  await cli.reload()
  const afterReload = await cli.inspectLocator(expression)
  assertAllowedUrl(afterReload.url, manifest.allowedOrigins)
  const diagnostics: Diagnostic[] = []
  const currentProblem = inspectionProblem(target, targetType, current)
  const reloadProblem = inspectionProblem(target, targetType, afterReload)
  if (currentProblem) diagnostics.push({ severity: 'error', code: 'locator_current_invalid', message: currentProblem, caseId: testCase.id })
  if (reloadProblem) diagnostics.push({ severity: 'error', code: 'locator_reload_unstable', message: reloadProblem, caseId: testCase.id })
  const report: LocatorCandidateReport = {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    suiteId: suite.suiteId,
    caseId: testCase.id,
    targetId,
    targetType,
    sourceText: target.sourceText,
    snapshotRef,
    generatedExpression,
    locator,
    current,
    afterReload,
    stableAfterReload: diagnostics.length === 0,
    diagnostics,
  }
  const output = resolve(artifactsRoot, 'candidates', `${session}-${slugify(targetId)}-${Date.now()}.json`)
  await writeJson(output, report)
  console.log(JSON.stringify(report, null, 2))
  console.log(`Candidate report: ${output}`)
  if (!report.stableAfterReload) process.exitCode = 1
}

function safeTarget(value: string): string {
  if (!value || value.startsWith('-') || value.length > 1000) throw new Error('target 格式非法')
  return value
}

async function actionCommand(args: string[]): Promise<void> {
  const session = requireValue(args, '--session')
  const action = requireValue(args, '--action')
  const manifest = await readManifest(session)
  const suite = await readSuite(manifest.irPath)
  const testCase = selectedCase(suite, manifest.caseId)
  const cli = new PlaywrightCliSession(session, manifest.workspaceDir, root)
  assertAllowedUrl(await cli.pageUrl(), manifest.allowedOrigins)

  if (action === 'goto') {
    const url = new URL(requireValue(args, '--url'), manifest.baseUrl).href
    assertAllowedUrl(url, manifest.allowedOrigins)
    await cli.runAction(['goto', url])
  } else if (action === 'click' || action === 'check' || action === 'uncheck') {
    await cli.runAction([action, safeTarget(requireValue(args, '--target'))])
  } else if (action === 'fill' || action === 'select') {
    const target = safeTarget(requireValue(args, '--target'))
    const valueRef = valueAfter(args, '--value-ref')
    let value = valueAfter(args, '--value')
    if (valueRef) {
      const binding = testCase.dataBindings?.find((item) => item.name === valueRef)
      if (!binding) throw new Error(`找不到数据绑定: ${valueRef}`)
      value = String(resolveDataBindings([binding])[valueRef])
    }
    if (value === undefined) throw new Error(`${action} 必须提供 --value-ref 或 --value`)
    await cli.runAction([action, target, value])
  } else if (action === 'press') {
    await cli.runAction(['press', requireValue(args, '--key')])
  } else if (action === 'reload') {
    await cli.reload()
  } else {
    throw new Error(`不允许的探索动作: ${action}`)
  }
  const url = await cli.pageUrl()
  assertAllowedUrl(url, manifest.allowedOrigins)
  console.log(`Action completed: ${action}`)
  console.log(`Page: ${new URL(url).origin}${new URL(url).pathname}`)
}

async function closeCommand(args: string[]): Promise<void> {
  const session = requireValue(args, '--session')
  const path = manifestPath(session)
  const manifest = await readManifest(session)
  const cli = new PlaywrightCliSession(session, manifest.workspaceDir, root)
  try {
    await cli.close()
  } finally {
    await cli.removeWorkspace()
    await writeJson(path, { ...manifest, closedAt: new Date().toISOString() })
  }
  console.log(`Closed exploration session: ${session}`)
}

async function applyCommand(args: string[]): Promise<void> {
  const irPath = resolve(requireValue(args, '--ir'))
  const candidatePath = resolve(requireValue(args, '--candidate'))
  const output = resolve(requireValue(args, '--output'))
  if (output === irPath) throw new Error('apply 必须输出到新文件，不能覆盖原 IR')
  const suite = await readSuite(irPath)
  const report = JSON.parse(await readFile(candidatePath, 'utf8')) as LocatorCandidateReport
  const updated = applyLocatorCandidate(suite, report)
  const schema = validateSuite(updated)
  if (!schema.valid) throw new Error(schema.diagnostics.map((item) => item.message).join('; '))
  await writeJson(output, updated)
  console.log(`Updated IR: ${output}`)
  console.log('Only the target locator was changed; review status and assertion oracle were preserved.')
}

async function main(): Promise<void> {
  process.umask(0o027)
  const args = process.argv.slice(2)
  const command = args[0]
  if (!command || args.includes('--help')) {
    console.log('用法: npm run explore -- <open|snapshot|action|candidate|apply|close> [options]')
    return
  }
  if (command === 'open') await openCommand(args.slice(1))
  else if (command === 'snapshot') await snapshotCommand(args.slice(1))
  else if (command === 'action') await actionCommand(args.slice(1))
  else if (command === 'candidate') await candidateCommand(args.slice(1))
  else if (command === 'apply') await applyCommand(args.slice(1))
  else if (command === 'close') await closeCommand(args.slice(1))
  else throw new Error(`未知探索命令: ${command}`)
}

void main().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : String(error)
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('AUTO_TEST_SECRET_') && value) message = message.replaceAll(value, '<redacted-secret>')
  }
  console.error(`探索失败: ${redactSensitiveContent(message)}`)
  process.exitCode = 1
})
