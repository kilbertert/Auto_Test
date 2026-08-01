#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { TestSuiteIR } from '../core/types.js'
import { classifyFailures } from '../repair/classifier.js'
import type { LocatorValidationReport } from '../validation/locator-validator.js'

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function main(): Promise<void> {
  process.umask(0o027)
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('用法: npm run classify -- --ir <suite.ir.json> --report <locator-report.json> [--output classification.json]')
    return
  }
  const irPath = valueAfter(args, '--ir')
  const reportPath = valueAfter(args, '--report')
  if (!irPath || !reportPath) throw new Error('必须提供 --ir 和 --report')
  const suite = JSON.parse(await readFile(resolve(irPath), 'utf8')) as TestSuiteIR
  const validation = JSON.parse(await readFile(resolve(reportPath), 'utf8')) as LocatorValidationReport
  const classification = classifyFailures(suite, validation)
  const output = resolve(valueAfter(args, '--output') ?? `artifacts/classification/${suite.suiteId}.classification.json`)
  await mkdir(dirname(output), { recursive: true, mode: 0o750 })
  await writeFile(output, `${JSON.stringify(classification, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  console.log(`Classification report: ${output}`)
  console.log(`Total: ${classification.summary.total}, Repair eligible: ${classification.summary.repairEligible}`)
}

void main().catch((error: unknown) => {
  console.error(`失败分类错误: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
