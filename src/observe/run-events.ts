import { watch, type FSWatcher } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { ServerResponse } from 'node:http'
import { redactAgentArtifactValue } from '../agent/redact.js'

const SNAPSHOT_EVENT_LINES = 50
const HEARTBEAT_MS = 15_000

export interface RunEventLine {
  at?: string
  event?: string
  type?: string
  [key: string]: unknown
}

export interface SseStreamHandle {
  close: () => void
}

function sendEvent(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\n`)
  response.write(`data: ${JSON.stringify(data)}\n\n`)
}

/**
 * Serve one run's live stream: a full snapshot on connect, then incremental
 * state and event-line pushes as the run's files change, with a heartbeat.
 * Everything pushed is read from the run's already-redacted observation
 * artifacts; this module never writes and never reads `.agent-private`.
 */
export function serveRunEventStream(
  response: ServerResponse,
  runDirectory: string,
): SseStreamHandle {
  const statePath = resolve(runDirectory, 'codex-agent.state.json')
  const eventsPath = resolve(runDirectory, 'codex-agent.events.jsonl')
  let eventsByteOffset = 0
  const watchers: FSWatcher[] = []
  const timers: NodeJS.Timeout[] = []
  let closed = false

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })

  const readState = async (): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(statePath, 'utf8')) as unknown
    } catch {
      return undefined
    }
  }

  const readEventLines = async (fromByte: number): Promise<{ lines: RunEventLine[]; nextByte: number }> => {
    try {
      const stats = await stat(eventsPath)
      if (stats.size < fromByte) return { lines: [], nextByte: stats.size } // truncated/rotated: resync
      const text = await readFile(eventsPath, 'utf8')
      const chunk = text.slice(fromByte)
      const lines: RunEventLine[] = []
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue
        try {
          lines.push(JSON.parse(line) as RunEventLine)
        } catch {
          // partial tail line: wait for the rest on the next change
        }
      }
      return { lines, nextByte: text.length }
    } catch {
      return { lines: [], nextByte: fromByte }
    }
  }

  const pushState = async (): Promise<void> => {
    if (closed) return
    // Defense in depth: the runner redacts before writing, and the
    // observation plane redacts again on the way out so a redaction gap
    // upstream can never leak through the stream.
    sendEvent(response, 'state', redactAgentArtifactValue(await readState(), []))
  }

  const pushNewEvents = async (): Promise<void> => {
    if (closed) return
    const { lines, nextByte } = await readEventLines(eventsByteOffset)
    eventsByteOffset = nextByte
    if (lines.length > 0) sendEvent(response, 'events', { lines: redactAgentArtifactValue(lines, []) as RunEventLine[] })
  }

  const pushSnapshot = async (): Promise<void> => {
    await pushState()
    const { lines } = await readEventLines(0)
    const snapshotLines = lines.slice(-SNAPSHOT_EVENT_LINES)
    const { nextByte } = await readEventLines(0)
    eventsByteOffset = nextByte
    if (snapshotLines.length > 0) sendEvent(response, 'events', { lines: redactAgentArtifactValue(snapshotLines, []) as RunEventLine[] })
  }

  const onChange = (kind: 'state' | 'events'): void => {
    if (closed) return
    const timer = setTimeout(() => {
      void (kind === 'state' ? pushState() : pushNewEvents())
    }, 150)
    timers.push(timer)
  }

  try {
    watchers.push(watch(dirname(statePath), (_eventType, filename) => {
      if (filename === 'codex-agent.state.json') onChange('state')
      if (filename === 'codex-agent.events.jsonl') onChange('events')
    }))
  } catch {
    // Directory vanished (run deleted): the heartbeat keeps the connection
    // honest and the client sees no further updates.
  }

  timers.push(setInterval(() => {
    if (!closed) response.write(`: keep-alive\n\n`)
  }, HEARTBEAT_MS))

  response.on('close', () => {
    close()
  })

  void pushSnapshot()

  function close(): void {
    if (closed) return
    closed = true
    for (const watcher of watchers) watcher.close()
    for (const timer of timers) clearTimeout(timer)
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
  }

  return { close }
}
