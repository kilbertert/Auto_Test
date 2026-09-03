import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
    version: '2.0', status: 'completed', stage: 'completed', outcome: 'passed',
    workflowId: 'workflow', sourceSha256: 'a'.repeat(64),
    startedAt: '2026-09-03T08:00:00.000Z', updatedAt: '2026-09-03T08:05:00.000Z',
    threadGeneration: 0, completedCaseIds: [],
    ...overrides,
  }
}

async function oneRun(root: string): Promise<void> {
  const directory = resolve(root, '20260903-080000-remote-01')
  await writeFile(resolve(directory, 'codex-agent.state.json'), JSON.stringify(stateFixture())).catch(async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(directory, { recursive: true })
    await writeFile(resolve(directory, 'codex-agent.state.json'), JSON.stringify(stateFixture()))
  })
}

describe('observation server remote access (token gate)', () => {
  it('refuses a non-loopback bind without a token', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-remote-'))
    try {
      await expect(startObservationServer({ runRoot: directory, host: '0.0.0.0', token: '' })).rejects.toThrow(/访问令牌/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps loopback unauthenticated and unchanged', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-remote-'))
    try {
      await oneRun(directory)
      const server = await startObservationServer({ runRoot: directory })
      servers.push(server)
      expect(server.baseUrl).not.toContain('token=')
      expect((await fetch(`${server.baseUrl}/api/runs`)).status).toBe(200)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('gates every route behind the token on a non-loopback bind', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-remote-'))
    try {
      await oneRun(directory)
      const server = await startObservationServer({ runRoot: directory, host: '0.0.0.0', token: 'kiosk-token-1' })
      servers.push(server)
      expect(server.baseUrl).toContain('/?token=')
      const routes = ['/', '/api/runs', '/api/runs/20260903-080000-remote-01', '/api/runs/20260903-080000-remote-01/events']
      for (const route of routes) {
        expect((await fetch(`http://127.0.0.1:${new URL(server.baseUrl).port}${route}`)).status).toBe(401)
        expect((await fetch(`http://127.0.0.1:${new URL(server.baseUrl).port}${route}`, {
          headers: { authorization: 'Bearer wrong' },
        })).status).toBe(401)
        expect((await fetch(`http://127.0.0.1:${new URL(server.baseUrl).port}${route}`, {
          headers: { authorization: 'Bearer kiosk-token-1' },
        })).status).toBe(200)
      }
      // The query form serves EventSource clients.
      expect((await fetch(`${server.baseUrl}`)).status).toBe(200)
      expect((await fetch(`http://127.0.0.1:${new URL(server.baseUrl).port}/api/runs?token=kiosk-token-1`)).status).toBe(200)
      // Either channel carrying the valid token is enough — a wrong query
      // token must not shadow a valid Bearer header.
      expect((await fetch(`http://127.0.0.1:${new URL(server.baseUrl).port}/api/runs?token=wrong`, {
        headers: { authorization: 'Bearer kiosk-token-1' },
      })).status).toBe(200)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps SSE frames flowing for an authorized remote client', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-remote-'))
    try {
      await oneRun(directory)
      const server = await startObservationServer({ runRoot: directory, host: '0.0.0.0', token: 'kiosk-token-2' })
      servers.push(server)
      const port = new URL(server.baseUrl).port
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4_000)
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/runs/20260903-080000-remote-01/events?token=kiosk-token-2`, { signal: controller.signal })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        // Read incrementally until the first state frame arrives, then stop.
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let text = ''
        while (!text.includes('event: state')) {
          const { done, value } = await reader.read()
          if (done) break
          text += decoder.decode(value, { stream: true })
        }
        expect(text).toContain('event: state')
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
      // Without the token the stream endpoint is closed immediately.
      const denied = await fetch(`http://127.0.0.1:${port}/api/runs/20260903-080000-remote-01/events`)
      expect(denied.status).toBe(401)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('honors a fixed port for FRP tunnel setups and validates the flag', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-remote-'))
    try {
      await oneRun(directory)
      // Use a scratch port here (the registered 11880 may be live in dev);
      // this test pins the behavior, not the registry allocation.
      const port = 21451
      const server = await startObservationServer({ runRoot: directory, port })
      servers.push(server)
      expect(new URL(server.baseUrl).port).toBe(String(port))
      // The fixed port is released on close (needed for tunnel restarts).
      await server.close()
      const rebound = await startObservationServer({ runRoot: directory, port })
      servers.push(rebound)
      expect(new URL(rebound.baseUrl).port).toBe(String(port))
      expect((await fetch(`${rebound.baseUrl}/api/runs`)).status).toBe(200)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('enforces an explicit token even on a loopback bind (tunnel reachability)', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-remote-'))
    try {
      await oneRun(directory)
      // Loopback + explicit token: the token gate must hold, because a
      // loopback bind is reachable from other machines through an FRP or
      // SSH-forward tunnel — the recommended remote-access pattern.
      const server = await startObservationServer({ runRoot: directory, token: 'tunnel-token' })
      servers.push(server)
      expect(server.baseUrl).toContain('token=tunnel-token')
      const routes = ['/', '/api/runs', '/api/runs/20260903-080000-remote-01']
      for (const route of routes) {
        expect((await fetch(`http://127.0.0.1:${new URL(server.baseUrl).port}${route}`)).status).toBe(401)
        expect((await fetch(`http://127.0.0.1:${new URL(server.baseUrl).port}${route}?token=tunnel-token`)).status).toBe(200)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('prints bracketed IPv6 and a reachability hint for wildcard binds', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-observe-remote-'))
    try {
      await oneRun(directory)
      // ::1 is loopback: bracketed URL, no token required by design.
      const v6 = await startObservationServer({ runRoot: directory, host: '::1' })
      servers.push(v6)
      expect(v6.baseUrl).toContain('http://[::1]:')
      expect(v6.baseUrl).not.toContain('token=')
      const wildcard = await startObservationServer({ runRoot: directory, host: '0.0.0.0', token: 'wild-token' })
      servers.push(wildcard)
      expect(wildcard.baseUrl).toContain('http://0.0.0.0:')
      expect(wildcard.reachHint).toContain('局域网')
      // A wildcard bind is still fully token-gated.
      expect((await fetch(`http://127.0.0.1:${new URL(wildcard.baseUrl).port}/api/runs`)).status).toBe(401)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
