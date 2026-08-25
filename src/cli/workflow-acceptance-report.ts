#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { redactReportValue } from '../workflow/report-redact.js'
import { buildWorkflowAcceptanceReport, renderWorkflowAcceptanceHtml } from '../workflow/acceptance-report.js'
import type { WorkflowAcceptanceEvidence, WorkflowAcceptanceReport, WorkflowIntakeManifest } from '../workflow/types.js'

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function main(): Promise<void> {
  process.umask(0o027)
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('用法: npm run report:workflow -- --intake <workflow.json> --evidence <evidence.json> [--output-json report.json] [--output-html report.html]')
    return
  }
  const intakePath = valueAfter(args, '--intake')
  const evidencePath = valueAfter(args, '--evidence')
  if (!intakePath || !evidencePath) throw new Error('必须提供 --intake 和 --evidence')
  const workflow = JSON.parse(await readFile(resolve(intakePath), 'utf8')) as WorkflowIntakeManifest
  const evidence = JSON.parse(await readFile(resolve(evidencePath), 'utf8')) as WorkflowAcceptanceEvidence
  const report = redactReportValue<WorkflowAcceptanceReport>(buildWorkflowAcceptanceReport(workflow, evidence))
  const outputJson = resolve(valueAfter(args, '--output-json') ?? `artifacts/acceptance/${workflow.workflowId}.acceptance.json`)
  const outputHtml = resolve(valueAfter(args, '--output-html') ?? `artifacts/acceptance/${workflow.workflowId}.acceptance.html`)
  await mkdir(dirname(outputJson), { recursive: true, mode: 0o750 })
  await mkdir(dirname(outputHtml), { recursive: true, mode: 0o750 })
  await writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  await writeFile(outputHtml, renderWorkflowAcceptanceHtml(report), { encoding: 'utf8', mode: 0o640 })
  console.log(`JSON report: ${outputJson}`)
  console.log(`HTML report: ${outputHtml}`)
  console.log(`Business canary: ${evidence.businessCanaryStatus}; Product gate: ${evidence.productAcceptanceStatus}`)
}

void main().catch((error: unknown) => {
  console.error(`工作流验收报告生成失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
