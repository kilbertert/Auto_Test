#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { approveExploredWorkflowPlan, type WorkflowPlanExplorationReport } from '../workflow/plan-exploration.js'

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function requireValue(args: string[], name: string): string {
  const value = valueAfter(args, name)
  if (!value) throw new Error(`必须提供 ${name}`)
  return value
}

async function main(): Promise<void> {
  process.umask(0o027)
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('用法: npm run approve:workflow -- --draft <draft.json> --exploration <report.json> --reviewer <name> --approve --output <execution-plan.json>')
    return
  }
  if (!args.includes('--approve')) throw new Error('必须显式提供 --approve')
  const draft = JSON.parse(await readFile(resolve(requireValue(args, '--draft')), 'utf8')) as unknown
  const report = JSON.parse(await readFile(resolve(requireValue(args, '--exploration')), 'utf8')) as WorkflowPlanExplorationReport
  const output = resolve(requireValue(args, '--output'))
  const plan = approveExploredWorkflowPlan(draft, report, requireValue(args, '--reviewer'))
  await mkdir(dirname(output), { recursive: true, mode: 0o750 })
  await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  console.log(`Approved workflow execution plan: ${output}`)
}

void main().catch((error: unknown) => {
  console.error(`Workflow approval failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
