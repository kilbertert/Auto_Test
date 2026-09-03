import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
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

/** One run with an evidence tree, private secrets, and a raw workbook copy. */
async function evidenceFixtureRun(root: string): Promise<string> {
  const runId = '20260901-080000-evidence-ev01'
  const runDir = resolve(root, runId)
  await mkdir(resolve(runDir, 'agent-workspace', 'evidence', 'checkout'), { recursive: true })
  await mkdir(resolve(runDir, '.agent-private'), { recursive: true })
  await mkdir(resolve(runDir, 'agent-workspace', 'input'), { recursive: true })
  await writeFile(resolve(runDir, 'codex-agent.state.json'), JSON.stringify(stateFixture({ status: 'completed', stage: 'completed', outcome: 'passed' })))
  // A valid 1x1 PNG.
  await writeFile(resolve(runDir, 'agent-workspace', 'evidence', 'checkout', 'cart.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  await writeFile(resolve(runDir, 'agent-workspace', 'evidence', 'console.txt'), 'stdout: 完成\n')
  await writeFile(resolve(runDir, '.agent-private', 'run-values.json'), 'OBS-SECRET-MARKER')
  await writeFile(resolve(runDir, 'agent-workspace', 'input', 'cases.xlsx'), 'fake workbook bytes')
  await writeFile(resolve(runDir, 'agent-workspace', 'evidence', 'mystery.bin'), 'binary-ish')
  return runId
}

describe('observation evidence serving (allowlist)', () => {
  it('serves evidence images and text with the right content types', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-evidence-'))
    try {
      const runId = await evidenceFixtureRun(directory)
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const png = await fetch(`${server.baseUrl}/api/runs/${runId}/evidence/checkout/cart.png`)
      expect(png.status).toBe(200)
      expect(png.headers.get('content-type')).toBe('image/png')
      expect((await png.arrayBuffer()).byteLength).toBeGreaterThan(50)
      const text = await fetch(`${server.baseUrl}/api/runs/${runId}/evidence/console.txt`)
      expect(text.status).toBe(200)
      expect(text.headers.get('content-type')).toContain('text/plain')
      expect(await text.text()).toContain('完成')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses unknown extensions and the raw workbook copy', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-evidence-'))
    try {
      const runId = await evidenceFixtureRun(directory)
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      expect((await fetch(`${server.baseUrl}/api/runs/${runId}/evidence/mystery.bin`)).status).toBe(404)
      // The workbook copy lives outside the evidence directory entirely.
      expect((await fetch(`${server.baseUrl}/api/runs/${runId}/evidence/../input/cases.xlsx`)).status).toBe(404)
      expect((await fetch(`${server.baseUrl}/api/runs/${runId}/evidence/${encodeURIComponent('..')}/input/cases.xlsx`)).status).toBe(404)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses traversal, agent-private, absolute paths, and encoded escapes', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-evidence-'))
    try {
      const runId = await evidenceFixtureRun(directory)
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const attempts = [
        `${server.baseUrl}/api/runs/${runId}/evidence/${encodeURIComponent('..')}/${encodeURIComponent('..')}/.agent-private/run-values.json`,
        `${server.baseUrl}/api/runs/${runId}/evidence/${encodeURIComponent('..')}/${encodeURIComponent('..')}/${encodeURIComponent('..')}/etc/passwd`,
        `${server.baseUrl}/api/runs/${runId}/evidence/%2e%2e%2f.agent-private%2frun-values.json`,
        `${server.baseUrl}/api/runs/${runId}/evidence/checkout/${encodeURIComponent('..')}/${encodeURIComponent('..')}/.agent-private/run-values.json`,
        `${server.baseUrl}/api/runs/${runId}/evidence/../../etc/passwd`,
      ]
      for (const url of attempts) {
        expect((await fetch(url)).status).toBe(404)
      }
      // And a direct request for the state file through the evidence route.
      expect((await fetch(`${server.baseUrl}/api/runs/${runId}/evidence/${encodeURIComponent('..')}/codex-agent.state.json`)).status).toBe(404)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('serves evidence referenced by the result contract path shape (evidence/<file>)', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-evidence-'))
    try {
      const runId = await evidenceFixtureRun(directory)
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      // Results record `evidence/<file>` relative to agent-workspace; the
      // route must accept that exact shape so dashboard links resolve.
      const response = await fetch(`${server.baseUrl}/api/runs/${runId}/evidence/${encodeURIComponent('checkout/cart.png')}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      // And the raw prefixed contract value also resolves to the same file:
      const prefixed = await fetch(`${server.baseUrl}/api/runs/${runId}/evidence/${encodeURIComponent('evidence')}/${encodeURIComponent('checkout/cart.png')}`)
      expect(prefixed.status).toBe(200)
      expect(prefixed.headers.get('content-type')).toBe('image/png')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps the secret marker out of every evidence response', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-evidence-'))
    try {
      const runId = await evidenceFixtureRun(directory)
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      const routes = [
        `${server.baseUrl}/api/runs/${runId}/evidence/console.txt`,
        `${server.baseUrl}/api/runs/${runId}/evidence/checkout/cart.png`,
        `${server.baseUrl}/api/runs`,
        `${server.baseUrl}/api/runs/${runId}`,
      ]
      for (const url of routes) {
        const body = await (await fetch(url)).text()
        expect(body).not.toContain('OBS-SECRET-MARKER')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
