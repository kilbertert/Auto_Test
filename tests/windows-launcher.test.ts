import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Windows portable launcher', () => {
  it('invokes npm and Playwright through the pinned portable Node runtime', async () => {
    const script = await readFile(resolve(import.meta.dirname, '../scripts/launch-windows.ps1'), 'utf8')
    const browserCheck = await readFile(resolve(import.meta.dirname, '../scripts/check-playwright-browser.cjs'), 'utf8')
    const privatePackageBuilder = await readFile(resolve(import.meta.dirname, '../scripts/build-private-windows-package.sh'), 'utf8')

    expect(script).toContain("node_modules\\npm\\bin\\npm-cli.js")
    expect(script).toContain("node_modules\\@playwright\\test\\cli.js")
    expect(script).toContain('x86_64-pc-windows-msvc')
    expect(script).toContain('codex.exe')
    expect(script).toContain('$env:AUTO_TEST_CODEX_BIN = $codexExecutable')
    expect(script).toContain('AUTO_TEST_CODEX_PROBE_BIN')
    expect(script).toContain("scripts\\check-playwright-browser.cjs")
    expect(script).toContain('& $script:NodeExecutable $playwrightCli install chromium')
    expect(script).toContain('if (Test-PlaywrightChromiumReady)')
    expect(script).not.toMatch(/&\s+npx\b/)
    expect(script).not.toMatch(/&\s+npm\b/)
    expect(browserCheck).toContain("chromium.launch({ headless: true })")
    expect(browserCheck).toContain('AUTO_TEST_CHROMIUM_READY')
    expect(script).toContain('Auto-Test.private-provider.json')
    expect(script).toContain('$baseUrl = $env:AUTO_TEST_CODEX_BASE_URL')
    expect(script).toContain('$model = $env:AUTO_TEST_CODEX_MODEL')
    expect(script).toContain("$auth.OPENAI_API_KEY")
    expect(script).toContain('Get-CodexCliBaseUrl')
    expect(script).toContain('https://api.openai.com/v1')
    expect(script).toContain('Set-ProviderBaseUrl $script:CodexCliBackupBaseUrl')
    expect(script).toContain('主 API Key 额度不足，正在尝试 Codex CLI 备用 Key')
    expect(script).toContain('Persist-ProviderSecret $candidate')
    expect(script).toContain("$hint -notmatch '额度不足或请求频率受限'")
    expect(privatePackageBuilder).toContain('AUTO_TEST_CODEX_BASE_URL')
    expect(privatePackageBuilder).toContain('AUTO_TEST_CODEX_MODEL')
    expect(privatePackageBuilder).toContain('Auto-Test.private-provider.json')
  })
})
