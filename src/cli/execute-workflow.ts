#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import { PlaywrightWorkflowDriver } from '../workflow/playwright-driver.js'
import { executeWorkflow } from '../workflow/runtime-engine.js'
import { WorkflowStateStore } from '../workflow/runtime-state.js'
import { validateWorkflowExecutionPlan } from '../workflow/runtime-validation.js'
import { intakeWorkflowXlsx } from '../workflow/intake.js'
import { workflowSecretEnvironment } from '../workflow/intake-secrets.js'

interface CliOptions {
  planPath: string
  outputPath: string
  statePath: string
  allowWrite: boolean
  allowDestructive: boolean
  resume: boolean
  resumeFromTarget?: string
  headed: boolean
  slowMo?: number
  validateOnly: boolean
  storageStateByTarget: Record<string, string>
  sessionStorageByTarget: Record<string, string>
  maxIterations?: number
  stopBeforeTarget?: string
  iterationOffset?: number
  secretSourceXlsx?: string
}

function help(): string {
  return [
    '用法:',
    '  npm run execute:workflow -- --plan <workflow.execution-plan.json> [选项]',
    '',
    '选项:',
    '  --output <path>             执行证据 JSON 输出路径',
    '  --state <path>              私有中断状态路径（默认 artifacts/workflow-state）',
    '  --allow-write               明确批准 write 阶段',
    '  --allow-destructive         明确批准 destructive 阶段',
    '  --resume                    从已有中断状态恢复',
    '  --resume-from <target-id>   明确选择恢复的步骤或断言；不会自动猜测',
    '  --headed                    使用有头 Chromium',
    '  --slow-mo <ms>              浏览器动作减速',
    '  --storage-state <id>=<path>  为指定 target 注入私有 Playwright storageState，可重复',
    '  --session-storage <id>=<path> 为指定 target 注入私有 sessionStorage adapter，可重复',
    '  --max-iterations <count>     每个循环 group 最多执行前 N 个条目（canary 用）',
    '  --iteration-offset <count>   从循环数据的第 N 个索引开始执行',
    '  --stop-before <target-id>    执行到目标前停止并输出 partial 证据',
    '  --validate-only             只校验计划，不解析秘密或启动浏览器',
    '  --secret-source-xlsx <path> 从原始 XLSX 在内存中解析 secretRef 值，不写入报告或状态',
    '  --help                      显示帮助',
  ].join('\n')
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function valuesAfter(args: string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]!)
  }
  return values
}

function parseArgs(args: string[]): CliOptions {
  if (args.includes('--help')) {
    console.log(help())
    process.exit(0)
  }
  const input = valueAfter(args, '--plan')
  if (!input) throw new Error('必须提供 --plan')
  const planPath = resolve(input)
  const stem = basename(planPath, extname(planPath)).replace(/[^\p{L}\p{N}._-]+/gu, '-')
  const slowMoValue = valueAfter(args, '--slow-mo')
  const slowMo = slowMoValue === undefined ? undefined : Number(slowMoValue)
  if (slowMo !== undefined && (!Number.isInteger(slowMo) || slowMo < 0)) throw new Error('--slow-mo 必须是非负整数')
  const maxIterationsValue = valueAfter(args, '--max-iterations')
  const maxIterations = maxIterationsValue === undefined ? undefined : Number(maxIterationsValue)
  if (maxIterations !== undefined && (!Number.isInteger(maxIterations) || maxIterations <= 0)) throw new Error('--max-iterations 必须是正整数')
  const iterationOffsetValue = valueAfter(args, '--iteration-offset')
  const iterationOffset = iterationOffsetValue === undefined ? undefined : Number(iterationOffsetValue)
  if (iterationOffset !== undefined && (!Number.isInteger(iterationOffset) || iterationOffset < 0)) throw new Error('--iteration-offset 必须是非负整数')
  const storageStateByTarget: Record<string, string> = {}
  for (const value of valuesAfter(args, '--storage-state')) {
    const separator = value.indexOf('=')
    if (separator <= 0 || separator === value.length - 1) throw new Error('--storage-state 格式必须为 <target-id>=<path>')
    storageStateByTarget[value.slice(0, separator)] = resolve(value.slice(separator + 1))
  }
  const sessionStorageByTarget: Record<string, string> = {}
  for (const value of valuesAfter(args, '--session-storage')) {
    const separator = value.indexOf('=')
    if (separator <= 0 || separator === value.length - 1) throw new Error('--session-storage 格式必须为 <target-id>=<path>')
    sessionStorageByTarget[value.slice(0, separator)] = resolve(value.slice(separator + 1))
  }
  const resume = args.includes('--resume')
  const resumeFromTarget = valueAfter(args, '--resume-from')
  const stopBeforeTarget = valueAfter(args, '--stop-before')
  const secretSourceXlsx = valueAfter(args, '--secret-source-xlsx')
  if (resume !== Boolean(resumeFromTarget)) throw new Error('--resume 与 --resume-from 必须同时提供')
  return {
    planPath,
    outputPath: resolve(valueAfter(args, '--output') ?? `artifacts/workflow-runs/${stem}.result.json`),
    statePath: resolve(valueAfter(args, '--state') ?? `artifacts/workflow-state/${stem}.state.json`),
    allowWrite: args.includes('--allow-write'),
    allowDestructive: args.includes('--allow-destructive'),
    resume,
    ...(resumeFromTarget ? { resumeFromTarget } : {}),
    headed: args.includes('--headed'),
    ...(slowMo !== undefined ? { slowMo } : {}),
    validateOnly: args.includes('--validate-only'),
    storageStateByTarget,
    sessionStorageByTarget,
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(stopBeforeTarget ? { stopBeforeTarget } : {}),
    ...(iterationOffset !== undefined ? { iterationOffset } : {}),
    ...(secretSourceXlsx ? { secretSourceXlsx: resolve(secretSourceXlsx) } : {}),
  }
}

async function main(): Promise<void> {
  process.umask(0o027)
  const options = parseArgs(process.argv.slice(2))
  const plan = validateWorkflowExecutionPlan(JSON.parse(await readFile(options.planPath, 'utf8')) as unknown)
  if (options.validateOnly) {
    console.log(`Workflow plan valid: ${plan.workflowId}`)
    console.log(`Groups: ${plan.groups.length}; Phases: ${plan.groups.flatMap((group) => group.phases).length}`)
    return
  }
  const driver = new PlaywrightWorkflowDriver({
    headless: !options.headed,
    ...(options.slowMo !== undefined ? { slowMo: options.slowMo } : {}),
    storageStateByTarget: options.storageStateByTarget,
    sessionStorageByTarget: options.sessionStorageByTarget,
  })
  let environment = process.env
  if (options.secretSourceXlsx) {
    const intake = await intakeWorkflowXlsx({ filePath: options.secretSourceXlsx })
    if (intake.manifest.source.sha256 !== plan.sourceSha256) throw new Error('Secret source XLSX hash does not match the execution plan source')
    environment = workflowSecretEnvironment(intake.secretMaterial)
  }
  const result = await executeWorkflow(plan, driver, {
    allowWrite: options.allowWrite,
    allowDestructive: options.allowDestructive,
    resume: options.resume,
    ...(options.resumeFromTarget ? { resumeFromTarget: options.resumeFromTarget } : {}),
    stateStore: new WorkflowStateStore(options.statePath),
    ...(options.maxIterations !== undefined ? { maxIterationsPerGroup: options.maxIterations } : {}),
    ...(options.stopBeforeTarget ? { stopBeforeTarget: options.stopBeforeTarget } : {}),
    ...(options.iterationOffset !== undefined ? { iterationOffsetPerGroup: options.iterationOffset } : {}),
    environment,
  })
  await mkdir(dirname(options.outputPath), { recursive: true, mode: 0o750 })
  await writeFile(options.outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  console.log(`Workflow: ${result.workflowId}`)
  console.log(`Run: ${result.runId}`)
  console.log(`Status: ${result.status}`)
  console.log(`Evidence: ${options.outputPath}`)
  if (result.status === 'failed') {
    try {
      await access(options.statePath)
      console.log(`Recovery state: ${options.statePath}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    process.exitCode = 1
  }
}

void main().catch((error: unknown) => {
  console.error(`工作流执行失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
