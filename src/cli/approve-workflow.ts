#!/usr/bin/env node
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { approveExploredWorkflowPlan, type WorkflowPlanExplorationReport } from '../workflow/plan-exploration.js'

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function requireValue(args: string[], name: string): string {
  const value = valueAfter(args, name)
  if (!value || value.startsWith('--')) throw new Error(`必须提供 ${name}`)
  return value
}

async function canonicalOutputPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return resolve(await realpath(dirname(path)), basename(path))
  }
}

async function main(): Promise<void> {
  process.umask(0o027)
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('用法: npm run approve:workflow -- --draft <draft.json> --exploration <report.json> --reviewer <name> --approve --output <execution-plan.json>')
    return
  }
  if (!args.includes('--approve')) throw new Error('必须显式提供 --approve')
  const draftPath = resolve(requireValue(args, '--draft'))
  const explorationPath = resolve(requireValue(args, '--exploration'))
  const output = resolve(requireValue(args, '--output'))
  await mkdir(dirname(output), { recursive: true, mode: 0o750 })
  const [draftIdentity, explorationIdentity, outputIdentity] = await Promise.all([
    realpath(draftPath),
    realpath(explorationPath),
    canonicalOutputPath(output),
  ])
  if (outputIdentity === draftIdentity || outputIdentity === explorationIdentity) {
    throw new Error('--output 不能覆盖 --draft 或 --exploration 审批证据')
  }
  const draft = JSON.parse(await readFile(draftPath, 'utf8')) as unknown
  const report = JSON.parse(await readFile(explorationPath, 'utf8')) as WorkflowPlanExplorationReport
  const plan = approveExploredWorkflowPlan(draft, report, requireValue(args, '--reviewer'))
  await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  await chmod(output, 0o640)
  console.log(`Approved workflow execution plan: ${output}`)
}

void main().catch((error: unknown) => {
  console.error(`Workflow approval failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
