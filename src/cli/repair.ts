#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { TestSuiteIR } from '../core/types.js'
import type { LocatorCandidateReport } from '../exploration/types.js'
import { runBoundedRepair } from '../repair/orchestrator.js'

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function valuesAfter(args: string[], name: string): string[] {
  return args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]!] : [])
}

async function readCandidates(paths: string[]): Promise<LocatorCandidateReport[]> {
  const reports: LocatorCandidateReport[] = []
  for (const path of paths) reports.push(JSON.parse(await readFile(resolve(path), 'utf8')) as LocatorCandidateReport)
  return reports
}

async function main(): Promise<void> {
  process.umask(0o027)
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('用法: npm run repair -- --ir <suite.ir.json> [--candidate report.json ...] [--max-attempts 2] [--replays 2] [--output report.json] [--output-ir repaired.ir.json]')
    return
  }
  const irPath = valueAfter(args, '--ir')
  if (!irPath) throw new Error('必须提供 --ir')
  const suite = JSON.parse(await readFile(resolve(irPath), 'utf8')) as TestSuiteIR
  const candidates = await readCandidates(valuesAfter(args, '--candidate'))
  const result = await runBoundedRepair(suite, candidates, {
    maxAttempts: Number.parseInt(valueAfter(args, '--max-attempts') ?? String(suite.policy.repair.maxAttempts), 10),
    replays: Number.parseInt(valueAfter(args, '--replays') ?? '2', 10),
    headless: !args.includes('--headed'),
    allowWrite: args.includes('--allow-write'),
    allowDestructive: args.includes('--allow-destructive'),
  })
  const output = resolve(valueAfter(args, '--output') ?? `artifacts/repair/${suite.suiteId}.repair-report.json`)
  await mkdir(dirname(output), { recursive: true, mode: 0o750 })
  await writeFile(output, `${JSON.stringify(result.report, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  console.log(`Repair report: ${output}`)
  console.log(`Status: ${result.report.finalStatus}, Attempts: ${result.report.attempts.length}`)

  if (result.report.finalStatus === 'repaired' && result.finalSuite) {
    const outputIr = resolve(valueAfter(args, '--output-ir') ?? `artifacts/repair/${suite.suiteId}.repaired.ir.json`)
    if (outputIr === resolve(irPath)) throw new Error('修复输出不能覆盖原 IR')
    await mkdir(dirname(outputIr), { recursive: true, mode: 0o750 })
    await writeFile(outputIr, `${JSON.stringify(result.finalSuite, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
    console.log(`Repaired IR: ${outputIr}`)
  }
  if (result.report.finalStatus === 'unrepaired') process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(`受限修复失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
