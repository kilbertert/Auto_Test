import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CodexTestAgentState } from '../src/agent/types.js'
import { startObservationServer, type ObservationServer } from '../src/observe/server.js'

const servers: ObservationServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()))
})

function stateFixture(overrides: Partial<CodexTestAgentState> = {}): CodexTestAgentState {
  return {
    version: '2.0', status: 'running', stage: 'executing',
    workflowId: 'workflow', sourceSha256: 'a'.repeat(64),
    startedAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:10:00.000Z',
    threadGeneration: 0, completedCaseIds: [],
    ...overrides,
  }
}

/** Collect SSE frames from one connection until the stop condition or timeout. */
async function collectSse(
  url: string,
  until: (frames: string[]) => boolean,
  timeoutMs = 4_000,
): Promise<string[]> {
  const frames: string[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (!until(frames)) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        frames.push(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
      }
      if (until(frames)) { controller.abort(); break }
    }
  } catch {
    // abort surfaces here; frames collected so far are the result
  } finally {
    clearTimeout(timer)
  }
  return frames
}

function frameEvent(frame: string): string | undefined {
  const match = /^event: (.+)$/.exec(frame.split('\n')[0] ?? '')
  return match?.[1]
}

function frameData(frame: string): unknown {
  const line = frame.split('\n').find(item => item.startsWith('data: '))
  return line ? JSON.parse(line.slice('data: '.length)) as unknown : undefined
}

describe('observation run event stream (SSE)', () => {
  it('pushes a state snapshot and recent event lines on connect', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-sse-'))
    try {
      const runId = '20260901-080000-live-ss01'
      const runDir = resolve(directory, runId)
      await mkdir(runDir, { recursive: true })
      await writeFile(resolve(runDir, 'codex-agent.state.json'), JSON.stringify(stateFixture()))
      await writeFile(resolve(runDir, 'codex-agent.events.jsonl'), JSON.stringify({ at: '2026-09-01T08:00:01.000Z', event: 'thread_started' }) + '\n' + JSON.stringify({ at: '2026-09-01T08:00:02.000Z', event: 'turn_started' }) + '\n')
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const frames = await collectSse(`${server.baseUrl}/api/runs/${runId}/events`, collected =>
        collected.some(frame => frameEvent(frame) === 'state') && collected.some(frame => frameEvent(frame) === 'events'))
      const stateFrame = frames.find(frame => frameEvent(frame) === 'state')
      const eventsFrame = frames.find(frame => frameEvent(frame) === 'events')
      expect((frameData(stateFrame!) as Record<string, unknown>).stage).toBe('executing')
      expect((frameData(eventsFrame!) as { lines: unknown[] }).lines).toHaveLength(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('pushes state and event increments as the run progresses', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-sse-'))
    try {
      const runId = '20260901-083000-live-ss02'
      const runDir = resolve(directory, runId)
      await mkdir(runDir, { recursive: true })
      await writeFile(resolve(runDir, 'codex-agent.state.json'), JSON.stringify(stateFixture()))
      await writeFile(resolve(runDir, 'codex-agent.events.jsonl'), '')
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      // Start collecting in the background, then advance the run mid-stream.
      const collection = collectSse(`${server.baseUrl}/api/runs/${runId}/events`, collected => {
        const sawFinalizing = collected.some(frame => {
          if (frameEvent(frame) !== 'state') return false
          const data = frameData(frame) as Record<string, unknown> | undefined
          return data?.stage === 'finalizing'
        })
        const sawToolStarted = collected.some(frame => {
          if (frameEvent(frame) !== 'events') return false
          const data = frameData(frame) as { lines?: Array<Record<string, unknown>> } | undefined
          return data?.lines?.some(line => line.event === 'tool_started') ?? false
        })
        return sawFinalizing && sawToolStarted
      }, 6_000)
      await new Promise(resolveTimer => setTimeout(resolveTimer, 400))
      await writeFile(resolve(runDir, 'codex-agent.state.json'), JSON.stringify(stateFixture({ stage: 'finalizing', completedCaseIds: ['case-one'] })))
      await new Promise(resolveTimer => setTimeout(resolveTimer, 100))
      await writeFile(resolve(runDir, 'codex-agent.events.jsonl'), JSON.stringify({ at: '2026-09-01T08:30:10.000Z', event: 'tool_started' }) + '\n')
      const frames = await collection
      const stateFrames = frames.filter(frame => frameEvent(frame) === 'state')
      const finalState = stateFrames.map(frame => frameData(frame) as Record<string, unknown>).at(-1)
      expect(finalState?.stage).toBe('finalizing')
      const eventFrames = frames.filter(frame => frameEvent(frame) === 'events').map(frame => frameData(frame) as { lines: Array<Record<string, unknown>> })
      const allLines = eventFrames.flatMap(frame => frame.lines)
      expect(allLines.some(line => line.event === 'tool_started')).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('never leaks a credential-shaped marker that appears in the events file', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-sse-'))
    try {
      const runId = '20260901-084000-live-ss03'
      const runDir = resolve(directory, runId)
      await mkdir(runDir, { recursive: true })
      await writeFile(resolve(runDir, 'codex-agent.state.json'), JSON.stringify(stateFixture()))
      // Worst case: a redaction gap upstream leaves a credential-shaped
      // value in the source file. The observation stream must still strip
      // it on the way out (defense in depth over already-redacted files).
      const secretJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc123def456ghi789'
      await writeFile(resolve(runDir, 'codex-agent.events.jsonl'), JSON.stringify({ at: '2026-09-01T08:40:00.000Z', event: 'tool_started', arguments: secretJwt }) + '\n')
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const frames = await collectSse(`${server.baseUrl}/api/runs/${runId}/events`, collected =>
        collected.some(frame => frameEvent(frame) === 'events'))
      const joined = frames.join('\n')
      expect(joined).not.toContain(secretJwt)
      expect(joined).not.toContain('abc123def456ghi789')
      expect(joined).toContain('<redacted')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('sends heartbeat comments so idle connections stay open', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-sse-'))
    try {
      const runId = '20260901-085000-live-ss04'
      const runDir = resolve(directory, runId)
      await mkdir(runDir, { recursive: true })
      await writeFile(resolve(runDir, 'codex-agent.state.json'), JSON.stringify(stateFixture()))
      await writeFile(resolve(runDir, 'codex-agent.events.jsonl'), '')
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const frames = await collectSse(`${server.baseUrl}/api/runs/${runId}/events`, collected =>
        collected.some(frame => frame.startsWith(': keep-alive')), 20_000)
      expect(frames.some(frame => frame.startsWith(': keep-alive'))).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 25_000)

  it('returns 404 for unknown runs and hostile ids on the stream endpoint', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-sse-'))
    try {
      // A sibling directory with a state file must not be reachable via `..`.
      const sibling = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-sibling-'))
      await writeFile(resolve(sibling, 'codex-agent.state.json'), JSON.stringify(stateFixture()))
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      expect((await fetch(`${server.baseUrl}/api/runs/none-such/events`)).status).toBe(404)
      expect((await fetch(`${server.baseUrl}/api/runs/${encodeURIComponent('..')}/events`)).status).toBe(404)
      expect((await fetch(`${server.baseUrl}/api/runs/../${basename(sibling)}/events`.replace('..', encodeURIComponent('..')))).status).toBe(404)
      expect((await fetch(`${server.baseUrl}/api/runs/a%2Fb/events`)).status).toBe(404)
      await rm(sibling, { recursive: true, force: true })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps a byte-accurate cursor across multibyte event content', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-sse-'))
    try {
      const runId = '20260901-087000-live-ss06'
      const runDir = resolve(directory, runId)
      await mkdir(runDir, { recursive: true })
      await writeFile(resolve(runDir, 'codex-agent.state.json'), JSON.stringify(stateFixture()))
      // Chinese + emoji content: UTF-16 slicing would misalign the cursor here.
      await writeFile(resolve(runDir, 'codex-agent.events.jsonl'), JSON.stringify({ at: '2026-09-01T08:70:00.000Z', event: 'agent_message', text: '登录页面已打开,验证码是1️⃣2️⃣3️⃣' }) + '\n')
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const frames = await collectSse(`${server.baseUrl}/api/runs/${runId}/events`, collected =>
        collected.some(frame => frameEvent(frame) === 'events'))
      const first = frames.find(frame => frameEvent(frame) === 'events')
      expect((frameData(first!) as { lines: Array<Record<string, unknown>> }).lines[0]?.text).toContain('验证码')
      // Append a second event: the cursor must still be byte-aligned.
      const collection = collectSse(`${server.baseUrl}/api/runs/${runId}/events`, collected => {
        const events = collected.filter(frame => frameEvent(frame) === 'events')
        const all = events.flatMap(frame => (frameData(frame) as { lines: Array<Record<string, unknown>> }).lines)
        return all.some(line => line.event === 'tool_completed')
      }, 6_000)
      await new Promise(resolveTimer => setTimeout(resolveTimer, 300))
      await writeFile(resolve(runDir, 'codex-agent.events.jsonl'), JSON.stringify({ at: '2026-09-01T08:70:01.000Z', event: 'agent_message', text: '登录页面已打开,验证码是1️⃣2️⃣3️⃣' }) + '\n' + JSON.stringify({ at: '2026-09-01T08:70:02.000Z', event: 'tool_completed' }) + '\n', { flag: 'a' })
      const frames2 = await collection
      const joined = frames2.join('\n')
      expect(joined).toContain('tool_completed')
      expect(joined).toContain('验证码')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 10_000)

  it('resends the whole file from offset zero after truncation', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-sse-'))
    try {
      const runId = '20260901-088000-live-ss07'
      const runDir = resolve(directory, runId)
      await mkdir(runDir, { recursive: true })
      await writeFile(resolve(runDir, 'codex-agent.state.json'), JSON.stringify(stateFixture()))
      await writeFile(resolve(runDir, 'codex-agent.events.jsonl'), JSON.stringify({ at: 't1', event: 'thread_started' }) + '\n' + JSON.stringify({ at: 't2', event: 'turn_started' }) + '\n')
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      // Consume the snapshot, then rotate the file to shorter content.
      await collectSse(`${server.baseUrl}/api/runs/${runId}/events`, collected =>
        collected.some(frame => frameEvent(frame) === 'events'))
      const collection = collectSse(`${server.baseUrl}/api/runs/${runId}/events`, collected => {
        const events = collected.filter(frame => frameEvent(frame) === 'events')
        const all = events.flatMap(frame => (frameData(frame) as { lines: Array<Record<string, unknown>> }).lines)
        return all.some(line => line.event === 'session_rotated')
      }, 6_000)
      await new Promise(resolveTimer => setTimeout(resolveTimer, 300))
      await writeFile(resolve(runDir, 'codex-agent.events.jsonl'), JSON.stringify({ at: 't3', event: 'session_rotated' }) + '\n')
      const frames = await collection
      const all = frames.filter(frame => frameEvent(frame) === 'events')
        .flatMap(frame => (frameData(frame) as { lines: Array<Record<string, unknown>> }).lines)
      expect(all.some(line => line.event === 'session_rotated')).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 10_000)

  it('stops streaming and releases watchers when the client disconnects', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-sse-'))
    try {
      const runId = '20260901-086000-live-ss05'
      const runDir = resolve(directory, runId)
      await mkdir(runDir, { recursive: true })
      await writeFile(resolve(runDir, 'codex-agent.state.json'), JSON.stringify(stateFixture()))
      await writeFile(resolve(runDir, 'codex-agent.events.jsonl'), '')
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const controller = new AbortController()
      const response = await fetch(`${server.baseUrl}/api/runs/${runId}/events`, { signal: controller.signal })
      const reader = response.body!.getReader()
      await reader.read() // snapshot head arrives; the stream stays open
      controller.abort()
      await new Promise(resolveTimer => setTimeout(resolveTimer, 100))
      // The server must still close cleanly with no lingering stream watchers.
      await server.close()
      const replacement = await startObservationServer({ runRoot: directory, port: Number(new URL(server.baseUrl).port) })
      servers.push(replacement)
      expect((await fetch(`${replacement.baseUrl}/api/runs/${runId}/events`)).status).toBe(200)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
