#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { CodexCliWorkflowPlanner } from '../workflow/planner-provider.js'
import type { WorkflowPlanDraft } from '../workflow/planner-types.js'
import { planWorkflowRecoveryContracts } from '../workflow/recovery-planner.js'

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
  const draftPath = resolve(requireValue(args, '--draft'))
  const output = resolve(requireValue(args, '--output'))
  const workspaceDirectory = resolve(valueAfter(args, '--workspace') ?? dirname(output), 'recovery-planner-workspace')
  const draft = JSON.parse(await readFile(draftPath, 'utf8')) as WorkflowPlanDraft
  const result = await planWorkflowRecoveryContracts({
    draft,
    provider: new CodexCliWorkflowPlanner({ ...(valueAfter(args, '--model') ? { model: valueAfter(args, '--model')! } : {}) }),
    workspaceDirectory,
  })
  await mkdir(dirname(output), { recursive: true, mode: 0o750 })
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  console.log(`Recovery-planned workflow draft: ${output}`)
}

void main().catch((error: unknown) => {
  console.error(`Workflow recovery planning failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
