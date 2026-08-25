import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
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

function runEasy(...args: string[]): SpawnSyncReturns<string> {
  return runEasyFrom(root, ...args)
}

function runEasyFrom(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [tsxCli, easyCli, ...args], { cwd, encoding: 'utf8' })
}

describe('AgentHost-only easy CLI surface', () => {
  it('keeps --legacy-runtime out of easy help', () => {
    const result = runEasy('--help')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain('--legacy-runtime')
    expect(result.stdout).not.toContain('autonomous:workflow')
  })

  it('turns the removed --legacy-runtime flag into an unknown argument error', () => {
    const result = runEasy('run', '--legacy-runtime')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('未知参数：--legacy-runtime')
  })

  it('ignores legacy autonomous state files when finding the latest AgentHost state', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-status-'))
    temporaryDirectories.push(directory)
    const legacyDirectory = resolve(directory, 'artifacts', 'runs', 'legacy')
    const agentDirectory = resolve(directory, 'artifacts', 'runs', 'agent')
    await mkdir(legacyDirectory, { recursive: true })
    await mkdir(agentDirectory, { recursive: true })
    const legacyStatePath = resolve(legacyDirectory, 'autonomous-job.state.json')
    const agentStatePath = resolve(agentDirectory, 'codex-agent.state.json')
    await writeFile(legacyStatePath, JSON.stringify({
      version: '1.0', jobId: 'fixture-job', requestSha256: 'a'.repeat(64), status: 'failed', stage: 'failed',
      outcome: 'failed', round: 0, environmentRetries: 0, executionAttempts: 0, events: [],
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:01:00.000Z',
    }))
    await writeFile(agentStatePath, JSON.stringify({
      version: '2.0', status: 'running', stage: 'executing', workflowId: 'catalog', sourceSha256: 'b'.repeat(64),
      startedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:01:00.000Z', threadGeneration: 0, completedCaseIds: [],
    }))
    const future = new Date(Date.now() + 60_000)
    await utimes(legacyStatePath, future, future)

    const result = runEasyFrom(directory, 'status')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('测试仍在运行')
  })

  it('removes old workflow pipeline scripts from the package manifest', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }

    expect(manifest.scripts['pipeline:workflow']).toBeUndefined()
    expect(manifest.scripts['autonomous:workflow']).toBeUndefined()
    expect(manifest.scripts['easy']).toBe('tsx src/cli/easy.ts')
    expect(manifest.scripts['agent:test']).toBe('tsx src/cli/agent-test.ts')
  })
})
