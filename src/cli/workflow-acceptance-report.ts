#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalResultProblems } from '../agent/runner.js'
import type { CodexTestAgentResult, CodexTestEnvironmentRequirement, CodexTestExecutionReceipt } from '../agent/types.js'
import { redactReportValue } from '../workflow/report-redact.js'
import { buildWorkflowAcceptanceReport, renderWorkflowAcceptanceHtml } from '../workflow/acceptance-report.js'
import type { WorkflowAcceptanceEvidence, WorkflowAcceptanceReport, WorkflowIntakeManifest } from '../workflow/types.js'

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function readRunJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as T
  } catch (error) {
    throw new Error(`验收运行产物无法读取或解析 ${path}：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** A row the run records only when it has content; absent means none were recorded. */
async function readRunJsonIfPresent<T>(path: string): Promise<T | undefined> {
  if (!await access(path).then(() => true, () => false)) return undefined
  return readRunJson<T>(path)
}

/**
 * The Adapter half of acceptance reporting.
 *
 * `src/workflow` must not depend on `src/agent` (architecture.yml), so the
 * acceptance report stays a pure consumer: this CLI reads the run the
 * acceptance names — its immutable Manifest, its settled Result, and the
 * authority rows the Runner's own settlement reconciles claims against — and
 * asks the Runner's settlement entry point for the verdict. The report then
 * quotes that problem list instead of adjudicating contract problems itself, so
 * a report and the Runner's diagnostics can never disagree about a Case claim.
 *
 * Reading these artifacts fails closed: a run the acceptance names but cannot
 * read is a broken input, not a run with no contract problems.
 */
export async function acceptanceRunContractProblems(runDirectory: string): Promise<string[]> {
  const manifest = await readRunJson<WorkflowIntakeManifest>(resolve(runDirectory, 'agent-workspace', 'test-manifest.json'))
  const result = await readRunJson<CodexTestAgentResult>(resolve(runDirectory, 'codex-agent.result.json'))
  const environmentRequirements = await readRunJsonIfPresent<CodexTestEnvironmentRequirement[]>(
    resolve(runDirectory, '.agent-private', 'environment-requirements.json'),
  )
  const executionReceipts = await readRunJsonIfPresent<CodexTestExecutionReceipt[]>(
    resolve(runDirectory, 'agent-workspace', 'execution-receipts.json'),
  )
  return finalResultProblems(result, manifest, environmentRequirements ?? [], executionReceipts ?? [])
}

async function main(): Promise<void> {
  process.umask(0o027)
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('用法: npm run report:workflow -- --intake <workflow.json> --evidence <evidence.json> [--output-json report.json] [--output-html report.html]')
    console.log('验收证据可用 runDirectory 指明本次验收覆盖的 AgentHost Run；报告会引用该 Run 的结果合同问题列表。')
    return
  }
  const intakePath = valueAfter(args, '--intake')
  const evidencePath = valueAfter(args, '--evidence')
  if (!intakePath || !evidencePath) throw new Error('必须提供 --intake 和 --evidence')
  const workflow = JSON.parse(await readFile(resolve(intakePath), 'utf8')) as WorkflowIntakeManifest
  const evidence = JSON.parse(await readFile(resolve(evidencePath), 'utf8')) as WorkflowAcceptanceEvidence
  const contractProblems = evidence.runDirectory
    ? await acceptanceRunContractProblems(resolve(evidence.runDirectory))
    : []
  const report = redactReportValue<WorkflowAcceptanceReport>(buildWorkflowAcceptanceReport(workflow, evidence, contractProblems))
  const outputJson = resolve(valueAfter(args, '--output-json') ?? `artifacts/acceptance/${workflow.workflowId}.acceptance.json`)
  const outputHtml = resolve(valueAfter(args, '--output-html') ?? `artifacts/acceptance/${workflow.workflowId}.acceptance.html`)
  await mkdir(dirname(outputJson), { recursive: true, mode: 0o750 })
  await mkdir(dirname(outputHtml), { recursive: true, mode: 0o750 })
  await writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  await writeFile(outputHtml, renderWorkflowAcceptanceHtml(report), { encoding: 'utf8', mode: 0o640 })
  console.log(`JSON report: ${outputJson}`)
  console.log(`HTML report: ${outputHtml}`)
  console.log(`Business canary: ${evidence.businessCanaryStatus}; Product gate: ${evidence.productAcceptanceStatus}`)
  console.log(`Result contract: ${report.contractProblems.length === 0 ? 'valid' : 'invalid'} (${report.contractProblems.length} problems)`)
  for (const problem of report.contractProblems) console.log(`合同问题：${problem}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(`工作流验收报告生成失败: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
