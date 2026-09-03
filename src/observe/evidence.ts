import { readFile, stat } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import type { ServerResponse } from 'node:http'

/** Content types the observation plane is allowed to serve. */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}
const TEXT_TYPES: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8',
}
const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024

export interface EvidenceServingResult {
  bytes: Buffer
  contentType: string
}

/**
 * Read one evidence file for the observation plane. The requested path must
 * resolve strictly inside the run's `agent-workspace/evidence` directory and
 * carry an extension the plane is allowed to serve. Anything else — a
 * traversal, an absolute path, `.agent-private`, the raw workbook copy, an
 * unknown extension, an oversized file — is refused.
 */
export async function readEvidenceFile(
  runDirectory: string,
  requestedPath: string,
): Promise<EvidenceServingResult | undefined> {
  const evidenceRoot = resolve(runDirectory, 'agent-workspace', 'evidence')
  // Result contracts record paths relative to agent-workspace, so accept a
  // leading `evidence/` prefix and normalize it away.
  const normalized = requestedPath.replace(/^evidence\//, '')
  const requested = resolve(evidenceRoot, normalized)
  const inside = relative(evidenceRoot, requested)
  if (inside === '' || inside.startsWith('..') || inside.includes('..') || requested.includes('.agent-private')) return undefined
  const extension = extname(requested).toLowerCase()
  const contentType = IMAGE_TYPES[extension] ?? TEXT_TYPES[extension]
  if (!contentType) return undefined
  let stats
  try {
    stats = await stat(requested)
  } catch {
    return undefined
  }
  if (!stats.isFile() || stats.size > MAX_EVIDENCE_BYTES) return undefined
  const bytes = await readFile(requested)
  return { bytes, contentType }
}

/** Stream one evidence file to the response with no-store caching. */
export async function serveEvidenceFile(
  response: ServerResponse,
  runDirectory: string,
  requestedPath: string,
): Promise<void> {
  const result = await readEvidenceFile(runDirectory, requestedPath)
  if (!result) {
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ error: '未找到' }))
    return
  }
  response.writeHead(200, { 'content-type': result.contentType, 'cache-control': 'no-store' })
  response.end(result.bytes)
}
