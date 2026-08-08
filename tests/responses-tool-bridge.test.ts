import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  flattenResponsesTools,
  restoreResponsesToolCalls,
  startResponsesToolBridge,
  type ResponsesToolBridge,
} from '../src/agent/responses-tool-bridge.js'

const servers: Server[] = []
const bridges: ResponsesToolBridge[] = []

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()))
  await Promise.all(servers.splice(0).map(async (server) => {
    if (!server.listening) return
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }))
})

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function jsonBody(request: AsyncIterable<Uint8Array>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

describe('Responses namespace compatibility bridge', () => {
  it('round-trips namespaced MCP calls through standard flat function tools', () => {
    const request: Record<string, unknown> = {
      tools: [
        { type: 'function', name: 'shell_command', description: 'Run a command', strict: false, parameters: { type: 'object' } },
        {
          type: 'namespace',
          name: 'mcp__auto_test_control',
          description: 'Auto-Test control tools',
          tools: [{ type: 'function', name: 'test_contract', description: 'Read the contract', strict: false, parameters: { type: 'object' } }],
        },
      ],
      input: [{ type: 'function_call', call_id: 'prior-call', namespace: 'mcp__auto_test_control', name: 'test_contract', arguments: '{}' }],
    }

    const mapping = flattenResponsesTools(request)
    const tools = request.tools as Array<Record<string, unknown>>
    const flattened = tools.find((tool) => tool.name !== 'shell_command')!
    expect(tools.some((tool) => tool.type === 'namespace')).toBe(false)
    expect(flattened).toMatchObject({ type: 'function', name: 'mcp__auto_test_control__test_contract' })
    expect(request.input).toEqual([expect.objectContaining({
      type: 'function_call', name: flattened.name, call_id: 'prior-call',
    })])
    expect((request.input as Array<Record<string, unknown>>)[0]).not.toHaveProperty('namespace')

    const providerEvent = {
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'next-call', name: flattened.name, arguments: '{}' },
    }
    expect(restoreResponsesToolCalls(providerEvent, mapping)).toEqual({
      type: 'response.output_item.done',
      item: {
        type: 'function_call', call_id: 'next-call',
        namespace: 'mcp__auto_test_control', name: 'test_contract', arguments: '{}',
      },
    })
  })

  it('rewrites a streamed provider call without changing call IDs or tool results', async () => {
    let upstreamRequest: Record<string, unknown> | undefined
    const upstream = createServer(async (request, response) => {
      upstreamRequest = await jsonBody(request)
      const tools = upstreamRequest.tools as Array<Record<string, unknown>>
      const name = tools.find((tool) => typeof tool.name === 'string' && tool.name.includes('test_contract'))?.name
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of [
        { type: 'response.created', response: { id: 'response-1' } },
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call-1', name, arguments: '{}' } },
        { type: 'response.completed', response: { id: 'response-1', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) response.write(`data: ${JSON.stringify(event)}\n\n`)
      response.end()
    })
    servers.push(upstream)
    const upstreamBaseUrl = `${await listen(upstream)}/v1`
    const bridge = await startResponsesToolBridge(upstreamBaseUrl)
    bridges.push(bridge)

    const response = await fetch(`${bridge.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer fixture' },
      body: JSON.stringify({
        model: 'fixture', stream: true, input: [],
        tools: [{
          type: 'namespace', name: 'mcp__auto_test_control', description: 'Control',
          tools: [{ type: 'function', name: 'test_contract', description: 'Contract', strict: false, parameters: { type: 'object' } }],
        }],
      }),
    })
    const events = (await response.text()).split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>)

    expect(response.status).toBe(200)
    expect((upstreamRequest?.tools as Array<Record<string, unknown>>)).toEqual([
      expect.objectContaining({ type: 'function', name: 'mcp__auto_test_control__test_contract' }),
    ])
    expect(events[1]).toMatchObject({
      type: 'response.output_item.done',
      item: {
        type: 'function_call', call_id: 'call-1',
        namespace: 'mcp__auto_test_control', name: 'test_contract', arguments: '{}',
      },
    })
  })
})
