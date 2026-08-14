#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { compileMcpReplay, readJsonLines } from '../compiler/mcp-replay.js'

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} must have a value`)
  return value
}

async function main(): Promise<void> {
  process.umask(0o027)
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('Usage: npm run compile:replay -- --events <codex-agent.events.jsonl> --result <codex-agent.result.json> [--output <replay.spec.ts>]')
    return
  }
  const eventsPath = valueAfter(args, '--events')
  const resultPath = valueAfter(args, '--result')
  if (!eventsPath || !resultPath) throw new Error('--events and --result are required')
  const result = JSON.parse(await readFile(resolve(resultPath), 'utf8')) as { cases?: Array<{ caseId?: unknown; outcome?: unknown }> }
  const passed = new Set((result.cases ?? []).flatMap((item) => item.outcome === 'passed' && typeof item.caseId === 'string' ? [item.caseId] : []))
  if (passed.size === 0) throw new Error('Result contains no passed cases')
  const compiled = compileMcpReplay(await readJsonLines(resolve(eventsPath)), passed)
  for (const item of compiled.diagnostics) console.error(`[${item.severity}] ${item.code}${item.caseId ? ` (${item.caseId})` : ''}: ${item.message}`)
  if (!compiled.source) throw new Error('Replay compilation failed')
  const output = resolve(valueAfter(args, '--output') ?? 'artifacts/compiled/mcp-replay.spec.ts')
  const configOutput = output.endsWith('.spec.ts') ? output.replace(/\.spec\.ts$/, '.config.ts') : `${output}.config.ts`
  await mkdir(dirname(output), { recursive: true, mode: 0o750 })
  await writeFile(output, compiled.source, { encoding: 'utf8', mode: 0o640 })
  await writeFile(configOutput, `import { defineConfig } from '@playwright/test'\n\nexport default defineConfig({ testDir: '.', testMatch: ${JSON.stringify(basename(output))}, workers: 1, use: { browserName: 'chromium' } })\n`, { encoding: 'utf8', mode: 0o640 })
  if (process.platform !== 'win32') await chmod(output, 0o640)
  if (process.platform !== 'win32') await chmod(configOutput, 0o640)
  console.log(`Compiled ${compiled.caseIds.length} passed case(s): ${output}`)
  console.log(`Run: playwright test --config ${configOutput}`)
}

void main().catch((error: unknown) => {
  console.error(`Compilation failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
