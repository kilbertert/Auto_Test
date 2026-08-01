import { stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

const evidenceExtensions = new Set(['.gif', '.jpeg', '.jpg', '.jsonl', '.log', '.md', '.png', '.txt', '.webp', '.yaml', '.yml'])

function inside(root: string, path: string): boolean {
  const local = relative(root, path)
  return Boolean(local) && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
}

export async function resolveEvidenceArtifact(evidenceDirectory: string, path?: string): Promise<string | undefined> {
  if (!path) return undefined
  const workspaceDirectory = resolve(evidenceDirectory, '..')
  const candidates = isAbsolute(path)
    ? [resolve(path)]
    : [resolve(workspaceDirectory, path), resolve(evidenceDirectory, path)]
  for (const candidate of [...new Set(candidates)]) {
    if (!inside(workspaceDirectory, candidate)) continue
    if (!evidenceExtensions.has(extname(candidate).toLowerCase())) continue
    const details = await stat(candidate).catch(() => undefined)
    if (!details?.isFile()) continue
    return relative(workspaceDirectory, candidate).split(sep).join('/')
  }
  throw new Error('Evidence artifact must be a supported evidence file inside the configured agent workspace')
}
