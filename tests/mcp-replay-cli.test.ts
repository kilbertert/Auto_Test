import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
const script = resolve('src', 'cli', 'compile-mcp-replay.ts')

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function runReplayCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8' })
}

function event(id: string, server: string, tool: string, args: object, text = ''): object {
  return {
    type: 'item.completed',
    item: {
      id,
      type: 'mcp_tool_call',
      server,
      tool,
      arguments: args,
      result: { content: [{ type: 'text', text }] },
      status: 'completed',
    },
  }
}

describe('MCP replay CLI smoke', () => {
  it('prints read-only help without requiring events or result inputs', () => {
    const result = runReplayCli(['--help'])
    const stdout = result.stdout.toString()

    expect(result.status, result.stderr.toString()).toBe(0)
    expect(stdout).toContain('Usage: npm run compile:replay')
    expect(stdout).toContain('--events')
    expect(stdout).toContain('--result')
  })

  it('compiles synthetic events and result inputs into a spec and config', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-replay-cli-'))
    directories.push(directory)
    const eventsPath = resolve(directory, 'codex-agent.events.jsonl')
    const resultPath = resolve(directory, 'codex-agent.result.json')
    const outputPath = resolve(directory, 'replay.spec.ts')
    const configPath = resolve(directory, 'replay.config.ts')

    const events = [
      event('1', 'auto-test-control', 'case_execution_begin', { caseId: 'case-1' }),
      event('2', 'playwright', 'browser_navigate', {}, "### Ran Playwright code\n```js\nawait page.goto('https://example.test');\n```"),
      event('3', 'playwright', 'browser_verify_text_visible', {}, "### Ran Playwright code\n```js\nawait expect(page.getByText('Ready')).toBeVisible();\n```"),
      event('4', 'auto-test-control', 'case_execution_end', { caseId: 'case-1' }),
    ]
    await Promise.all([
      writeFile(eventsPath, `${events.map((item) => JSON.stringify(item)).join('\n')}\n`),
      writeFile(resultPath, JSON.stringify({ cases: [{ caseId: 'case-1', outcome: 'passed' }] })),
    ])

    const result = runReplayCli(['--events', eventsPath, '--result', resultPath, '--output', outputPath])

    expect(result.status, result.stderr.toString()).toBe(0)
    const stdout = result.stdout.toString()
    const spec = await readFile(outputPath, 'utf8')
    const config = await readFile(configPath, 'utf8')
    expect(spec).toContain("import { test, expect } from '@playwright/test'")
    expect(spec).toContain('case-1')
    expect(spec).toContain("page.goto('https://example.test')")
    expect(config).toContain("import { defineConfig } from '@playwright/test'")
    expect(config).toContain('replay.spec.ts')
    expect(config).toContain("workers: 1")
    expect(stdout).toContain('Compiled 1 passed case(s)')
  })
})
