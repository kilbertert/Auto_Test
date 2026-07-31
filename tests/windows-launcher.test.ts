import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Windows portable launcher', () => {
  it('invokes npm and Playwright through the pinned portable Node runtime', async () => {
    const script = await readFile(resolve(import.meta.dirname, '../scripts/launch-windows.ps1'), 'utf8')

    expect(script).toContain("node_modules\\npm\\bin\\npm-cli.js")
    expect(script).toContain("node_modules\\@playwright\\test\\cli.js")
    expect(script).toContain("scripts\\check-playwright-browser.cjs")
    expect(script).toContain('& $script:NodeExecutable $playwrightCli install chromium')
    expect(script).toContain('if (Test-PlaywrightChromiumReady)')
    expect(script).not.toMatch(/&\s+npx\b/)
    expect(script).not.toMatch(/&\s+npm\b/)
  })
})
