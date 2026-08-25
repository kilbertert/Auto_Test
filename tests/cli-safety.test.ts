import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const tsxCli = resolve(import.meta.dirname, '../node_modules/tsx/dist/cli.mjs')

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function runCli(script: string, args: string[], cwd: string) {
  return spawnSync(process.execPath, [tsxCli, script, ...args], { cwd, encoding: 'utf8' })
}

describe('CLI output safety', () => {
  it('derives a distinct source-map path for extensionless compile output', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-cli-compile-'))
    temporaryDirectories.push(directory)
    const input = resolve(directory, 'suite.json')
    const output = resolve(directory, 'compiled-suite')
    await copyFile(resolve(import.meta.dirname, '../examples/local-login-suite.ir.json'), input)

    const result = runCli(resolve(import.meta.dirname, '../src/cli/compile-ir.ts'), [
      '--ir', input,
      '--output', output,
    ], directory)

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(output, 'utf8')).toContain("import { expect, test }")
    expect(JSON.parse(await readFile(`${output}.map.json`, 'utf8'))).toMatchObject({ version: '1.0' })
  })

  it('rejects compile path collisions and missing option values', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-cli-collision-'))
    temporaryDirectories.push(directory)
    const input = resolve(directory, 'suite.json')
    const output = resolve(directory, 'suite.spec.ts')
    await copyFile(resolve(import.meta.dirname, '../examples/local-login-suite.ir.json'), input)

    const collision = runCli(resolve(import.meta.dirname, '../src/cli/compile-ir.ts'), [
      '--ir', input,
      '--output', output,
      '--map', output,
    ], directory)
    const missing = runCli(resolve(import.meta.dirname, '../src/cli/compile-ir.ts'), [
      '--ir', '--output', output,
    ], directory)

    expect(collision.status).toBe(1)
    expect(collision.stderr).toContain('不能使用同一路径')
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('--ir 必须提供取值')
  })
})
