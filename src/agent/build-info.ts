import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

export interface AgentBuildInfo {
  packageVersion?: string
  commit?: string
  platform: string
  arch: string
  nodeVersion: string
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  if (!await access(path).then(() => true, () => false)) return undefined
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

export async function readAgentBuildInfo(): Promise<AgentBuildInfo> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const metadata = await readJson(resolve(process.cwd(), 'Auto-Test.build.json')) ??
    await readJson(resolve(moduleDirectory, '../../../Auto-Test.build.json'))
  const packageJson = await readJson(resolve(moduleDirectory, '../../package.json')) ??
    await readJson(resolve(moduleDirectory, '../../../package.json')) ??
    await readJson(resolve(process.cwd(), 'package.json'))
  let commit = process.env.AUTO_TEST_BUILD_COMMIT ?? (typeof metadata?.commit === 'string' ? metadata.commit : undefined)
  if (!commit) {
    try {
      const result = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: process.cwd(), timeout: 2_000 })
      const value = result.stdout.trim()
      if (value) commit = value
    } catch {
      // Packaged Windows runs normally have no .git checkout; package metadata
      // remains sufficient for a precise acceptance record in that case.
    }
  }
  const packageVersion = process.env.AUTO_TEST_PACKAGE_VERSION ??
    (typeof metadata?.packageVersion === 'string' ? metadata.packageVersion : undefined) ??
    (typeof packageJson?.version === 'string' ? packageJson.version : undefined)
  return {
    ...(packageVersion ? { packageVersion } : {}),
    ...(commit ? { commit } : {}),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
  }
}
