import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isExternalModelServiceError,
  isModelCapacityError,
  parseClaudeStructuredOutput,
  runStructuredModelWithFallback,
} from '../src/workflow/structured-model-cli.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function executable(directory: string, name: string, body: string): Promise<string> {
  const path = resolve(directory, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
  await chmod(path, 0o700)
  return path
}

describe('structured model CLI failover', () => {
  it('recognizes capacity and external service failures and parses Claude envelopes', () => {
    expect(isModelCapacityError(new Error('rate limit: 429'))).toBe(true)
    expect(isModelCapacityError(new Error('schema validation failed'))).toBe(false)
    expect(isExternalModelServiceError(new Error('Claude fallback command exited with 1: API Error: Content block is not a thinking block'))).toBe(true)
    expect(parseClaudeStructuredOutput(JSON.stringify({ structured_output: { ok: true } }))).toBe('{"ok":true}')
  })

  it('falls back after a capacity error and removes the unsupported schema dialect marker', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-model-fallback-'))
    temporaryDirectories.push(directory)
    const codex = await executable(directory, 'codex-fake', "echo 'usage limit reached' >&2; exit 1")
    const claude = await executable(directory, 'claude-fake', [
      'for arg in "$@"; do',
      '  case "$arg" in *json-schema.org*) echo "unsupported schema marker" >&2; exit 2;; esac',
      'done',
      'cat >/dev/null',
      'echo \'{"structured_output":{"ok":true}}\'',
    ].join('\n'))
    const schemaPath = resolve(directory, 'schema.json')
    await writeFile(schemaPath, JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    }))

    const result = await runStructuredModelWithFallback({
      codexExecutable: codex,
      codexArgs: [],
      claudeExecutable: claude,
      prompt: 'fixture',
      cwd: directory,
      timeoutMs: 5_000,
      outputSchemaPath: schemaPath,
      allowClaudeFallback: true,
    })

    expect(result).toEqual({ output: '{"ok":true}', provider: 'claude-cli' })
  })
})
