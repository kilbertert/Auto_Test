#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { CodexCliWorkflowPlanner } from '../workflow/planner-provider.js'
import { planWorkflow } from '../workflow/planner.js'
import type { WorkflowIntakeManifest } from '../workflow/types.js'

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
    console.log('用法: npm run plan:workflow -- --intake <workflow.json> --media-dir <dir> [--brief <file>] [--model <id>] [--output <draft.json>]')
    return
  }
  const intakePath = resolve(requireValue(args, '--intake'))
  const mediaDirectory = resolve(requireValue(args, '--media-dir'))
  const output = resolve(valueAfter(args, '--output') ?? 'artifacts/planning/workflow.plan-draft.json')
  const workspaceDirectory = resolve(valueAfter(args, '--workspace') ?? dirname(output), 'model-workspace')
  const manifest = JSON.parse(await readFile(intakePath, 'utf8')) as WorkflowIntakeManifest
  const briefPath = valueAfter(args, '--brief')
  const brief = briefPath ? await readFile(resolve(briefPath), 'utf8') : ''
  const resumeResponsePath = valueAfter(args, '--resume-response')
  const initialResponse = resumeResponsePath
    ? JSON.parse(await readFile(resolve(resumeResponsePath), 'utf8')) as { planJson: string; summary: string[] }
    : undefined
  const draft = await planWorkflow({
    manifest,
    mediaDirectory,
    brief,
    provider: new CodexCliWorkflowPlanner({ ...(valueAfter(args, '--model') ? { model: valueAfter(args, '--model')! } : {}) }),
    workspaceDirectory,
    ...(initialResponse ? { initialResponse } : {}),
  })
  await mkdir(dirname(output), { recursive: true, mode: 0o750 })
  await writeFile(output, `${JSON.stringify(draft, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  console.log(`Workflow draft: ${output}`)
  console.log(`Groups: ${draft.groups.length}; Phases: ${draft.groups.flatMap((group) => group.phases).length}`)
  console.log(`Unresolved ambiguities: ${draft.review.unresolvedAmbiguities.length}`)
}

void main().catch((error: unknown) => {
  console.error(`Workflow planning failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
