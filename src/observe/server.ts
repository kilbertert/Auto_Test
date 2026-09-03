import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readdir, readFile, stat } from 'node:fs/promises'
import { randomBytes, timingSafeEqual as timingSafeEqualBuffer } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { CodexTestAgentState, CodexTestOutcome } from '../agent/types.js'
import { defaultRunRoot } from '../usability/run-directory.js'
import { observationDashboardHtml } from './dashboard-html.js'
import { runDetail } from './run-detail.js'
import { serveRunEventStream } from './run-events.js'
import { serveEvidenceFile } from './evidence.js'

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
  /** Bind host. Default 127.0.0.1 (loopback-only); any other value requires a token and is an explicit exposure decision. */
  host?: string
  /** Shared-secret token. Required (auto-generated when omitted) for any non-loopback bind. */
  token?: string
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


/** Validate one requested run id: exactly one safe directory segment that resolves inside the run root. */
export function runDirectoryFor(runRoot: string, requestedId: string): string | undefined {
  if (requestedId === '.' || requestedId === '..' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requestedId)) return undefined
  const resolved = resolve(runRoot, requestedId)
  const under = relative(runRoot, resolved)
  if (under === '' || under.startsWith('..') || isAbsolute(under)) return undefined
  return resolved
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
  const host = options.host ?? '127.0.0.1'
  const loopbackOnly = host === '127.0.0.1' || host === '::1' || host === 'localhost'
  // Any non-loopback bind is an explicit exposure decision: it must carry a
  // token so the read-only plane is never anonymously reachable on a network.
  const token = options.token ?? (loopbackOnly ? undefined : randomBytes(24).toString('base64url'))
  if (!loopbackOnly && !token) {
    throw new Error('非回环绑定必须提供访问令牌（--token），或让框架自动生成')
  }
  const timingSafeEqual = (a: string, b: string): boolean => {
    const left = Buffer.from(a)
    const right = Buffer.from(b)
    return left.length === right.length && timingSafeEqualBuffer(left, right)
  }
  const authorized = (request: IncomingMessage): boolean => {
    if (loopbackOnly) return true
    const header = request.headers.authorization
    if (header?.startsWith('Bearer ') && timingSafeEqual(header.slice('Bearer '.length), token!)) return true
    return false
  }
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (request.method !== 'GET') {
          json(response, 405, { error: '只读观测面：仅支持 GET' })
          return
        }
        // EventSource cannot set headers, so the token also travels as a query.
        if (!loopbackOnly) {
          const queryToken = url.searchParams.get('token')
          const bearer = request.headers.authorization?.startsWith('Bearer ')
            ? request.headers.authorization.slice('Bearer '.length)
            : undefined
          const provided = queryToken ?? bearer
          if (!provided || !timingSafeEqual(provided, token!)) {
            response.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'www-authenticate': 'Bearer', 'cache-control': 'no-store' })
            response.end(JSON.stringify({ error: '需要有效的访问令牌' }))
            return
          }
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
        const evidenceMatch = /^\/api\/runs\/([^/]+)\/evidence\/(.+)$/.exec(url.pathname)
        if (evidenceMatch) {
          const runDirectory = runDirectoryFor(runRoot, decodeURIComponent(evidenceMatch[1]!))
          if (!runDirectory) {
            json(response, 404, { error: '未找到' })
            return
          }
          // One percent-encoded path segment list under the run's evidence directory.
          const requestedPath = evidenceMatch[2]!.split('/').map(decodeURIComponent).join('/')
          await serveEvidenceFile(response, runDirectory, requestedPath)
          return
        }
        const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname)
        if (eventsMatch) {
          const runDirectory = runDirectoryFor(runRoot, decodeURIComponent(eventsMatch[1]!))
          const stateExists = runDirectory
            ? await stat(resolve(runDirectory, STATE_FILE)).then(() => true, () => false)
            : false
          if (!runDirectory || !stateExists) {
            json(response, 404, { error: '未找到' })
            return
          }
          serveRunEventStream(response, runDirectory)
          return
        }
        const detailMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname)
        if (detailMatch) {
          const runDirectory = runDirectoryFor(runRoot, decodeURIComponent(detailMatch[1]!))
          if (!runDirectory) {
            json(response, 404, { error: '未找到' })
            return
          }
          const detail = await runDetail(resolve(runDirectory, STATE_FILE))
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
    // Default is loopback-only; binding elsewhere is an explicit exposure
    // decision and is gated by the token check above.
    server.listen(options.port ?? 0, host, resolveListen)
  })
  const address = server.address() as AddressInfo
  const displayHost = address.family === 'IPv6' && !host.includes(':') ? `[${address.address}]` : host
  const baseUrl = `http://${displayHost}:${address.port}${loopbackOnly ? '' : `/?token=${token}`}`

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
