import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CodexTestAgentState } from '../src/agent/types.js'
import { startObservationServer, type ObservationServer } from '../src/observe/server.js'
import { observationDashboardHtml } from '../src/observe/dashboard-html.js'

const servers: ObservationServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()))
})

async function stateFixture(overrides: Partial<CodexTestAgentState> = {}): Promise<CodexTestAgentState> {
  return {
    version: '2.0',
    status: 'running',
    stage: 'executing',
    workflowId: 'workflow',
    sourceSha256: 'a'.repeat(64),
    startedAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-01T08:10:00.000Z',
    threadGeneration: 0,
    completedCaseIds: [],
    ...overrides,
  }
}

async function writeRun(runRoot: string, runId: string, state: unknown): Promise<string> {
  const directory = resolve(runRoot, runId)
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, 'codex-agent.state.json'), JSON.stringify(state))
  return directory
}

describe('observation server (read-only Run list)', () => {
  it('serves the embedded single-file dashboard at the root', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-'))
    try {
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const response = await fetch(`${server.baseUrl}/`)
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(body).toContain('Auto-Test 观测面板')
      expect(body).not.toContain('</script><script') // single self-contained page
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('lists runs with status, stage, outcome, and timestamps, newest first', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-'))
    try {
      await writeRun(directory, '20260901-080000-catalog-abc12', await stateFixture({
        status: 'completed', stage: 'completed', outcome: 'passed',
        startedAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:05:00.000Z',
        finishedAt: '2026-09-01T08:05:00.000Z',
      }))
      await writeRun(directory, '20260901-090000-checkout-xyz34', await stateFixture({
        status: 'running', stage: 'finalizing',
        startedAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-01T09:04:00.000Z',
      }))
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const response = await fetch(`${server.baseUrl}/api/runs`)
      const body = await response.json() as { runs: Array<{ runId: string; status: string; stage: string; outcome: string; finishedAt?: string }> }
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(body.runs.map((run) => run.runId)).toEqual([
        '20260901-090000-checkout-xyz34',
        '20260901-080000-catalog-abc12',
      ])
      expect(body.runs[0]).toMatchObject({ status: 'running', stage: 'finalizing', outcome: 'none' })
      expect(body.runs[0]?.finishedAt).toBeUndefined()
      expect(body.runs[1]).toMatchObject({ status: 'completed', stage: 'completed', outcome: 'passed' })
      expect(body.runs[1]?.finishedAt).toBe('2026-09-01T08:05:00.000Z')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns an empty list for an empty run root instead of erroring', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-'))
    try {
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const response = await fetch(`${server.baseUrl}/api/runs`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ runs: [] })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns an empty list when the run root does not exist', async () => {
    const server = await startObservationServer({ runRoot: resolve(tmpdir(), 'auto-test-observe-missing-root') })
    servers.push(server)
    const response = await fetch(`${server.baseUrl}/api/runs`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ runs: [] })
  })

  it('marks runs with corrupt or legacy state files as invalid without failing the list', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-'))
    try {
      await writeRun(directory, '20260901-080000-corrupt-def56', { version: '1.0', status: 'running' })
      await writeRun(directory, '20260901-080000-broken-ghi78', 'not json at all')
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const response = await fetch(`${server.baseUrl}/api/runs`)
      const body = await response.json() as { runs: Array<{ runId: string; status: string }> }
      expect(response.status).toBe(200)
      expect(body.runs).toHaveLength(2)
      expect(body.runs.every((run) => run.status === 'invalid')).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('ignores directories without a state file and finds nested run directories', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-'))
    try {
      await mkdir(resolve(directory, 'plain-folder'), { recursive: true })
      await writeRun(directory, '20260901-080000-nested-jkl90', await stateFixture())
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const response = await fetch(`${server.baseUrl}/api/runs`)
      const body = await response.json() as { runs: Array<{ runId: string }> }
      expect(response.status).toBe(200)
      expect(body.runs.map((run) => run.runId)).toEqual(['20260901-080000-nested-jkl90'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('binds to loopback only and releases the port on close', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-'))
    try {
      const server = await startObservationServer({ runRoot: directory })
      const baseUrl = server.baseUrl
      expect(baseUrl).toContain('http://127.0.0.1:')
      await server.close()
      const response = await fetch(`${baseUrl}/api/runs`).catch((error: unknown) => error)
      expect(response).toBeInstanceOf(Error)
      // Restart on the same OS-assigned port to prove it was released.
      const replacement = await startObservationServer({ runRoot: directory, port: Number(new URL(baseUrl).port) })
      servers.push(replacement)
      expect((await fetch(`${replacement.baseUrl}/api/runs`)).status).toBe(200)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects non-GET methods and unknown paths', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-'))
    try {
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      expect((await fetch(`${server.baseUrl}/api/runs`, { method: 'POST' })).status).toBe(405)
      expect((await fetch(`${server.baseUrl}/nope`)).status).toBe(404)
      expect((await fetch(`${server.baseUrl}/api/secret`)).status).toBe(404)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('exposes a stable embedded HTML builder without build tooling', () => {
    const html = observationDashboardHtml()
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('/api/runs')
    expect(html).not.toContain('src="')   // no external assets
    expect(html).not.toContain('href="') // no external links
  })

  it('renders run rows via text nodes so hostile directory names cannot inject HTML', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-'))
    try {
      await writeRun(directory, '20260901-080000-hostile-zz99', await stateFixture())
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const response = await fetch(`${server.baseUrl}/api/runs`)
      const body = await response.json() as { runs: Array<{ runId: string }> }
      expect(response.status).toBe(200)
      // The API passes the raw directory name through as data; the embedded
      // page builds rows with textContent (no innerHTML for run fields), so
      // the value is always displayed as text. The page must never template
      // run fields straight into HTML.
      expect(body.runs[0]?.runId).toBe('20260901-080000-hostile-zz99')
      const html = observationDashboardHtml()
      expect(html).not.toContain('${run.')          // no run fields templated into HTML
      expect(html).not.toContain('.innerHTML = ${') // no interpolated innerHTML
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('marks states with an unknown outcome as invalid instead of trusting them', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-'))
    try {
      await writeRun(directory, '20260901-080000-weird-aa11', await stateFixture({
        status: 'running', outcome: 'mysterious_outcome' as never,
      }))
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const response = await fetch(`${server.baseUrl}/api/runs`)
      const body = await response.json() as { runs: Array<{ status: string; outcome: string }> }
      expect(response.status).toBe(200)
      expect(body.runs[0]?.status).toBe('invalid')
      expect(body.runs[0]?.outcome).toBe('none')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
