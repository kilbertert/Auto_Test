import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ServerResponse } from 'node:http'
import { redactAgentArtifactValue } from '../agent/redact.js'

const SNAPSHOT_EVENT_LINES = 50
const HEARTBEAT_MS = 15_000
/**
 * Poll interval for change detection. Deliberately mtime polling rather
 * than fs.watch: libuv's Windows watcher aborts the process when a watched
 * directory is removed (src\win\fs-event.c), and run directories are
 * routinely created and deleted. 200ms keeps pushes well inside the 2s
 * freshness budget.
 */
const POLL_MS = 200

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

  /**
   * Read events after `fromByte` using a real byte cursor. Only complete
   * newline-terminated lines are consumed: the cursor stops at the byte
   * after the last `\n`, so a half-written tail line survives until its
   * newline arrives. A file that shrank (rotation/truncation) is re-read
   * from the start so replaced content still reaches the client.
   */
  const readEventLines = async (fromByte: number): Promise<{ lines: RunEventLine[]; nextByte: number }> => {
    try {
      const buffer = await readFile(eventsPath)
      const start = fromByte > 0 && fromByte <= buffer.length ? fromByte : 0
      const chunk = buffer.subarray(start)
      const lastNewline = chunk.lastIndexOf(10)
      if (lastNewline === -1) return { lines: [], nextByte: start }
      const complete = chunk.subarray(0, lastNewline + 1)
      const lines: RunEventLine[] = []
      for (const line of complete.toString('utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          lines.push(JSON.parse(line) as RunEventLine)
        } catch {
          // corrupt complete line: skip it, keep the cursor moving
        }
      }
      return { lines, nextByte: start + lastNewline + 1 }
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
    const { lines, nextByte } = await readEventLines(0)
    eventsByteOffset = nextByte
    const snapshotLines = lines.slice(-SNAPSHOT_EVENT_LINES)
    if (snapshotLines.length > 0) sendEvent(response, 'events', { lines: redactAgentArtifactValue(snapshotLines, []) as RunEventLine[] })
  }

  // One replaceable debounce timer per kind: fired timers do not accumulate.
  const debounceTimers: Partial<Record<'state' | 'events', NodeJS.Timeout>> = {}
  const onChange = (kind: 'state' | 'events'): void => {
    if (closed) return
    const existing = debounceTimers[kind]
    if (existing) clearTimeout(existing)
    debounceTimers[kind] = setTimeout(() => {
      delete debounceTimers[kind]
      void (kind === 'state' ? pushState() : pushNewEvents())
    }, 150)
  }

  // mtime polling: see POLL_MS comment. A vanished run directory simply
  // stops producing changes; the heartbeat keeps the connection honest.
  let lastStateMtimeMs = 0
  let lastEventsSize = -1
  timers.push(setInterval(() => {
    if (closed) return
    void (async () => {
      const stateStats = await stat(statePath).catch(() => undefined)
      if (stateStats && stateStats.mtimeMs !== lastStateMtimeMs) {
        lastStateMtimeMs = stateStats.mtimeMs
        onChange('state')
      }
      const eventsStats = await stat(eventsPath).catch(() => undefined)
      if (eventsStats && eventsStats.size !== lastEventsSize) {
        lastEventsSize = eventsStats.size
        onChange('events')
      }
    })()
  }, POLL_MS))

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
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
    for (const kind of ['state', 'events'] as const) {
      const timer = debounceTimers[kind]
      if (timer) clearTimeout(timer)
      delete debounceTimers[kind]
    }
  }

  return { close }
}
