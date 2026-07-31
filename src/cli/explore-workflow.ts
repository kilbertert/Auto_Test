#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { CodexCliWorkflowLocatorResolver } from '../workflow/locator-resolver.js'
import { exploreWorkflowPlan } from '../workflow/plan-exploration.js'
import type { WorkflowPlanExplorationReport } from '../workflow/plan-exploration.js'
import { PlaywrightWorkflowDriver } from '../workflow/playwright-driver.js'
import { WorkflowStateStore } from '../workflow/runtime-state.js'
import { intakeWorkflowXlsx } from '../workflow/intake.js'
import { workflowSecretEnvironment } from '../workflow/intake-secrets.js'
import { validateWorkflowPlanDraft } from '../workflow/planner-validation.js'

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function requireValue(args: string[], name: string): string {
  const value = valueAfter(args, name)
  if (!value) throw new Error(`必须提供 ${name}`)
  return value
}

function valuesAfter(args: string[], name: string): string[] {
  const result: string[] = []
  for (let index = 0; index < args.length; index++) if (args[index] === name && args[index + 1]) result.push(args[index + 1]!)
  return result
}

function targetPaths(args: string[], name: string): Record<string, string> {
  return Object.fromEntries(valuesAfter(args, name).map((value) => {
    const separator = value.indexOf('=')
    if (separator <= 0 || separator === value.length - 1) throw new Error(`${name} 格式必须为 <target-id>=<path>`)
    return [value.slice(0, separator), resolve(value.slice(separator + 1))]
  }))
}

async function main(): Promise<void> {
  process.umask(0o027)
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('用法: npm run explore:workflow -- --draft <plan-draft.json> [--storage-state id=path] [--session-storage id=path] [--allow-write] [--allow-destructive]')
    return
  }
  const draftPath = resolve(requireValue(args, '--draft'))
  const output = resolve(valueAfter(args, '--output') ?? 'artifacts/planning/workflow.exploration.json')
  const evidenceDirectory = resolve(valueAfter(args, '--evidence-dir') ?? dirname(output), 'page-evidence')
  const statePath = resolve(valueAfter(args, '--state') ?? `${output}.state.json`)
  const draft = validateWorkflowPlanDraft(JSON.parse(await readFile(draftPath, 'utf8')) as unknown)
  const secretSource = valueAfter(args, '--secret-source-xlsx')
  let environment = process.env
  if (secretSource) {
    const intake = await intakeWorkflowXlsx({ filePath: resolve(secretSource) })
    if (intake.manifest.source.sha256 !== draft.sourceSha256) throw new Error('Secret source XLSX hash does not match the workflow draft source')
    environment = workflowSecretEnvironment(intake.secretMaterial)
  }
  const maxIterations = valueAfter(args, '--max-iterations') ? Number(valueAfter(args, '--max-iterations')) : undefined
  const iterationOffset = valueAfter(args, '--iteration-offset') ? Number(valueAfter(args, '--iteration-offset')) : undefined
  const stopBeforeTarget = valueAfter(args, '--stop-before')
  const startFromTarget = valueAfter(args, '--start-from')
  const driver = new PlaywrightWorkflowDriver({
    headless: !args.includes('--headed'),
    storageStateByTarget: targetPaths(args, '--storage-state'),
    sessionStorageByTarget: targetPaths(args, '--session-storage'),
  })
  const seedPath = valueAfter(args, '--seed-exploration')
  const seedReport = seedPath
    ? JSON.parse(await readFile(resolve(seedPath), 'utf8')) as WorkflowPlanExplorationReport
    : undefined
  const report = await exploreWorkflowPlan(draft, driver, {
    resolver: new CodexCliWorkflowLocatorResolver({ ...(valueAfter(args, '--model') ? { model: valueAfter(args, '--model')! } : {}) }),
    evidenceDirectory,
    stateStore: new WorkflowStateStore(statePath),
    allowWrite: args.includes('--allow-write'),
    allowDestructive: args.includes('--allow-destructive'),
    environment,
    ...(maxIterations !== undefined ? { maxIterationsPerGroup: maxIterations } : {}),
    ...(iterationOffset !== undefined ? { iterationOffsetPerGroup: iterationOffset } : {}),
    ...(stopBeforeTarget ? { stopBeforeTarget } : {}),
    ...(seedReport ? { seedReport } : {}),
    allowCompatibleSeed: args.includes('--allow-compatible-seed'),
    ...(startFromTarget ? { startFromTarget } : {}),
  })
  await mkdir(dirname(output), { recursive: true, mode: 0o750 })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  console.log(`Exploration: ${output}`)
  console.log(`Status: ${report.status}; Locators: ${report.locatorResolutions.length}; Tables: ${report.tableResolutions.length}; Unresolved: ${report.unresolvedTargetIds.length + report.unresolvedTableIds.length}`)
  if (report.status !== 'passed') process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(`Workflow exploration failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
