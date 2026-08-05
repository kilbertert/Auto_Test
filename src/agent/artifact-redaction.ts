import { chmod, readFile, readdir, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { redactAgentArtifactText } from './redact.js'

const textArtifactExtensions = new Set(['.csv', '.json', '.jsonl', '.log', '.md', '.txt', '.yaml', '.yml'])

export interface AgentArtifactRedactionOptions {
  excludedDirectories?: string[]
}

export interface AgentArtifactRedactionSummary {
  scannedFiles: number
  redactedFiles: number
}

export async function redactAgentTextArtifacts(
  rootDirectory: string,
  secrets: string[],
  options: AgentArtifactRedactionOptions = {},
): Promise<AgentArtifactRedactionSummary> {
  const summary: AgentArtifactRedactionSummary = { scannedFiles: 0, redactedFiles: 0 }
  const excludedDirectories = new Set((options.excludedDirectories ?? []).map((path) => resolve(path)))
  await redactDirectory(resolve(rootDirectory), secrets, summary, excludedDirectories)
  return summary
}

export async function redactAgentTextArtifact(path: string, secrets: string[]): Promise<boolean> {
  const content = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (content === undefined || content.includes('\u0000')) return false
  const redacted = redactAgentArtifactText(content, secrets)
  if (redacted === content) return false
  await writeFile(path, redacted, 'utf8')
  if (process.platform !== 'win32') await chmod(path, 0o640)
  return true
}

async function redactDirectory(
  directory: string,
  secrets: string[],
  summary: AgentArtifactRedactionSummary,
  excludedDirectories: Set<string>,
): Promise<void> {
  if (excludedDirectories.has(directory)) return
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      await redactDirectory(path, secrets, summary, excludedDirectories)
      continue
    }
    if (!entry.isFile() || !textArtifactExtensions.has(extname(entry.name).toLowerCase())) continue
    summary.scannedFiles += 1
    if (await redactAgentTextArtifact(path, secrets)) summary.redactedFiles += 1
  }
}
