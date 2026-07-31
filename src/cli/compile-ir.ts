#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { compilePlaywrightSuite } from '../compiler/playwright.js'
import type { TestSuiteIR } from '../core/types.js'

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  return args[index + 1]
}

async function main(): Promise<void> {
  process.umask(0o027)
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('用法: npm run compile -- --ir <suite.ir.json> [--output <suite.spec.ts>] [--map <suite.spec.map.json>]')
    return
  }
  const input = valueAfter(args, '--ir')
  if (!input) throw new Error('必须提供 --ir')
  const suite = JSON.parse(await readFile(resolve(input), 'utf8')) as TestSuiteIR
  const compiled = compilePlaywrightSuite(suite)
  if (compiled.diagnostics.hasErrors) {
    for (const item of compiled.diagnostics.items) {
      console.error(`[${item.severity}] ${item.code}${item.caseId ? ` (${item.caseId})` : ''}: ${item.message}`)
    }
    process.exitCode = 1
    return
  }
  const output = resolve(valueAfter(args, '--output') ?? `artifacts/compiled/${compiled.fileName}`)
  const mapOutput = resolve(valueAfter(args, '--map') ?? output.replace(/\.ts$/, '.map.json'))
  await mkdir(dirname(output), { recursive: true, mode: 0o750 })
  await writeFile(output, compiled.source, { encoding: 'utf8', mode: 0o640 })
  if (!compiled.sourceMap) throw new Error('编译成功但缺少 source map')
  await mkdir(dirname(mapOutput), { recursive: true, mode: 0o750 })
  await writeFile(mapOutput, `${JSON.stringify({ ...compiled.sourceMap, generatedFile: output }, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  console.log(`Compiled: ${output}`)
  console.log(`Source map: ${mapOutput}`)
}

void main().catch((error: unknown) => {
  console.error(`编译失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
