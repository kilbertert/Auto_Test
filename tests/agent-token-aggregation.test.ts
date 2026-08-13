import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { readAggregateTokenUsage } from '../src/agent/competition.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function makeEventsDirectory(lines: string[]): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-token-'))
  directories.push(directory)
  await writeFile(resolve(directory, 'codex-agent.events.jsonl'), lines.map((line) => `${line}\n`).join(''))
  return directory
}

describe('readAggregateTokenUsage', () => {
  it('sums raw Codex turn.completed events with snake_case usage fields', async () => {
    const directory = await makeEventsDirectory([
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 5 } }),
    ])
    await expect(readAggregateTokenUsage(directory)).resolves.toEqual({ inputTokens: 150, cachedInputTokens: 60, outputTokens: 15 })
  })

  it('accepts the normalized turn_completed spelling with camelCase usage fields', async () => {
    const directory = await makeEventsDirectory([
      JSON.stringify({ type: 'turn_completed', usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 } }),
    ])
    await expect(readAggregateTokenUsage(directory)).resolves.toEqual({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 })
  })

  it('sums OMP turn_end frames with nested message.usage', async () => {
    const directory = await makeEventsDirectory([
      JSON.stringify({ type: 'turn_end', message: { usage: { input: 100, output: 20, cacheRead: 40 } } }),
      JSON.stringify({ type: 'turn_end', message: { usage: { input: 50, output: 5, cacheRead: 10 } } }),
    ])
    await expect(readAggregateTokenUsage(directory)).resolves.toEqual({ inputTokens: 150, cachedInputTokens: 50, outputTokens: 25 })
  })

  it('returns undefined when the log is missing or has no completed turn with usage', async () => {
    await expect(readAggregateTokenUsage('/definitely/missing')).resolves.toBeUndefined()
    const empty = await makeEventsDirectory([JSON.stringify({ type: 'agent_message', text: 'no usage here' })])
    await expect(readAggregateTokenUsage(empty)).resolves.toBeUndefined()
  })
})
