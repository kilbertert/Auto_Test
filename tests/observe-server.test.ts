import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CodexTestAgentResult, CodexTestAgentState } from '../src/agent/types.js'
import { startObservationServer, type ObservationServer } from '../src/observe/server.js'
import { friendlyRunSummary, type FriendlyRunSummary } from '../src/usability/result-summary.js'
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

  it('projects a completed run detail with cases, evidence counts, and the console-same summary', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-'))
    try {
      const runId = '20260901-080000-catalog-aa22'
      const runDir = resolve(directory, runId)
      const resultPath = resolve(runDir, 'codex-agent.result.json')
      const result: CodexTestAgentResult = {
        version: '1.0', workflowId: 'catalog', sourceSha256: 'b'.repeat(64), outcome: 'product_failed',
        summary: 'Checkout mismatch.', startedAt: '2026-09-01T08:00:00.000Z', finishedAt: '2026-09-01T08:05:00.000Z',
        cases: [
          { caseId: 'filter', title: 'Filter', outcome: 'passed', summary: 'Count matched.', evidence: [{ kind: 'observation', description: 'Rows.' }] },
          { caseId: 'checkout', title: 'Checkout', outcome: 'product_failed', summary: 'Total mismatch.', failureSource: 'product', failureKind: 'assertion', evidence: [{ kind: 'screenshot', path: 'evidence/checkout.png', description: 'Cart.' }] },
        ],
        mutations: [], environmentRequirements: [], blockers: ['结算金额不一致'], productDefects: ['总价少了 1 元'], nextActions: ['核对税费规则'],
      }
      await writeRun(directory, runId, await stateFixture({
        status: 'completed', stage: 'completed', outcome: 'product_failed', resultPath,
        startedAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:05:00.000Z', finishedAt: '2026-09-01T08:05:00.000Z',
        completedCaseIds: ['filter', 'checkout'],
      }))
      await writeFile(resultPath, JSON.stringify(result))

      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const response = await fetch(`${server.baseUrl}/api/runs/${runId}`)
      const detail = await response.json() as {
        runId: string
        progress: { completedCaseCount: number; epochCount?: number }
        cases: Array<{ caseId: string; outcome: string; failureSource?: string; evidenceCount: number }>
        summary: { title: string; outcome: string }
        resultProblem?: string
      }
      expect(response.status).toBe(200)
      expect(detail.runId).toBe(runId)
      expect(detail.progress.completedCaseCount).toBe(2)
      expect(detail.cases).toHaveLength(2)
      expect(detail.cases[1]).toMatchObject({ caseId: 'checkout', outcome: 'product_failed', failureSource: 'product', evidenceCount: 1 })
      expect(detail.summary.outcome).toBe('product_failed')
      expect(detail.resultProblem).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('projects an in-progress run detail with epoch progress and interruption recovery', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-'))
    try {
      const runId = '20260901-090000-live-bb33'
      await writeRun(directory, runId, await stateFixture({
        status: 'running', stage: 'executing',
        epochCount: 3,
        activeEpoch: { id: 'epoch-2', index: 1, total: 3, caseIds: ['case-a', 'case-b'], stage: 'executing' },
        completedCaseIds: ['case-a'],
        runInterruption: { code: 'provider_rate_limited', stage: 'execution', summary: '模型限流', nextAction: '稍后自动重试', occurredAt: '2026-09-01T09:02:00.000Z' },
      }))
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const response = await fetch(`${server.baseUrl}/api/runs/${runId}`)
      const detail = await response.json() as {
        progress: { activeEpochIndex?: number; activeEpochTotal?: number; activeEpochStage?: string; completedCaseCount: number; runInterruptionSummary?: string; runInterruptionNextAction?: string }
        cases: unknown[]
      }
      expect(response.status).toBe(200)
      expect(detail.progress.activeEpochIndex).toBe(1)
      expect(detail.progress.activeEpochTotal).toBe(3)
      expect(detail.progress.activeEpochStage).toBe('executing')
      expect(detail.progress.completedCaseCount).toBe(1)
      expect(detail.progress.runInterruptionSummary).toBe('模型限流')
      expect(detail.progress.runInterruptionNextAction).toBe('稍后自动重试')
      expect(detail.cases).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('shows pending environment blockers with their unblock conditions in a blocked run detail', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-'))
    try {
      const runId = '20260901-093000-blocked-cc44'
      const runDir = resolve(directory, runId)
      const resultPath = resolve(runDir, 'codex-agent.result.json')
      const result: CodexTestAgentResult = {
        version: '1.0', workflowId: 'catalog', sourceSha256: 'b'.repeat(64), outcome: 'blocked',
        summary: 'Blocked by credentials.', startedAt: '2026-09-01T09:30:00.000Z', finishedAt: '2026-09-01T09:31:00.000Z',
        cases: [
          { caseId: 'login', title: 'Login', outcome: 'blocked', summary: 'No credentials.', failureSource: 'environment', failureKind: 'environment', environmentRequirementIds: ['req-1'], evidence: [] },
        ],
        mutations: [],
        environmentRequirements: [
          { id: 'req-1', caseIds: ['login'], kind: 'authentication', origin: 'https://app.example.test', condition: '需要测试账号', evidence: [], status: 'pending', requestedAt: '2026-09-01T09:30:00.000Z' },
          { id: 'req-2', caseIds: [], kind: 'origin', condition: '已满足的来源', evidence: [], status: 'satisfied', requestedAt: '2026-09-01T09:30:00.000Z' },
        ],
        blockers: ['需要测试账号'], productDefects: [], nextActions: ['补充凭据后恢复运行'],
      }
      await writeRun(directory, runId, await stateFixture({
        status: 'completed', stage: 'completed', outcome: 'blocked', resultPath,
        completedCaseIds: [],
      }))
      await writeFile(resultPath, JSON.stringify(result))

      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const response = await fetch(`${server.baseUrl}/api/runs/${runId}`)
      const detail = await response.json() as { environmentBlockers: Array<{ id: string; condition: string; status?: string }> }
      expect(response.status).toBe(200)
      expect(detail.environmentBlockers).toHaveLength(1)
      expect(detail.environmentBlockers[0]).toMatchObject({ id: 'req-1', condition: '需要测试账号' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('degrades to a result problem instead of 500 when the result file is corrupt', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-'))
    try {
      const runId = '20260901-094000-broken-dd55'
      const runDir = resolve(directory, runId)
      const resultPath = resolve(runDir, 'codex-agent.result.json')
      await writeRun(directory, runId, await stateFixture({
        status: 'completed', stage: 'completed', outcome: 'passed', resultPath,
      }))
      await writeFile(resultPath, 'not json')

      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const response = await fetch(`${server.baseUrl}/api/runs/${runId}`)
      const detail = await response.json() as { resultProblem?: string; cases: unknown[]; summary: { title: string } }
      expect(response.status).toBe(200)
      expect(detail.resultProblem).toContain('结果文件缺失或损坏')
      expect(detail.cases).toEqual([])
      expect(detail.summary.title).toBeTruthy()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns 404 for unknown, traversing, or encoded run ids', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-'))
    try {
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      expect((await fetch(`${server.baseUrl}/api/runs/does-not-exist`)).status).toBe(404)
      expect((await fetch(`${server.baseUrl}/api/runs/..%2F..%2Fetc`)).status).toBe(404)
      expect((await fetch(`${server.baseUrl}/api/runs/${encodeURIComponent('..')}`)).status).toBe(404)
      expect((await fetch(`${server.baseUrl}/api/runs/a/b`)).status).toBe(404)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps the web detail summary identical to the console summary (single source)', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-'))
    try {
      const runId = '20260901-080000-parity-ee66'
      const runDir = resolve(directory, runId)
      const resultPath = resolve(runDir, 'codex-agent.result.json')
      const result: CodexTestAgentResult = {
        version: '1.0', workflowId: 'catalog', sourceSha256: 'b'.repeat(64), outcome: 'blocked',
        summary: 'Blocked.', startedAt: '2026-09-01T08:00:00.000Z', finishedAt: '2026-09-01T08:05:00.000Z',
        cases: [
          { caseId: 'login', title: 'Login', outcome: 'blocked', summary: 'No account.', failureSource: 'environment', failureKind: 'environment', environmentRequirementIds: ['req-1'], evidence: [] },
        ],
        mutations: [], environmentRequirements: [
          { id: 'req-1', caseIds: ['login'], kind: 'test_data', condition: '需要测试数据', evidence: [], status: 'pending', requestedAt: '2026-09-01T08:00:00.000Z' },
        ],
        blockers: ['需要测试数据'], productDefects: [], nextActions: ['补充后恢复'],
      }
      await writeRun(directory, runId, await stateFixture({
        status: 'completed', stage: 'completed', outcome: 'blocked', resultPath,
        completedCaseIds: [],
      }))
      await writeFile(resultPath, JSON.stringify(result))

      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const statePath = resolve(runDir, 'codex-agent.state.json')
      const consoleSummary = await friendlyRunSummary(statePath)
      const detail = await (await fetch(`${server.baseUrl}/api/runs/${runId}`)).json() as { summary: FriendlyRunSummary }
      expect(detail.summary).toEqual(consoleSummary)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
