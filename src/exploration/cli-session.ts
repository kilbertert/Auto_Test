import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { LocatorInspection } from './types.js'

interface CliResponse {
  isError?: boolean
  error?: string
  result?: string
  snapshot?: string | { file: string }
  session?: string
  status?: string
}

function execute(executable: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(executable, args, { cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Playwright CLI failed: ${stderr.trim() || stdout.trim() || 'process exited unsuccessfully'}`))
        return
      }
      resolvePromise({ stdout, stderr })
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
    this.executable = resolve(repositoryRoot, 'node_modules/.bin/playwright')
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
