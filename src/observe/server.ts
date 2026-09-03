import { createServer, type ServerResponse } from 'node:http'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { CodexTestAgentState, CodexTestOutcome } from '../agent/types.js'
import { defaultRunRoot } from '../usability/run-directory.js'
import { observationDashboardHtml } from './dashboard-html.js'
import { runDetail } from './run-detail.js'
import { serveRunEventStream } from './run-events.js'

const STATE_FILE = 'codex-agent.state.json'

export interface ObservationRunEntry {
  runId: string
  status: CodexTestAgentState['status'] | 'invalid'
  stage: CodexTestAgentState['stage']
  outcome: CodexTestOutcome | 'none'
  startedAt: string
  updatedAt: string
  finishedAt: string | undefined
}

export interface ObservationServer {
  baseUrl: string
  close: () => Promise<void>
}

export interface StartObservationServerOptions {
  /** Run root to scan; defaults to the platform Run root. */
  runRoot?: string
  /** Port override for tests; default asks the OS for a free port. */
  port?: number
  /** Injection seam for tests; default serves the embedded single-file page. */
  html?: string
}

interface RunScanItem {
  directory: string
  statePath: string
  modifiedMs: number
}

/** Read one JSON file, returning undefined on read or parse failure. */
async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Find every run directory under the root that holds a state file.
 * Walks one directory level at a time: recursive withFileTypes readdir is
 * unreliable on Windows, matching the approach of the easy status scanner.
 */
async function scanRunRoot(root: string): Promise<RunScanItem[]> {
  const found: RunScanItem[] = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) continue
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = resolve(directory, entry.name)
      if (entry.isDirectory()) pending.push(child)
      else if (entry.isFile() && entry.name === STATE_FILE) {
        try {
          const stats = await stat(child)
          found.push({ directory: dirname(child), statePath: child, modifiedMs: stats.mtimeMs })
        } catch {
          // state file vanished mid-scan; skip it
        }
      }
    }
  }
  return found
}

async function listRuns(runRoot: string): Promise<ObservationRunEntry[]> {
  const runs = await scanRunRoot(runRoot)
  const entries: Array<{ entry: ObservationRunEntry; modifiedMs: number }> = []
  for (const run of runs) {
    const state = await readJsonFile(run.statePath)
    entries.push({ entry: runEntryFromState(run, state), modifiedMs: run.modifiedMs })
  }
  // Newest first; invalid entries sort last within the same mtime bucket.
  return entries
    .sort((left, right) => right.modifiedMs - left.modifiedMs)
    .map((item) => item.entry)
}

const OUTCOMES = new Set(['passed', 'product_failed', 'blocked', 'failed'])
const STATUSES = new Set(['running', 'completed', 'failed'])
const STAGES = new Set(['preparing', 'executing', 'finalizing', 'completed', 'failed'])

function runEntryFromState(run: RunScanItem, state: unknown): ObservationRunEntry {
  const runId = basename(run.directory)
  if (!isRecord(state) || state.version !== '2.0') {
    return {
      runId, status: 'invalid', stage: 'preparing', outcome: 'none',
      startedAt: '', updatedAt: new Date(run.modifiedMs).toISOString(), finishedAt: undefined,
    }
  }
  const status = String(state.status)
  const stage = String(state.stage)
  const outcome = state.outcome === undefined ? 'none' : String(state.outcome)
  const statusValid = STATUSES.has(status)
  const outcomeValid = outcome === 'none' || OUTCOMES.has(outcome)
  if (!statusValid || !outcomeValid) {
    return {
      runId, status: 'invalid', stage: STAGES.has(stage) ? stage as CodexTestAgentState['stage'] : 'preparing', outcome: 'none',
      startedAt: '', updatedAt: new Date(run.modifiedMs).toISOString(), finishedAt: undefined,
    }
  }
  return {
    runId,
    status: status as CodexTestAgentState['status'],
    stage: STAGES.has(stage) ? stage as CodexTestAgentState['stage'] : 'preparing',
    outcome: outcome as CodexTestOutcome,
    startedAt: String(state.startedAt ?? ''),
    updatedAt: String(state.updatedAt ?? '') || new Date(run.modifiedMs).toISOString(),
    finishedAt: state.finishedAt === undefined ? undefined : String(state.finishedAt),
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function json(response: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/** Serve the embedded dashboard HTML. */
async function serveIndex(response: ServerResponse): Promise<void> {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(observationDashboardHtml())
}

/**
 * Start the read-only observation server. It scans the Run root, serves the
 * single-file dashboard, and exposes a JSON list of runs. It never writes
 * anything and never exposes `.agent-private`.
 */
export async function startObservationServer(options: StartObservationServerOptions = {}): Promise<ObservationServer> {
  const runRoot = resolve(options.runRoot ?? defaultRunRoot())
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (request.method !== 'GET') {
          json(response, 405, { error: '只读观测面：仅支持 GET' })
          return
        }
        if (url.pathname === '/' || url.pathname === '/index.html') {
          await serveIndex(response)
          return
        }
        if (url.pathname === '/api/runs') {
          const runs = await listRuns(runRoot)
          json(response, 200, { runs })
          return
        }
        const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname)
        if (eventsMatch) {
          // A run id is one directory name: reject separators, dots, encodings.
          const requestedId = decodeURIComponent(eventsMatch[1]!)
          if (!/^[A-Za-z0-9._-]+$/.test(requestedId)) {
            json(response, 404, { error: '未找到' })
            return
          }
          const runDirectory = resolve(runRoot, requestedId)
          const stateExists = await stat(resolve(runDirectory, STATE_FILE)).then(() => true, () => false)
          if (!stateExists) {
            json(response, 404, { error: '未找到' })
            return
          }
          serveRunEventStream(response, runDirectory)
          return
        }
        const detailMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname)
        if (detailMatch) {
          // A run id is one directory name: reject separators, dots, encodings.
          const requestedId = decodeURIComponent(detailMatch[1]!)
          if (!/^[A-Za-z0-9._-]+$/.test(requestedId)) {
            json(response, 404, { error: '未找到' })
            return
          }
          const statePath = resolve(runRoot, requestedId, STATE_FILE)
          const detail = await runDetail(statePath)
          if (!detail) {
            json(response, 404, { error: '未找到' })
            return
          }
          json(response, 200, detail)
          return
        }
        json(response, 404, { error: '未找到' })
      } catch (error) {
        json(response, 500, { error: `观测面内部错误：${error instanceof Error ? error.message : String(error)}` })
      }
    })()
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    // The observation plane is loopback-only by construction; no host override.
    server.listen(options.port ?? 0, '127.0.0.1', resolveListen)
  })
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`

  return {
    baseUrl,
    close: async () => {
      if (!server.listening) return // idempotent: double close is a no-op
      // Drop live SSE connections first so close() is not held hostage by
      // keep-alive streams, then stop the listener.
      server.closeAllConnections()
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => error ? rejectClose(error) : resolveClose())
      })
    },
  }
}
