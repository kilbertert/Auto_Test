#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { TestSuiteIR } from '../core/types.js'
import {
  LocatorValidationInputError,
  validateLocators,
} from '../validation/locator-validator.js'

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function main(): Promise<void> {
  process.umask(0o027)
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('用法: npm run validate:locators -- --ir <suite.ir.json> [--case id1,id2] [--replays 2] [--headed] [--output report.json]')
    return
  }
  const inputPath = valueAfter(args, '--ir')
  if (!inputPath) throw new Error('必须提供 --ir')
  const suite = JSON.parse(await readFile(resolve(inputPath), 'utf8')) as TestSuiteIR
  const replays = Number.parseInt(valueAfter(args, '--replays') ?? '2', 10)
  const caseIds = valueAfter(args, '--case')?.split(',').map((value) => value.trim()).filter(Boolean)
  const report = await validateLocators(suite, {
    ...(caseIds?.length ? { caseIds } : {}),
    replays,
    headless: !args.includes('--headed'),
    allowWrite: args.includes('--allow-write'),
    allowDestructive: args.includes('--allow-destructive'),
  })
  const output = resolve(valueAfter(args, '--output') ?? `artifacts/validation/${suite.suiteId}.locator-report.json`)
  await mkdir(dirname(output), { recursive: true, mode: 0o750 })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  console.log(`Locator report: ${output}`)
  console.log(`Passed: ${report.summary.passed}, Failed: ${report.summary.failed}, Blocked: ${report.summary.blocked}, Checks: ${report.summary.locatorChecks}`)
  if (report.summary.failed > 0 || report.summary.blocked > 0) process.exitCode = 1
}

void main().catch((error: unknown) => {
  if (error instanceof LocatorValidationInputError) {
    for (const item of error.diagnostics) console.error(`[${item.severity}] ${item.code}${item.caseId ? ` (${item.caseId})` : ''}: ${item.message}`)
  } else {
    console.error(`定位器验证失败: ${error instanceof Error ? error.message : String(error)}`)
  }
  process.exitCode = 1
})
