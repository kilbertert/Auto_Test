import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshAgentHost } from '../src/agent/dsh-host.js'
import type { AgentHostLaunchOptions } from '../src/agent/host.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('DSH SDK AgentHost', () => {
  it('keeps one persisted session across multiple JSON-RPC prompts', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-dsh-host-'))
    directories.push(directory)
    const workspaceDirectory = resolve(directory, 'workspace')
    const agentHome = resolve(directory, 'dsh-home')
    await mkdir(workspaceDirectory, { recursive: true })
    await mkdir(agentHome, { recursive: true })
    await writeFile(resolve(agentHome, 'cordis.yml'), 'fixture')
    const executable = resolve(directory, 'runtime.mjs')
    await writeFile(executable, `
import readline from 'node:readline'
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', line => {
  const frame = JSON.parse(line)
  if (frame.method === 'initialize') return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'test' } } }) + '\\n')
  if (frame.method === 'shutdown') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }) + '\\n'); return process.exit(0) }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { messageId: 'message-' + frame.id } }) + '\\n')
  const sessionId = frame.params.sessionId
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'turn/start', data: {} } } }) + '\\n')
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: frame.params.contentBlocks[0].text }] } } } } }) + '\\n')
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'tool/call', data: { callId: 'tool-' + frame.id, name: 'mcp__auto-test-control__case_execution_begin', arguments: JSON.stringify({ caseId: 'test-001' }) } } } }) + '\\n')
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'tool/result', data: { message: { source: { callId: 'tool-' + frame.id }, content: [], isError: false } } } } }) + '\\n')
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'turn/end', data: {} } } }) + '\\n')
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } }) + '\\n')
})
`)
    await chmod(executable, 0o700)
    const options: AgentHostLaunchOptions = {
      workspaceDirectory,
      runtime: { agentHome, environment: { PATH: process.env.PATH ?? '' }, mcpEnvironment: {} },
      executable,
      playwrightConfigPath: resolve(directory, 'playwright.json'),
      playwrightSecretsPath: resolve(directory, 'secrets.env'),
      controlConfigPath: resolve(directory, 'control.json'),
      fullAgentAccess: true,
    }
    const session = await new DshAgentHost().start(options)
    const first = await session.run([{ type: 'text', text: 'first' }])
    const firstEvents = []
    for await (const event of first.events) firstEvents.push(event)
    expect(firstEvents.find(event => event.type === 'agent_message')?.text).toBe('first')
    const second = await session.run([{ type: 'text', text: 'second' }])
    const secondEvents = []
    for await (const event of second.events) secondEvents.push(event)
    expect(secondEvents.find(event => event.type === 'agent_message')?.text).toBe('second')
    expect(secondEvents.find(event => event.type === 'tool_completed')?.arguments).toEqual({ caseId: 'test-001' })
    expect(session.id).toMatch(/^auto-test-/)
    await session.close?.()
  })
})
