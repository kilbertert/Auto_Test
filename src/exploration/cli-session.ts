import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import spawn from 'cross-spawn'
import type { LocatorInspection } from './types.js'

interface CliResponse {
  isError?: boolean
  error?: string
  result?: string
  snapshot?: string | { file: string }
  session?: string
  status?: string
}

const MAX_CLI_OUTPUT_BYTES = 10 * 1024 * 1024

function execute(executable: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const childStdout = child.stdout
    const childStderr = child.stderr
    if (!childStdout || !childStderr) {
      child.kill()
      reject(new Error('Playwright CLI did not expose output streams'))
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(error)
    }
    const capture = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length
      if (outputBytes > MAX_CLI_OUTPUT_BYTES) {
        fail(new Error(`Playwright CLI output exceeded ${MAX_CLI_OUTPUT_BYTES} bytes`))
        return
      }
      target.push(chunk)
    }
    const timer = setTimeout(() => {
      fail(new Error('Playwright CLI timed out after 120000ms'))
    }, 120_000)
    childStdout.on('data', (chunk: Buffer) => capture(stdout, chunk))
    childStderr.on('data', (chunk: Buffer) => capture(stderr, chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      fail(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }
      if (code !== 0) {
        reject(new Error(`Playwright CLI failed: ${result.stderr.trim() || result.stdout.trim() || 'process exited unsuccessfully'}`))
        return
      }
      resolvePromise(result)
    })
  })
}

function resultJson<T>(response: CliResponse): T {
  if (response.isError) throw new Error(response.error ?? 'Playwright CLI returned an error')
  if (response.result === undefined) throw new Error('Playwright CLI returned no result')
  return JSON.parse(response.result) as T
}

function reportUrl(value: string): string {
  const url = new URL(value)
  return `${url.origin}${url.pathname}`
}

export class PlaywrightCliSession {
  private readonly executable: string

  constructor(
    readonly session: string,
    readonly workspaceDir: string,
    repositoryRoot = process.cwd(),
  ) {
    this.executable = resolve(repositoryRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright')
  }

  private async command(args: string[]): Promise<CliResponse> {
    await mkdir(this.workspaceDir, { recursive: true, mode: 0o750 })
    const { stdout } = await execute(this.executable, ['cli', `-s=${this.session}`, ...args, '--json'], this.workspaceDir)
    const response = JSON.parse(stdout) as CliResponse
    if (response.isError) throw new Error(response.error ?? 'Playwright CLI returned an error')
    return response
  }

  async open(url: string, headed: boolean): Promise<void> {
    await this.command(['open', url, ...(headed ? ['--headed'] : [])])
  }

  async snapshot(): Promise<string> {
    const response = await this.command(['snapshot'])
    if (typeof response.snapshot !== 'string') throw new Error('Playwright CLI returned no inline snapshot')
    return response.snapshot
  }

  async generateLocator(snapshotRef: string): Promise<string> {
    const response = await this.command(['generate-locator', snapshotRef])
    if (!response.result) throw new Error('Playwright CLI returned no locator')
    return response.result
  }

  async inspectLocator(expression: string): Promise<LocatorInspection> {
    const code = `async (page) => { const locator = ${expression}; const count = await locator.count(); let editable = null; if (count === 1) { try { editable = await locator.isEditable(); } catch { editable = false; } } return { count, visible: count === 1 ? await locator.isVisible() : null, enabled: count === 1 ? await locator.isEnabled() : null, editable, url: page.url() } }`
    const response = await this.command(['run-code', code])
    const inspection = resultJson<LocatorInspection>(response)
    return { ...inspection, url: reportUrl(inspection.url) }
  }

  async pageUrl(): Promise<string> {
    const response = await this.command(['run-code', 'async (page) => page.url()'])
    return resultJson<string>(response)
  }

  async reload(): Promise<void> {
    await this.command(['reload'])
  }

  async runAction(args: string[]): Promise<void> {
    await this.command(args)
  }

  async close(): Promise<void> {
    await this.command(['close'])
  }

  async removeWorkspace(): Promise<void> {
    await rm(this.workspaceDir, { recursive: true, force: true })
  }
}
