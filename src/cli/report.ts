#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { CompiledSourceMap } from '../compiler/playwright.js'
import type { TestSuiteIR } from '../core/types.js'
import { redactSensitiveContent } from '../input/text.js'
import type { BoundedRepairReport, FailureClassificationReport } from '../repair/types.js'
import { buildIntegratedRunReport } from '../report/build.js'
import { renderIntegratedRunReportHtml } from '../report/html.js'
import { parsePlaywrightJsonReport } from '../report/playwright-json.js'
import type { IntegratedRunReport } from '../report/types.js'
import type { LocatorValidationReport } from '../validation/locator-validator.js'

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function optionalJson<T>(path: string | undefined): Promise<T | undefined> {
  return path ? JSON.parse(await readFile(resolve(path), 'utf8')) as T : undefined
}

function redactString(value: string): string {
  let redacted = value
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('AUTO_TEST_SECRET_') && value) redacted = redacted.replaceAll(value, '[REDACTED]')
  }
  return redactSensitiveContent(redacted)
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]))
  }
  return value
}

function redactKnownSecrets(report: IntegratedRunReport): IntegratedRunReport {
  return redactValue(report) as IntegratedRunReport
}

async function main(): Promise<void> {
  process.umask(0o027)
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('用法: npm run report -- --ir <suite.ir.json> --source-map <spec.map.json> [--playwright-report results.json] [--validation report.json] [--classification report.json] [--repair report.json] [--output-json report.json] [--output-html report.html]')
    return
  }
  const irPath = valueAfter(args, '--ir')
  const sourceMapPath = valueAfter(args, '--source-map')
  if (!irPath || !sourceMapPath) throw new Error('必须提供 --ir 和 --source-map')
  const suite = JSON.parse(await readFile(resolve(irPath), 'utf8')) as TestSuiteIR
  const sourceMap = JSON.parse(await readFile(resolve(sourceMapPath), 'utf8')) as CompiledSourceMap
  const compiledSource = await readFile(resolve(sourceMap.generatedFile), 'utf8')
  const compiledHash = createHash('sha256').update(compiledSource).digest('hex')
  if (compiledHash !== sourceMap.generatedSha256) throw new Error('生成代码 hash 与 source map 不一致')

  const rawPlaywright = await optionalJson<unknown>(valueAfter(args, '--playwright-report'))
  const validation = await optionalJson<LocatorValidationReport>(valueAfter(args, '--validation'))
  const classification = await optionalJson<FailureClassificationReport>(valueAfter(args, '--classification'))
  const repair = await optionalJson<BoundedRepairReport>(valueAfter(args, '--repair'))
  const executions = rawPlaywright
    ? parsePlaywrightJsonReport(rawPlaywright, suite.cases.map((testCase) => testCase.id))
    : undefined
  const report = redactKnownSecrets(buildIntegratedRunReport({
    suite,
    sourceMap,
    ...(executions ? { executions } : {}),
    ...(validation ? { validation } : {}),
    ...(classification ? { classification } : {}),
    ...(repair ? { repair } : {}),
  }))
  const outputJson = resolve(valueAfter(args, '--output-json') ?? `artifacts/report/${suite.suiteId}.run-report.json`)
  const outputHtml = resolve(valueAfter(args, '--output-html') ?? `artifacts/report/${suite.suiteId}.run-report.html`)
  await mkdir(dirname(outputJson), { recursive: true, mode: 0o750 })
  await mkdir(dirname(outputHtml), { recursive: true, mode: 0o750 })
  await writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  await writeFile(outputHtml, renderIntegratedRunReportHtml(report), { encoding: 'utf8', mode: 0o640 })
  console.log(`JSON report: ${outputJson}`)
  console.log(`HTML report: ${outputHtml}`)
  console.log(`Passed: ${report.summary.passed}, Failed: ${report.summary.failed}, Repaired: ${report.summary.repaired}`)
}

void main().catch((error: unknown) => {
  console.error(`报告生成失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
