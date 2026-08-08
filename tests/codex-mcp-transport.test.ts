import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexAgentHost } from '../src/agent/codex-host.js'
import { prepareCodexAgentWorkspace } from '../src/agent/workspace.js'
import type { AgentEvent } from '../src/agent/host.js'
import { toAgentModelProviderDescriptor, type ModelProfile } from '../src/workflow/model-profile.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'

const directories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    if (!server.listening) return
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function manifest(): WorkflowIntakeManifest {
  return {
    version: '1.0', kind: 'workflow-intake', workflowId: 'mcp-transport-fixture',
    source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'c'.repeat(64) },
    targetUrls: ['https://fixture.example.test/'], requiredCapabilities: [],
    phases: [{
      id: 'case-one', title: 'Read the test contract', sourceRow: 2, risk: 'read',
      steps: [{ id: 'step-one', sourceText: 'Read the immutable test contract', confidence: 1 }],
      resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] },
    }],
    embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function requestJson(request: AsyncIterable<Uint8Array>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function sendSse(response: import('node:http').ServerResponse, events: unknown[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end()
}

describe('Codex managed-provider MCP transport', () => {
  it.skipIf(process.platform === 'win32')('executes a real Control MCP call through a flat-function Responses provider', async () => {
    const requests: Record<string, unknown>[] = []
    const provider = createServer(async (request, response) => {
      const body = await requestJson(request)
      requests.push(body)
      if (requests.length === 1) {
        const tools = body.tools as Array<Record<string, unknown>>
        const name = tools.find((tool) => typeof tool.name === 'string' && tool.name.includes('test_contract'))?.name
        if (typeof name !== 'string') {
          response.writeHead(400).end('missing flattened test_contract tool')
          return
        }
        sendSse(response, [
          { type: 'response.created', response: { id: 'response-1' } },
          { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'contract-call', name, arguments: '{}' } },
          { type: 'response.completed', response: { id: 'response-1', usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } },
        ])
        return
      }
      sendSse(response, [
        { type: 'response.created', response: { id: 'response-2' } },
        { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'message-1', content: [{ type: 'output_text', text: 'contract confirmed' }] } },
        { type: 'response.completed', response: { id: 'response-2', usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } },
      ])
    })
    servers.push(provider)
    const providerBaseUrl = `${await listen(provider)}/v1`
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-codex-mcp-transport-'))
    directories.push(directory)
    const browserExecutablePath = resolve(directory, 'chromium')
    await writeFile(browserExecutablePath, '')
    await chmod(browserExecutablePath, 0o755)
    const environment = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? directory,
      FIXTURE_PROVIDER_KEY: 'fixture-key',
    }
    const workflow = manifest()
    const workspace = await prepareCodexAgentWorkspace({
      outputDirectory: resolve(directory, 'run'),
      manifest: workflow,
      profile: {
        id: 'fixture', origins: ['https://fixture.example.test'], auth: [],
        policy: { allowWrite: false, allowDestructive: false },
      },
      secrets: {}, headed: false, browserExecutablePath, environment,
    })
    const modelProfile: ModelProfile = {
      id: 'fixture', model: 'fixture-model', providerId: 'fixture_provider',
      baseUrl: providerBaseUrl, api: 'openai-responses', envKey: 'FIXTURE_PROVIDER_KEY',
      inputModalities: ['text'], supportsWebsockets: false,
    }
    const executable = resolve(dirname(createRequire(import.meta.url).resolve('@openai/codex/package.json')), 'bin', 'codex.js')
    const host = new CodexAgentHost()
    const runtime = await host.modelProvider.prepare({
      workspaceDirectory: workspace.workspaceDirectory,
      privateDirectory: workspace.privateDirectory,
      agentHome: workspace.agentHome,
      executable,
      playwrightConfigPath: workspace.playwrightConfigPath,
      playwrightSecretsPath: workspace.playwrightSecretsPath,
      controlConfigPath: workspace.controlConfigPath,
      environment,
      mcpEnvironment: workspace.mcpEnvironment,
      provider: toAgentModelProviderDescriptor(modelProfile),
    })
    const launchOptions = {
      workspaceDirectory: workspace.workspaceDirectory,
      runtime,
      executable,
      playwrightConfigPath: workspace.playwrightConfigPath,
      playwrightSecretsPath: workspace.playwrightSecretsPath,
      controlConfigPath: workspace.controlConfigPath,
      fullAgentAccess: false,
    }
    const session = await host.start(launchOptions)
    const events: AgentEvent[] = []
    let resumeId: string | null = null
    try {
      for await (const event of (await session.run([{
        type: 'text', text: 'Call auto-test-control.test_contract exactly once, then confirm.',
      }])).events) events.push(event)
      resumeId = session.id
    } finally {
      await session.close?.()
    }

    expect(resumeId).toBeTruthy()
    const resumed = await host.resume({ ...launchOptions, resumeId: resumeId! })
    try {
      for await (const event of (await resumed.run([{
        type: 'text', text: 'Reply with a short confirmation without calling a tool.',
      }])).events) events.push(event)
    } finally {
      await resumed.close?.()
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_completed', server: 'auto-test-control', tool: 'test_contract', status: 'completed',
    }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent_message', text: 'contract confirmed' }))
    expect(requests).toHaveLength(3)
    expect((requests[0]?.tools as Array<Record<string, unknown>>).some((tool) => tool.type === 'namespace')).toBe(false)
    const secondInput = requests[1]?.input as Array<Record<string, unknown>>
    expect(secondInput.some((item) => item.type === 'function_call_output' && item.call_id === 'contract-call')).toBe(true)
    expect(await readFile(workspace.mutationLedgerPath, 'utf8')).toBe('[]\n')
  }, 30_000)
})
