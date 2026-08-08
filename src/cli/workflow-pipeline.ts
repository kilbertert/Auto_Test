#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runAutonomousWorkflow } from '../workflow/autonomous-controller.js'
import type { AutonomousWorkflowPolicy } from '../workflow/autonomy-types.js'
import { ensureEnvironmentAuthentication } from '../workflow/auth-broker.js'
import { elapsedSeconds, runWithWorkflowProgress, WorkflowProgressRecorder } from '../workflow/diagnostics.js'
import {
  defaultEnvironmentProfileRegistryPath,
  loadEnvironmentProfileContext,
  loadEnvironmentProfileSecrets,
  loadEnvironmentProfileRegistry,
  resolveEnvironmentProfileTargets,
  selectEnvironmentProfile,
  type EnvironmentProfile,
} from '../workflow/environment-profile.js'
import { assessMutationRecovery } from '../workflow/failure-diagnosis.js'
import { CodexCliWorkflowLocatorResolver } from '../workflow/locator-resolver.js'
import { approveExploredWorkflowPlan, exploreWorkflowPlan, type WorkflowPlanExplorationReport } from '../workflow/plan-exploration.js'
import { readSanitizedPageEvidence, refineWorkflowDraftFromExploration } from '../workflow/plan-refinement.js'
import { planWorkflow } from '../workflow/planner.js'
import { CodexCliWorkflowPlanner } from '../workflow/planner-provider.js'
import type { WorkflowPlanDraft } from '../workflow/planner-types.js'
import { projectDraftToExecutionPlan, validateWorkflowPlanDraft } from '../workflow/planner-validation.js'
import { PlaywrightWorkflowDriver } from '../workflow/playwright-driver.js'
import { planWorkflowRecoveryContracts } from '../workflow/recovery-planner.js'
import { executeWorkflow, workflowResumeTarget, workflowStateNeedsMutationRecovery } from '../workflow/runtime-engine.js'
import { WorkflowStateStore } from '../workflow/runtime-state.js'
import { intakeWorkflowXlsx } from '../workflow/intake.js'
import { discoverWorkflowInputBundle } from '../workflow/input-bundle.js'
import { workflowSecretEnvironment } from '../workflow/intake-secrets.js'
import { environmentTargetUrls } from '../workflow/target-urls.js'

interface PipelineOptions {
  filePath: string
  urls: string[]
  images: string[]
  briefPath?: string
  draftPath?: string
  seedPath?: string
  outputDirectory: string
  model?: string
  maxRefinements: number
  storageStateByTarget: Record<string, string>
  sessionStorageByTarget: Record<string, string>
  allowWrite: boolean
  allowDestructive: boolean
  approve: boolean
  reviewer?: string
  execute: boolean
  maxIterations?: number
  iterationOffset?: number
  autonomous: boolean
  maxEnvironmentRetries: number
  profileId?: string
  profileRegistryPath?: string
  headed: boolean
  slowMo?: number
}

function help(): string {
  return [
    '用法:',
    '  npm run pipeline:workflow -- --file <workflow.xlsx> [--url <url> ...] [选项]',
    '',
    '核心选项:',
    '  --brief <path>              测试工程师补充说明',
    '  --image <path>              补充截图，可重复',
    '  --draft <path>              从已有 Draft 继续，不重新调用初始 Planner',
    '  --seed-exploration <path>   复用兼容探索证据',
    '  --output-dir <path>         流水线产物目录',
    '  --model <id>                Planner/Refiner 模型',
    '  --max-refinements <count>   安全只读失败的最大自动修订轮数，默认 3',
    '  --autonomous                启用持久化自治控制器；策略通过后自动执行',
    '                              自治执行必须显式提供至少一个 --url；非自治 intake/planning 可仅解析 Excel',
    '  --max-environment-retries N 环境错误自动重试次数，默认 2',
    '  --profile <id>              指定已注册的环境 Profile',
    `  --profile-registry <path>   环境 Profile Registry，默认 ${defaultEnvironmentProfileRegistryPath()}`,
    '',
    '浏览器与风险:',
    '  --headed                    显示 Chromium 自动化操作',
    '  --headless                  使用无头 Chromium（默认）',
    '  --slow-mo <ms>              每个 Playwright 动作减速指定毫秒',
    '  --storage-state <id>=<path> 目标 storageState，可重复',
    '  --session-storage <id>=<path> 目标 sessionStorage，可重复',
    '  --allow-write               允许 write phase',
    '  --allow-destructive         允许 destructive phase',
    '',
    '审核与执行:',
    '  --approve --reviewer <name> 显式通过审核门并生成 Execution Plan',
    '  --execute                   审核后立即运行 Runtime',
    '  --max-iterations <count>    每个循环 group 最多执行 N 条',
    '  --iteration-offset <count>  从循环数据索引 N 开始',
  ].join('\n')
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function valuesAfter(args: string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index++) if (args[index] === name && args[index + 1]) values.push(args[index + 1]!)
  return values
}

function targetPaths(args: string[], name: string): Record<string, string> {
  return Object.fromEntries(valuesAfter(args, name).map((value) => {
    const separator = value.indexOf('=')
    if (separator <= 0 || separator === value.length - 1) throw new Error(`${name} 格式必须为 <target-id>=<path>`)
    return [value.slice(0, separator), resolve(value.slice(separator + 1))]
  }))
}

function integerOption(args: string[], name: string, fallback?: number): number | undefined {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const raw = args[index + 1]
  if (!raw || raw.startsWith('--')) throw new Error(`${name} 必须提供取值`)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数`)
  return value
}

function parseArgs(args: string[]): PipelineOptions {
  if (args.includes('--help')) {
    console.log(help())
    process.exit(0)
  }
  const file = valueAfter(args, '--file')
  if (!file) throw new Error('必须提供 --file')
  const approve = args.includes('--approve')
  const reviewer = valueAfter(args, '--reviewer')
  const execute = args.includes('--execute')
  const autonomous = args.includes('--autonomous')
  if (autonomous && (approve || reviewer || execute)) throw new Error('--autonomous 不能与 --approve、--reviewer 或 --execute 同时使用')
  if (approve !== Boolean(reviewer)) throw new Error('--approve 与 --reviewer 必须同时提供')
  if (execute && !approve) throw new Error('--execute 需要 --approve --reviewer')
  const maxRefinements = integerOption(args, '--max-refinements', 3)!
  if (maxRefinements < 1) throw new Error('--max-refinements 必须大于 0')
  const maxIterations = integerOption(args, '--max-iterations')
  if (maxIterations !== undefined && maxIterations < 1) throw new Error('--max-iterations 必须大于 0')
  const iterationOffset = integerOption(args, '--iteration-offset')
  const maxEnvironmentRetries = integerOption(args, '--max-environment-retries', 2)!
  if (args.includes('--headed') && args.includes('--headless')) throw new Error('--headed 与 --headless 不能同时使用')
  const slowMo = integerOption(args, '--slow-mo')
  const urls = valuesAfter(args, '--url')
  if (autonomous && urls.length === 0) {
    throw new Error('自治执行必须至少提供一个 --url；Excel 中的链接仅作为测试材料上下文')
  }
  return {
    filePath: resolve(file),
    urls,
    images: valuesAfter(args, '--image').map((value) => resolve(value)),
    ...(valueAfter(args, '--brief') ? { briefPath: resolve(valueAfter(args, '--brief')!) } : {}),
    ...(valueAfter(args, '--draft') ? { draftPath: resolve(valueAfter(args, '--draft')!) } : {}),
    ...(valueAfter(args, '--seed-exploration') ? { seedPath: resolve(valueAfter(args, '--seed-exploration')!) } : {}),
    outputDirectory: resolve(valueAfter(args, '--output-dir') ?? 'artifacts/pipeline/workflow'),
    ...(valueAfter(args, '--model') ? { model: valueAfter(args, '--model')! } : {}),
    maxRefinements,
    storageStateByTarget: targetPaths(args, '--storage-state'),
    sessionStorageByTarget: targetPaths(args, '--session-storage'),
    allowWrite: args.includes('--allow-write'),
    allowDestructive: args.includes('--allow-destructive'),
    approve,
    ...(reviewer ? { reviewer } : {}),
    execute,
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(iterationOffset !== undefined ? { iterationOffset } : {}),
    autonomous,
    maxEnvironmentRetries,
    ...(valueAfter(args, '--profile') ? { profileId: valueAfter(args, '--profile')! } : {}),
    ...(valueAfter(args, '--profile-registry') ? { profileRegistryPath: resolve(valueAfter(args, '--profile-registry')!) } : {}),
    headed: args.includes('--headed'),
    ...(slowMo !== undefined ? { slowMo } : {}),
  }
}

async function jsonFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => resolve(entry.parentPath, entry.name)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function cumulativePageEvidenceFiles(outputDirectory: string, round: number): Promise<string[]> {
  const directories = Array.from(
    { length: round + 1 },
    (_, index) => resolve(outputDirectory, `round-${round - index}-page-evidence`),
  )
  return (await Promise.all(directories.map(jsonFiles))).flat()
}

async function writeJson(path: string, value: unknown, mode = 0o640): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode })
}

async function main(): Promise<void> {
  process.umask(0o027)
  const options = parseArgs(process.argv.slice(2))
  const inputBundle = await discoverWorkflowInputBundle({
    filePath: options.filePath,
    ...(options.briefPath ? { briefPath: options.briefPath } : {}),
    imagePaths: options.images,
  })
  await mkdir(options.outputDirectory, { recursive: true, mode: 0o750 })
  const progress = await WorkflowProgressRecorder.open(resolve(options.outputDirectory, 'run-events.jsonl'))
  const mediaDirectory = resolve(options.outputDirectory, 'media')
  await mkdir(mediaDirectory, { recursive: true, mode: 0o750 })
  const browserOptions = {
    headless: !options.headed,
    ...(options.slowMo !== undefined ? { slowMo: options.slowMo } : {}),
  }
  console.log(`Browser mode: ${options.headed ? 'headed' : 'headless'}${options.slowMo !== undefined ? `; slowMo=${options.slowMo}ms` : ''}`)

  const intake = await runWithWorkflowProgress(progress, {
    stage: 'intake',
    operation: 'intake.parse',
    startMessage: '[Intake] 正在解析 Excel、URL 和图片资产',
    heartbeatMessage: (elapsedMs) => `[Intake] 仍在解析输入，已等待 ${elapsedSeconds(elapsedMs)}`,
    successMessage: (elapsedMs) => `[Intake] 输入解析完成，耗时 ${elapsedSeconds(elapsedMs)}`,
  }, () => intakeWorkflowXlsx({
    filePath: options.filePath,
    additionalUrls: options.urls,
    supplementalImagePaths: inputBundle.imagePaths,
  }))
  await writeJson(resolve(options.outputDirectory, 'intake.workflow.json'), intake.manifest)
  await writeJson(resolve(options.outputDirectory, 'intake.diagnostics.json'), intake.report)
  for (const asset of intake.assets) await writeFile(resolve(mediaDirectory, asset.metadata.fileName), asset.content, { mode: 0o640 })
  if (intake.report.summary.errors > 0) throw new Error('Workflow Intake contains blocking diagnostics')

  let environment = workflowSecretEnvironment(intake.secretMaterial)
  let plannerBrief = inputBundle.brief
  const provider = new CodexCliWorkflowPlanner({ ...(options.model ? { model: options.model } : {}) })
  let environmentProfile: EnvironmentProfile | undefined
  if (options.autonomous) {
    const registryPath = options.profileRegistryPath ?? defaultEnvironmentProfileRegistryPath()
    try {
      const registry = await loadEnvironmentProfileRegistry(registryPath)
      environmentProfile = selectEnvironmentProfile(registry, environmentTargetUrls(intake.manifest), options.profileId)
      environment = workflowSecretEnvironment(await loadEnvironmentProfileSecrets(environmentProfile), environment)
      plannerBrief = [await loadEnvironmentProfileContext(environmentProfile), plannerBrief].filter(Boolean).join('\n\n')
      console.log(`Environment profile: ${environmentProfile.id}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options.profileId || options.profileRegistryPath) throw error
    }
  }
  const createDraft = async (): Promise<WorkflowPlanDraft> => {
    const draft = options.draftPath
      ? validateWorkflowPlanDraft(JSON.parse(await readFile(options.draftPath, 'utf8')) as unknown)
      : await planWorkflow({
          manifest: intake.manifest,
          mediaDirectory,
          brief: plannerBrief,
          provider,
          workspaceDirectory: resolve(options.outputDirectory, 'planner-workspace'),
          progress,
        })
    if (draft.sourceSha256 !== intake.manifest.source.sha256) throw new Error('Draft source hash does not match the Intake source')
    return draft
  }

  if (options.autonomous) {
    const initialSeed = options.seedPath
      ? JSON.parse(await readFile(options.seedPath, 'utf8')) as WorkflowPlanExplorationReport
      : undefined
    const targetAdapters = (targets: WorkflowPlanDraft['targets']) => {
      const resolvedProfile = environmentProfile ? resolveEnvironmentProfileTargets(environmentProfile, targets) : undefined
      return {
        storageStateByTarget: {
          ...(resolvedProfile?.storageStateByTarget ?? {}),
          ...options.storageStateByTarget,
        },
        sessionStorageByTarget: {
          ...(resolvedProfile?.sessionStorageByTarget ?? {}),
          ...options.sessionStorageByTarget,
        },
      }
    }
    const allowWrite = options.allowWrite || environmentProfile?.policy.allowWrite === true
    const allowDestructive = options.allowDestructive || environmentProfile?.policy.allowDestructive === true
    const policy: AutonomousWorkflowPolicy = {
      id: 'cli-autonomy-v1',
      autoApprove: true,
      allowedRisks: [
        'read',
        ...(allowWrite ? ['write' as const] : []),
        ...(allowDestructive ? ['destructive' as const] : []),
      ],
      requireRecoveryFor: ['write', 'destructive'],
      maxRefinements: environmentProfile?.policy.maxRefinements ?? options.maxRefinements,
      maxEnvironmentRetries: environmentProfile?.policy.maxEnvironmentRetries ?? options.maxEnvironmentRetries,
    }
    const result = await runAutonomousWorkflow({
      outputDirectory: options.outputDirectory,
      resumeBlocked: true,
      resumeExhaustedTestCode: true,
      requestSha256: createHash('sha256').update(JSON.stringify({
        sourceSha256: intake.manifest.source.sha256,
        targetUrls: intake.manifest.targetUrls,
        profileId: environmentProfile?.id ?? null,
        maxIterations: options.maxIterations ?? null,
        iterationOffset: options.iterationOffset ?? null,
        headed: options.headed,
        slowMo: options.slowMo ?? null,
        briefSha256: createHash('sha256').update(plannerBrief).digest('hex'),
        supplementalImageSha256s: inputBundle.imageSha256s,
      })).digest('hex'),
      policy,
      operations: {
        plan: async () => planWorkflowRecoveryContracts({
          draft: await createDraft(),
          provider,
          workspaceDirectory: resolve(options.outputDirectory, 'recovery-planner-workspace'),
          progress,
        }),
        explore: async (draft, round, previous) => {
          return runWithWorkflowProgress(progress, {
            stage: 'exploring',
            operation: 'workflow.explore',
            attempt: round + 1,
            startMessage: `[Explore] 正在执行第 ${round + 1} 轮页面探索`,
            heartbeatMessage: (elapsedMs) => `[Explore] 第 ${round + 1} 轮仍在运行，已等待 ${elapsedSeconds(elapsedMs)}`,
            successMessage: (elapsedMs) => `[Explore] 第 ${round + 1} 轮页面探索完成，耗时 ${elapsedSeconds(elapsedMs)}`,
          }, async () => {
            if (environmentProfile) await ensureEnvironmentAuthentication(environmentProfile, environment, browserOptions)
            const evidenceDirectory = resolve(options.outputDirectory, `round-${round}-page-evidence`)
            const seed = previous ?? initialSeed
            const stateStore = new WorkflowStateStore(resolve(options.outputDirectory, `round-${round}.autonomous.state.json`))
            let existingState = await stateStore.load()
            if (existingState && existingState.mutations.length === 0 && !workflowStateNeedsMutationRecovery(existingState)) {
              await stateStore.clear()
              existingState = undefined
            }
            const stopAfterRecovery = existingState ? workflowStateNeedsMutationRecovery(existingState) : false
            const internalPlan = projectDraftToExecutionPlan(draft)
            const resumeFromTarget = existingState ? workflowResumeTarget(existingState, internalPlan) : undefined
            const adapters = targetAdapters(draft.targets)
            return exploreWorkflowPlan(draft, new PlaywrightWorkflowDriver({
              ...browserOptions,
              storageStateByTarget: adapters.storageStateByTarget,
              sessionStorageByTarget: adapters.sessionStorageByTarget,
            }), {
              resolver: new CodexCliWorkflowLocatorResolver({ ...(options.model ? { model: options.model } : {}) }),
              evidenceDirectory,
              stateStore,
              allowWrite,
              allowDestructive,
              requireRecoveryFor: policy.requireRecoveryFor,
              autoRecover: true,
              ...(stopAfterRecovery ? { stopAfterRecovery: true } : {}),
              ...(resumeFromTarget ? { resume: true, resumeFromTarget } : {}),
              environment,
              ...(options.maxIterations !== undefined ? { maxIterationsPerGroup: options.maxIterations } : {}),
              ...(options.iterationOffset !== undefined ? { iterationOffsetPerGroup: options.iterationOffset } : {}),
              ...(seed ? { seedReport: seed, allowCompatibleSeed: true } : {}),
            })
          })
        },
        refine: async (draft, exploration, round) => refineWorkflowDraftFromExploration({
          draft,
          exploration,
          pageEvidence: await readSanitizedPageEvidence(await cumulativePageEvidenceFiles(options.outputDirectory, round)),
          provider,
          workspaceDirectory: resolve(options.outputDirectory, `round-${round + 1}-refinement-workspace`),
          progress,
        }),
        execute: async (plan, attempt) => {
          return runWithWorkflowProgress(progress, {
            stage: 'executing',
            operation: 'workflow.execute',
            attempt,
            startMessage: `[Runtime] 正在执行第 ${attempt} 次正式测试`,
            heartbeatMessage: (elapsedMs) => `[Runtime] 第 ${attempt} 次正式测试仍在运行，已等待 ${elapsedSeconds(elapsedMs)}`,
            successMessage: (elapsedMs) => `[Runtime] 第 ${attempt} 次正式测试完成，耗时 ${elapsedSeconds(elapsedMs)}`,
          }, async () => {
            if (environmentProfile) await ensureEnvironmentAuthentication(environmentProfile, environment, browserOptions)
            const stateStore = new WorkflowStateStore(resolve(options.outputDirectory, `runtime-attempt-${attempt}.state.json`))
            const existingState = await stateStore.load()
            const resumeFromTarget = existingState ? workflowResumeTarget(existingState, plan) : undefined
            const adapters = targetAdapters(plan.targets)
            return executeWorkflow(plan, new PlaywrightWorkflowDriver({
              ...browserOptions,
              storageStateByTarget: adapters.storageStateByTarget,
              sessionStorageByTarget: adapters.sessionStorageByTarget,
            }), {
              allowWrite,
              allowDestructive,
              requireRecoveryFor: policy.requireRecoveryFor,
              autoRecover: true,
              stateStore,
              ...(resumeFromTarget ? { resume: true, resumeFromTarget } : {}),
              environment,
              ...(options.maxIterations !== undefined ? { maxIterationsPerGroup: options.maxIterations } : {}),
              ...(options.iterationOffset !== undefined ? { iterationOffsetPerGroup: options.iterationOffset } : {}),
            })
          })
        },
      },
    })
    console.log(`Autonomous job: ${result.state.jobId}`)
    console.log(`Autonomous outcome: ${result.state.outcome ?? result.state.status}`)
    console.log(`Autonomous state: ${resolve(options.outputDirectory, 'autonomous-job.state.json')}`)
    if (result.state.humanInputRequestPath) console.log(`Human input required: ${result.state.humanInputRequestPath}`)
    if (result.state.outcome !== 'passed') process.exitCode = 1
    return
  }

  let draft = await createDraft()
  let seed = options.seedPath
    ? JSON.parse(await readFile(options.seedPath, 'utf8')) as WorkflowPlanExplorationReport
    : undefined
  let passedReport: WorkflowPlanExplorationReport | undefined

  for (let round = 0; round <= options.maxRefinements; round++) {
    const draftPath = resolve(options.outputDirectory, `round-${round}.plan-draft.json`)
    const reportPath = resolve(options.outputDirectory, `round-${round}.exploration.json`)
    const evidenceDirectory = resolve(options.outputDirectory, `round-${round}-page-evidence`)
    await writeJson(draftPath, draft)
    const driver = new PlaywrightWorkflowDriver({
      ...browserOptions,
      storageStateByTarget: options.storageStateByTarget,
      sessionStorageByTarget: options.sessionStorageByTarget,
    })
    const report = await runWithWorkflowProgress(progress, {
      stage: 'exploring',
      operation: 'workflow.explore',
      attempt: round + 1,
      startMessage: `[Explore] 正在执行第 ${round + 1} 轮页面探索`,
      heartbeatMessage: (elapsedMs) => `[Explore] 第 ${round + 1} 轮仍在运行，已等待 ${elapsedSeconds(elapsedMs)}`,
      successMessage: (elapsedMs) => `[Explore] 第 ${round + 1} 轮页面探索完成，耗时 ${elapsedSeconds(elapsedMs)}`,
    }, () => exploreWorkflowPlan(draft, driver, {
      resolver: new CodexCliWorkflowLocatorResolver({ ...(options.model ? { model: options.model } : {}) }),
      evidenceDirectory,
      stateStore: new WorkflowStateStore(resolve(options.outputDirectory, `round-${round}.state.json`)),
      allowWrite: options.allowWrite,
      allowDestructive: options.allowDestructive,
      autoRecover: true,
      environment,
      ...(options.maxIterations !== undefined ? { maxIterationsPerGroup: options.maxIterations } : {}),
      ...(options.iterationOffset !== undefined ? { iterationOffsetPerGroup: options.iterationOffset } : {}),
      ...(seed ? { seedReport: seed, allowCompatibleSeed: true } : {}),
    }))
    await writeJson(reportPath, report)
    if (report.status === 'passed') {
      passedReport = report
      break
    }
    if (report.runtimeResult.error?.includes('explicit approval')) throw new Error(report.runtimeResult.error)
    if (round === options.maxRefinements) throw new Error(`Exploration did not pass after ${round} refinement rounds`)
    const refined = await refineWorkflowDraftFromExploration({
      draft,
      exploration: report,
      pageEvidence: await readSanitizedPageEvidence(await cumulativePageEvidenceFiles(options.outputDirectory, round)),
      provider,
      workspaceDirectory: resolve(options.outputDirectory, `round-${round + 1}-refinement-workspace`),
      progress,
    })
    await writeJson(resolve(options.outputDirectory, `round-${round + 1}.plan-draft.json`), refined)
    const recovery = assessMutationRecovery(report.runtimeResult)
    if (recovery.attempted && !recovery.safeToRetry) {
      throw new Error(`A write/destructive phase executed before exploration failed. Recover the target system, then resume with --draft ${resolve(options.outputDirectory, `round-${round + 1}.plan-draft.json`)} --seed-exploration ${reportPath}`)
    }
    draft = refined
    seed = report
  }

  if (!passedReport) throw new Error('Pipeline ended without a passed exploration')
  const finalDraftPath = resolve(options.outputDirectory, 'workflow.plan-draft.json')
  const explorationPath = resolve(options.outputDirectory, 'workflow.exploration.json')
  await writeJson(finalDraftPath, draft)
  await writeJson(explorationPath, passedReport)
  console.log(`Review gate ready: ${finalDraftPath}`)
  console.log(`Exploration: ${explorationPath}`)
  if (!options.approve) return

  const plan = approveExploredWorkflowPlan(draft, passedReport, options.reviewer!)
  const planPath = resolve(options.outputDirectory, 'workflow.execution-plan.json')
  await writeJson(planPath, plan)
  console.log(`Approved plan: ${planPath}`)
  if (!options.execute) return

  const result = await runWithWorkflowProgress(progress, {
    stage: 'executing',
    operation: 'workflow.execute',
    attempt: 1,
    startMessage: '[Runtime] 正在执行正式测试',
    heartbeatMessage: (elapsedMs) => `[Runtime] 正式测试仍在运行，已等待 ${elapsedSeconds(elapsedMs)}`,
    successMessage: (elapsedMs) => `[Runtime] 正式测试完成，耗时 ${elapsedSeconds(elapsedMs)}`,
  }, () => executeWorkflow(plan, new PlaywrightWorkflowDriver({
    ...browserOptions,
    storageStateByTarget: options.storageStateByTarget,
    sessionStorageByTarget: options.sessionStorageByTarget,
  }), {
    allowWrite: options.allowWrite,
    allowDestructive: options.allowDestructive,
    autoRecover: true,
    stateStore: new WorkflowStateStore(resolve(options.outputDirectory, 'workflow.runtime.state.json')),
    environment,
    ...(options.maxIterations !== undefined ? { maxIterationsPerGroup: options.maxIterations } : {}),
    ...(options.iterationOffset !== undefined ? { iterationOffsetPerGroup: options.iterationOffset } : {}),
  }))
  const resultPath = resolve(options.outputDirectory, 'workflow.runtime.result.json')
  await writeJson(resultPath, result)
  console.log(`Runtime status: ${result.status}`)
  console.log(`Runtime evidence: ${resultPath}`)
  if (result.status !== 'passed') process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(`Workflow pipeline failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
