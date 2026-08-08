import { createHash } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const MAX_REQUEST_BYTES = 32 * 1024 * 1024
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'content-encoding', 'content-length', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
])

interface ToolIdentity {
  namespace: string
  name: string
}

export interface ResponsesToolMapping {
  flatToNamespaced: Map<string, ToolIdentity>
  namespacedToFlat: Map<string, string>
}

export interface ResponsesToolBridge {
  baseUrl: string
  close(): Promise<void>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function namespacedKey(namespace: string, name: string): string {
  return `${namespace}\u0000${name}`
}

function flatToolName(namespace: string, name: string, used: Set<string>): string {
  const raw = `${namespace}__${name}`.replace(/[^A-Za-z0-9_-]/g, '_')
  let candidate = raw.slice(0, 64)
  if (raw.length > 64 || used.has(candidate)) {
    const suffix = createHash('sha256').update(`${namespace}\u0000${name}`).digest('hex').slice(0, 12)
    candidate = `${raw.slice(0, 51)}_${suffix}`
  }
  if (!candidate || used.has(candidate)) throw new Error(`Cannot uniquely flatten Responses tool ${namespace}.${name}`)
  used.add(candidate)
  return candidate
}

function rewriteFunctionCalls(value: unknown, mapping: ResponsesToolMapping, direction: 'flatten' | 'restore'): void {
  if (Array.isArray(value)) {
    for (const item of value) rewriteFunctionCalls(item, mapping, direction)
    return
  }
  const item = record(value)
  if (!item) return
  if (item.type === 'function_call' && typeof item.name === 'string') {
    if (direction === 'flatten' && typeof item.namespace === 'string') {
      const flat = mapping.namespacedToFlat.get(namespacedKey(item.namespace, item.name))
      if (!flat) throw new Error(`Responses history references an unavailable tool ${item.namespace}.${item.name}`)
      item.name = flat
      delete item.namespace
    } else if (direction === 'restore' && item.namespace === undefined) {
      const identity = mapping.flatToNamespaced.get(item.name)
      if (identity) {
        item.namespace = identity.namespace
        item.name = identity.name
      }
    }
  }
  for (const child of Object.values(item)) rewriteFunctionCalls(child, mapping, direction)
}

/** Convert Codex namespace tools into the standard flat Responses function surface. */
export function flattenResponsesTools(request: Record<string, unknown>): ResponsesToolMapping {
  const mapping: ResponsesToolMapping = { flatToNamespaced: new Map(), namespacedToFlat: new Map() }
  const tools = Array.isArray(request.tools) ? request.tools : []
  const used = new Set(tools.flatMap((value) => {
    const tool = record(value)
    return typeof tool?.name === 'string' && tool.type !== 'namespace' ? [tool.name] : []
  }))
  const flattened: unknown[] = []

  for (const value of tools) {
    const namespace = record(value)
    if (namespace?.type !== 'namespace') {
      flattened.push(value)
      continue
    }
    if (typeof namespace.name !== 'string' || !Array.isArray(namespace.tools)) {
      throw new Error('Responses namespace tool is missing its name or child tools')
    }
    for (const childValue of namespace.tools) {
      const child = record(childValue)
      if (child?.type !== 'function' || typeof child.name !== 'string') {
        throw new Error(`Responses namespace ${namespace.name} contains a non-function tool`)
      }
      const flat = flatToolName(namespace.name, child.name, used)
      const identity = { namespace: namespace.name, name: child.name }
      mapping.flatToNamespaced.set(flat, identity)
      mapping.namespacedToFlat.set(namespacedKey(identity.namespace, identity.name), flat)
      const namespaceDescription = typeof namespace.description === 'string' ? namespace.description.trim() : ''
      const childDescription = typeof child.description === 'string' ? child.description.trim() : ''
      flattened.push({
        type: 'function',
        name: flat,
        description: [namespaceDescription, childDescription].filter(Boolean).join('\n\n'),
        strict: child.strict === true,
        parameters: record(child.parameters) ?? { type: 'object', properties: {} },
      })
    }
  }

  request.tools = flattened
  rewriteFunctionCalls(request.input, mapping, 'flatten')
  return mapping
}

/** Restore flat provider calls so Codex can route them to the original MCP server. */
export function restoreResponsesToolCalls(value: unknown, mapping: ResponsesToolMapping): unknown {
  rewriteFunctionCalls(value, mapping, 'restore')
  return value
}

function upstreamResponsesUrl(baseUrl: string): URL {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/responses`
  url.hash = ''
  return url
}

async function readRequest(request: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_REQUEST_BYTES) throw new Error('Responses request exceeds 32 MiB')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function forwardedHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers()
  for (const [name, values] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || values === undefined) continue
    for (const value of Array.isArray(values) ? values : [values]) result.append(name, value)
  }
  result.set('content-type', 'application/json')
  return result
}

function copyResponseHeaders(source: Headers, target: import('node:http').ServerResponse): void {
  source.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) target.setHeader(name, value)
  })
}

function rewriteSseLine(line: string, mapping: ResponsesToolMapping): string {
  const match = /^(data:\s*)(.*)$/.exec(line)
  if (!match || match[2] === '[DONE]') return line
  try {
    const value = JSON.parse(match[2]!) as unknown
    return `${match[1]}${JSON.stringify(restoreResponsesToolCalls(value, mapping))}`
  } catch {
    return line
  }
}

async function writeResponse(
  response: import('node:http').ServerResponse,
  chunk: string,
): Promise<boolean> {
  if (response.destroyed || response.writableEnded) return false
  if (response.write(chunk)) return true
  return new Promise((resolve) => {
    const cleanup = () => {
      response.off('drain', onDrain)
      response.off('close', onClose)
      response.off('error', onClose)
    }
    const onDrain = () => {
      cleanup()
      resolve(true)
    }
    const onClose = () => {
      cleanup()
      resolve(false)
    }
    response.once('drain', onDrain)
    response.once('close', onClose)
    response.once('error', onClose)
  })
}

async function pipeSse(
  body: ReadableStream<Uint8Array>,
  response: import('node:http').ServerResponse,
  mapping: ResponsesToolMapping,
): Promise<void> {
  const decoder = new TextDecoder()
  let pending = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    if (response.destroyed || response.writableEnded) return
    pending += decoder.decode(chunk, { stream: true })
    let newline = pending.indexOf('\n')
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '')
      if (!await writeResponse(response, `${rewriteSseLine(line, mapping)}\n`)) return
      pending = pending.slice(newline + 1)
      newline = pending.indexOf('\n')
    }
  }
  pending += decoder.decode()
  if (pending) await writeResponse(response, rewriteSseLine(pending.replace(/\r$/, ''), mapping))
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

/**
 * Loopback-only transport bridge for Responses-compatible providers that
 * implement standard function tools but not Codex's namespace extension.
 */
export async function startResponsesToolBridge(upstreamBaseUrl: string): Promise<ResponsesToolBridge> {
  const upstreamUrl = upstreamResponsesUrl(upstreamBaseUrl)
  const server = createServer(async (request, response) => {
    const controller = new AbortController()
    const abortUpstream = () => controller.abort()
    request.once('aborted', abortUpstream)
    response.once('close', abortUpstream)
    try {
      if (request.method !== 'POST' || request.url !== '/responses') {
        response.writeHead(404).end()
        return
      }
      const body = JSON.parse((await readRequest(request)).toString('utf8')) as unknown
      const payload = record(body)
      if (!payload) throw new Error('Responses request body must be a JSON object')
      const mapping = flattenResponsesTools(payload)
      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: forwardedHeaders(request.headers),
        body: JSON.stringify(payload),
        redirect: 'manual',
        signal: controller.signal,
      })
      response.statusCode = upstream.status
      copyResponseHeaders(upstream.headers, response)
      if (!upstream.body) {
        response.end()
        return
      }
      if (upstream.headers.get('content-type')?.includes('text/event-stream')) {
        await pipeSse(upstream.body, response, mapping)
      } else {
        const text = await upstream.text()
        try {
          await writeResponse(response, JSON.stringify(restoreResponsesToolCalls(JSON.parse(text) as unknown, mapping)))
        } catch {
          await writeResponse(response, text)
        }
      }
      if (!response.destroyed && !response.writableEnded) response.end()
    } catch (error) {
      if (response.destroyed) return
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined)
        return
      }
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }))
    } finally {
      request.off('aborted', abortUpstream)
      response.off('close', abortUpstream)
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  let closed = false
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      if (closed) return
      closed = true
      await closeServer(server)
    },
  }
}
