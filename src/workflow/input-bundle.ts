import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp'])

export interface WorkflowInputBundle {
  sidecarDirectory: string
  briefPath?: string
  brief: string
  briefSha256: string
  imagePaths: string[]
  imageSha256s: string[]
}

async function filesIn(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile()).map((entry) => resolve(directory, entry.name)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

export async function discoverWorkflowInputBundle(options: {
  filePath: string
  briefPath?: string
  imagePaths?: string[]
}): Promise<WorkflowInputBundle> {
  const filePath = resolve(options.filePath)
  const stem = basename(filePath, extname(filePath))
  const sidecarDirectory = resolve(dirname(filePath), `${stem}.auto-test`)
  const discoveredBriefs = (await filesIn(sidecarDirectory)).filter((path) => ['brief.md', 'brief.txt'].includes(basename(path).toLowerCase()))
  if (!options.briefPath && discoveredBriefs.length > 1) throw new Error(`Workflow sidecar contains multiple brief files: ${sidecarDirectory}`)
  const briefPath = options.briefPath ? resolve(options.briefPath) : discoveredBriefs[0]
  const brief = briefPath ? await readFile(briefPath, 'utf8') : ''
  if (Buffer.byteLength(brief, 'utf8') > 256 * 1024) throw new Error('Workflow brief exceeds 256 KiB')

  const discoveredImages = (await filesIn(resolve(sidecarDirectory, 'images')))
    .filter((path) => imageExtensions.has(extname(path).toLowerCase()))
  const imagePaths = [...new Set([
    ...discoveredImages,
    ...(options.imagePaths ?? []).map((path) => resolve(path)),
  ])]
  return {
    sidecarDirectory,
    ...(briefPath ? { briefPath } : {}),
    brief,
    briefSha256: createHash('sha256').update(brief).digest('hex'),
    imagePaths,
    imageSha256s: await Promise.all(imagePaths.map(sha256)),
  }
}
