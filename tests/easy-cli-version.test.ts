import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const tsxCli = resolve(root, 'node_modules/tsx/dist/cli.mjs')
const easyCli = resolve(root, 'src/cli/easy.ts')

function runEasy(...args: string[]): SpawnSyncReturns<string> {
  // The package version can be overridden by the packaging environment; pin the
  // test to what `package.json` declares so the assertion stays deterministic.
  const env = { ...process.env }
  delete env.AUTO_TEST_PACKAGE_VERSION
  return spawnSync(process.execPath, [tsxCli, easyCli, ...args], { cwd: root, env, encoding: 'utf8' })
}

describe('easy CLI --version', () => {
  it('prints the package version and exits 0 for --version', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { version: string }

    const result = runEasy('--version')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(manifest.version)
  })

  it('prints the same package version for -v', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { version: string }

    const result = runEasy('-v')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(manifest.version)
  })

  it('still rejects unknown commands after the version flag', () => {
    const result = runEasy('definitely-not-a-command')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('未知命令：definitely-not-a-command')
  })
})
