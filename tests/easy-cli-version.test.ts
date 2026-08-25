import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const tsxCli = resolve(root, 'node_modules/tsx/dist/cli.mjs')
const easyCli = resolve(root, 'src/cli/easy.ts')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/**
 * The packaging environment can override the resolved version; strip it so each
 * test only sees the version sources it arranges itself.
 */
function envWithoutVersionOverride(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.AUTO_TEST_PACKAGE_VERSION
  return env
}

function runEasy(...args: string[]): SpawnSyncReturns<string> {
  return runEasyIn({}, ...args)
}

function runEasyIn(
  { cwd = root, env = envWithoutVersionOverride() }: { cwd?: string; env?: NodeJS.ProcessEnv },
  ...args: string[]
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [tsxCli, easyCli, ...args], { cwd, env, encoding: 'utf8' })
}

describe('easy CLI --version', () => {
  it.each(['--version', '-v'])('prints the package version and exits 0 for %s', async (flag) => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { version: string }

    const result = runEasy(flag)

    expect(result.status, `${flag}: ${result.stderr}`).toBe(0)
    expect(result.stdout.trim(), `${flag} stdout`).toBe(manifest.version)
  })

  it('prefers the packaging override and Auto-Test.build.json over package.json', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-version-'))
    temporaryDirectories.push(directory)
    await writeFile(resolve(directory, 'Auto-Test.build.json'), JSON.stringify({
      packageVersion: '9.8.7-fixture-build',
      commit: 'fixture000',
    }))

    // Build metadata found in the working directory outranks the source package.json.
    const fromMetadata = runEasyIn({ cwd: directory }, '--version')
    expect(fromMetadata.status, fromMetadata.stderr).toBe(0)
    expect(fromMetadata.stdout.trim()).toBe('9.8.7-fixture-build')

    // The packaging environment override outranks the build metadata.
    const fromOverride = runEasyIn(
      { cwd: directory, env: { ...envWithoutVersionOverride(), AUTO_TEST_PACKAGE_VERSION: '9.9.9-fixture-override' } },
      '--version',
    )
    expect(fromOverride.status, fromOverride.stderr).toBe(0)
    expect(fromOverride.stdout.trim()).toBe('9.9.9-fixture-override')
  })

  it('still rejects unknown commands', () => {
    const result = runEasy('definitely-not-a-command')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('未知命令：definitely-not-a-command')
  })
})
