import { createHash } from 'node:crypto'
import { access, chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { redactAgentArtifactText, redactAgentArtifactValue } from './redact.js'

const textArtifactExtensions = new Set(['.csv', '.json', '.jsonl', '.log', '.md', '.txt', '.yaml', '.yml'])

export interface AgentArtifactRedactionOptions {
  excludedDirectories?: string[]
  excludedFiles?: string[]
}

export interface AgentArtifactRedactionSummary {
  scannedFiles: number
  redactedFiles: number
}

export interface AgentEvidencePathSanitizationSummary {
  scannedArtifacts: number
  rewrittenArtifacts: number
  renamedFiles: number
}

interface DeliveryCaseWithEvidencePaths {
  evidencePaths?: unknown
}

interface DeliveryArtifactWithEvidencePaths {
  cases?: unknown
}

export async function redactAgentTextArtifacts(
  rootDirectory: string,
  secrets: string[],
  options: AgentArtifactRedactionOptions = {},
): Promise<AgentArtifactRedactionSummary> {
  const summary: AgentArtifactRedactionSummary = { scannedFiles: 0, redactedFiles: 0 }
  const excludedDirectories = new Set((options.excludedDirectories ?? []).map((path) => resolve(path)))
  const excludedFiles = new Set((options.excludedFiles ?? []).map((path) => resolve(path)))
  await redactDirectory(resolve(rootDirectory), secrets, summary, excludedDirectories, excludedFiles)
  return summary
}

export async function redactAgentTextArtifact(path: string, secrets: string[]): Promise<boolean> {
  const content = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (content === undefined || content.includes('\u0000')) return false
  const extension = extname(path).toLowerCase()
  const redacted = extension === '.json'
    ? redactJson(content, secrets)
    : extension === '.jsonl'
      ? redactJsonLines(content, secrets)
      : redactAgentArtifactText(content, secrets)
  if (redacted === content) return false
  await writeFile(path, redacted, 'utf8')
  if (process.platform !== 'win32') await chmod(path, 0o640)
  return true
}

/**
 * Keep evidence references usable after secret redaction. Agents occasionally
 * put a run value in a screenshot filename; redacting only the JSON reference
 * would otherwise leave it pointing at a file that no longer has that name.
 */
export async function sanitizeAgentDeliveryEvidencePaths(
  rootDirectory: string,
  secrets: string[],
): Promise<AgentEvidencePathSanitizationSummary> {
  const root = resolve(rootDirectory)
  const summary: AgentEvidencePathSanitizationSummary = { scannedArtifacts: 0, rewrittenArtifacts: 0, renamedFiles: 0 }
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const artifacts = entries
    .filter((entry) => entry.isFile() && /^case-results(?:\.epoch-[A-Za-z0-9._-]+)?\.json$/i.test(entry.name))
    .map((entry) => resolve(root, entry.name))
    .sort()
  if (artifacts.length === 0) return summary

  const workspaceFiles = await listWorkspaceFiles(root)
  const workspaceFileSet = new Set(workspaceFiles)
  const artifactSet = new Set(artifacts)
  const sanitizedCandidates = new Map<string, string[]>()
  for (const path of workspaceFiles) {
    if (artifactSet.has(path)) continue
    const reference = relative(root, path).split('\\').join('/')
    const sanitized = sanitizeEvidenceReference(reference, secrets)
    const existing = sanitizedCandidates.get(sanitized) ?? []
    existing.push(path)
    sanitizedCandidates.set(sanitized, existing)
  }
  const renamedReferences = new Map<string, string>()

  for (const artifactPath of artifacts) {
    summary.scannedArtifacts += 1
    const content = await readFile(artifactPath, 'utf8')
    let artifact: DeliveryArtifactWithEvidencePaths
    try {
      const parsed = JSON.parse(content) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      artifact = parsed as DeliveryArtifactWithEvidencePaths
    } catch {
      continue
    }
    if (!Array.isArray(artifact.cases)) continue
    let changed = false
    for (const item of artifact.cases) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const candidate = item as DeliveryCaseWithEvidencePaths
      if (!Array.isArray(candidate.evidencePaths)) continue
      const rewritten: unknown[] = []
      for (const value of candidate.evidencePaths) {
        if (typeof value !== 'string' || !isWorkspaceRelativeReference(value)) {
          rewritten.push(value)
          continue
        }
        const originalReference = value.split('\\').join('/')
        const prior = renamedReferences.get(originalReference)
        if (prior) {
          rewritten.push(prior)
          if (prior !== value) changed = true
          continue
        }
        let sourcePath = resolve(root, originalReference)
        if (!isWithin(root, sourcePath) || sourcePath === artifactPath) {
          rewritten.push(value)
          continue
        }
        const sourceExists = workspaceFileSet.has(sourcePath) && !artifactSet.has(sourcePath) && await fileExists(sourcePath)
        const sanitizedReference = sanitizeEvidenceReference(originalReference, secrets)
        if (!sourceExists) {
          const matches = sanitizedCandidates.get(sanitizedReference) ?? []
          if (matches.length !== 1) {
            rewritten.push(value)
            continue
          }
          sourcePath = matches[0]!
        }
        let destinationReference = sanitizeEvidenceReference(
          relative(root, sourcePath).split('\\').join('/'),
          secrets,
        )
        let destinationPath = resolve(root, destinationReference)
        if (!isWithin(root, destinationPath)) {
          rewritten.push(value)
          continue
        }
        if (sourcePath !== destinationPath && await fileExists(destinationPath)) {
          destinationReference = await availableStablePath(
            root,
            destinationReference,
            relative(root, sourcePath).split('\\').join('/'),
            sourcePath,
          )
          destinationPath = resolve(root, destinationReference)
        }
        if (sourcePath !== destinationPath) {
          await mkdir(dirname(destinationPath), { recursive: true, mode: 0o750 })
          await rename(sourcePath, destinationPath)
          summary.renamedFiles += 1
          workspaceFileSet.delete(sourcePath)
          workspaceFileSet.add(destinationPath)
          const sourceReference = relative(root, sourcePath).split('\\').join('/')
          const sourceKey = sanitizeEvidenceReference(sourceReference, secrets)
          const remaining = (sanitizedCandidates.get(sourceKey) ?? []).filter((path) => path !== sourcePath)
          sanitizedCandidates.set(sourceKey, [...remaining, destinationPath])
        }
        renamedReferences.set(originalReference, destinationReference)
        rewritten.push(destinationReference)
        if (destinationReference !== value) changed = true
      }
      candidate.evidencePaths = rewritten
    }
    if (!changed) continue
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
    if (process.platform !== 'win32') await chmod(artifactPath, 0o640)
    summary.rewrittenArtifacts += 1
  }
  return summary
}

function sanitizeEvidenceReference(value: string, secrets: string[]): string {
  return value
    .split(/[\\/]+/)
    .map((segment) => {
      const redacted = redactAgentArtifactText(segment, secrets)
        .replace(/<([^>]+)>/g, '$1')
        .replace(/[<>:"\\|?*\u0000-\u001f]/g, '-')
        .replace(/[ .]+$/g, '')
      return redacted && redacted !== '.' && redacted !== '..' ? redacted : 'artifact'
    })
    .join('/')
}

function withStablePathSuffix(path: string, identity: string): string {
  const extension = extname(path)
  const stem = extension ? path.slice(0, -extension.length) : path
  const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 8)
  return `${stem}-${suffix}${extension}`
}

async function availableStablePath(
  root: string,
  path: string,
  identity: string,
  sourcePath: string,
): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    const candidate = withStablePathSuffix(path, attempt === 0 ? identity : `${identity}:${attempt}`)
    const candidatePath = resolve(root, candidate)
    if (candidatePath === sourcePath || !await fileExists(candidatePath)) return candidate
  }
}

function isWorkspaceRelativeReference(value: string): boolean {
  if (!value.trim() || isAbsolute(value)) return false
  const normalized = value.replace(/\\/g, '/')
  return !normalized.split('/').some((segment) => segment === '..')
}

function isWithin(root: string, path: string): boolean {
  const value = relative(root, path)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
}

async function listWorkspaceFiles(directory: string): Promise<string[]> {
  const result: string[] = []
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const path = resolve(current, entry.name)
      const reference = relative(directory, path).split('\\').join('/')
      if (entry.isDirectory()) {
        if (reference === 'input' || reference.startsWith('input/')) continue
        await visit(path)
      } else if (entry.isFile()) {
        result.push(path)
      }
    }
  }
  await visit(directory)
  return result
}

function redactJson(content: string, secrets: string[]): string {
  try {
    const parsed = JSON.parse(content) as unknown
    const redacted = redactAgentArtifactValue(parsed, secrets)
    if (JSON.stringify(redacted) === JSON.stringify(parsed)) return content
    return `${JSON.stringify(redacted, null, 2)}\n`
  } catch {
    return redactAgentArtifactText(content, secrets)
  }
}

function redactJsonLines(content: string, secrets: string[]): string {
  try {
    const parts = content.split(/(\r\n|\n|\r)/)
    let changed = false
    for (let index = 0; index < parts.length; index += 2) {
      const line = parts[index] ?? ''
      if (line.length === 0) continue
      const parsed = JSON.parse(line) as unknown
      const redacted = redactAgentArtifactValue(parsed, secrets)
      if (JSON.stringify(redacted) !== JSON.stringify(parsed)) {
        parts[index] = JSON.stringify(redacted)
        changed = true
      }
    }
    return changed ? parts.join('') : content
  } catch {
    return redactAgentArtifactText(content, secrets)
  }
}

async function redactDirectory(
  directory: string,
  secrets: string[],
  summary: AgentArtifactRedactionSummary,
  excludedDirectories: Set<string>,
  excludedFiles: Set<string>,
): Promise<void> {
  if (excludedDirectories.has(directory)) return
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      await redactDirectory(path, secrets, summary, excludedDirectories, excludedFiles)
      continue
    }
    if (excludedFiles.has(path)) continue
    if (!entry.isFile() || !textArtifactExtensions.has(extname(entry.name).toLowerCase())) continue
    summary.scannedFiles += 1
    if (await redactAgentTextArtifact(path, secrets)) summary.redactedFiles += 1
  }
}
