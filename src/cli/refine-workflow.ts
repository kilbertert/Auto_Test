#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { CodexCliWorkflowPlanner } from '../workflow/planner-provider.js'
import { readSanitizedPageEvidence, refineWorkflowDraftFromExploration } from '../workflow/plan-refinement.js'
import type { WorkflowPlanExplorationReport } from '../workflow/plan-exploration.js'
import type { WorkflowPlanDraft } from '../workflow/planner-types.js'

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function requireValue(args: string[], name: string): string {
  const value = valueAfter(args, name)
  if (!value) throw new Error(`必须提供 ${name}`)
  return value
}

async function jsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort()
}

async function main(): Promise<void> {
  process.umask(0o027)
  const args = process.argv.slice(2)
  const draft = JSON.parse(await readFile(resolve(requireValue(args, '--draft')), 'utf8')) as WorkflowPlanDraft
  const exploration = JSON.parse(await readFile(resolve(requireValue(args, '--exploration')), 'utf8')) as WorkflowPlanExplorationReport
  const evidenceDirectory = resolve(requireValue(args, '--evidence-dir'))
  const output = resolve(requireValue(args, '--output'))
  const workspaceDirectory = resolve(valueAfter(args, '--workspace') ?? dirname(output), 'refinement-workspace')
  await mkdir(workspaceDirectory, { recursive: true, mode: 0o750 })
  const refined = await refineWorkflowDraftFromExploration({
    draft,
    exploration,
    pageEvidence: await readSanitizedPageEvidence(await jsonFiles(evidenceDirectory)),
    provider: new CodexCliWorkflowPlanner({ ...(valueAfter(args, '--model') ? { model: valueAfter(args, '--model')! } : {}) }),
    workspaceDirectory,
  })
  await mkdir(dirname(output), { recursive: true, mode: 0o750 })
  await writeFile(output, `${JSON.stringify(refined, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  console.log(`Refined workflow draft: ${output}`)
}

void main().catch((error: unknown) => {
  console.error(`Workflow refinement failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
