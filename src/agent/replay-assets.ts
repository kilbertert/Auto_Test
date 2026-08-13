import { spawn } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { slugify } from '../input/text.js'
import type { WorkflowIntakeManifest } from '../workflow/types.js'
import { compileMcpReplay, readJsonLines, type ReplayDiagnostic } from '../compiler/mcp-replay.js'
import { packageFilePath } from './runtime-paths.js'
import { writePrivateJson } from './state.js'
import type { CodexTestAgentResult } from './types.js'

export interface ReplayAssetEntry {
  caseId: string
  status: 'candidate' | 'verified' | 'verification_failed' | 'not_replayable'
  specPath?: string
  configPath?: string
  diagnostics: ReplayDiagnostic[]
  verification?: { exitCode: number; output: string }
}

export interface ReplayAssetManifest {
  version: '1.0'
  kind: 'playwright-replay-assets'
  workflowId: string
  sourceSha256: string
  generatedAt: string
  cases: ReplayAssetEntry[]
}

export async function generateReplayAssets(options: {
  outputDirectory: string
  eventsPath: string
  result: CodexTestAgentResult
  manifest: WorkflowIntakeManifest
  storageStatePath: string
  initPagePath: string
  secretsPath: string
  verifyReadOnly?: boolean
}): Promise<ReplayAssetManifest> {
  const directory = resolve(options.outputDirectory, 'agent-workspace', 'replay')
  const playwrightTestPath = packageFilePath('@playwright/test', 'index.js')
  await mkdir(directory, { recursive: true, mode: 0o750 })
  await writeFile(resolve(directory, 'package.json'), '{"type":"module"}\n', { encoding: 'utf8', mode: 0o640 })
  const events = await readJsonLines(options.eventsPath)
  const cases: ReplayAssetEntry[] = []
  for (const item of options.result.cases) {
    if (item.outcome !== 'passed') continue
    const compiled = compileMcpReplay(events, new Set([item.caseId]))
    if (!compiled.source) {
      cases.push({ caseId: item.caseId, status: 'not_replayable', diagnostics: compiled.diagnostics })
      continue
    }
    const stem = slugify(item.caseId) || 'case'
    const specPath = resolve(directory, `${stem}.spec.ts`)
    const configPath = resolve(directory, `${stem}.config.ts`)
    const source = compiled.source.replace(
      "import { test, expect } from '@playwright/test'",
      `import playwrightTest from ${JSON.stringify(playwrightTestPath)}\nconst { test, expect } = playwrightTest\nimport { createRequire } from 'node:module'\nconst initPageModule = createRequire(import.meta.url)(${JSON.stringify(options.initPagePath)})\nconst initPage = initPageModule.default ?? initPageModule`,
    ).replace('\n\ntest(', '\n\ntest.beforeEach(async ({ page }) => initPage({ page }))\n\ntest(')
    await writeFile(specPath, source, { encoding: 'utf8', mode: 0o640 })
    await writeFile(configPath, [
      `import playwrightTest from ${JSON.stringify(playwrightTestPath)}`,
      'const { defineConfig } = playwrightTest',
      "import { readFileSync } from 'node:fs'",
      '',
      `for (const line of readFileSync(${JSON.stringify(options.secretsPath)}, 'utf8').split(/\\r?\\n/)) {`,
      "  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)",
      "  if (match) process.env[match[1]!] = JSON.parse(match[2]!) as string",
      '}',
      '',
      'export default defineConfig({',
      "  testDir: '.',",
      `  testMatch: ${JSON.stringify(basename(specPath))},`,
      '  workers: 1,',
      `  use: { browserName: 'chromium', storageState: ${JSON.stringify(options.storageStatePath)} },`,
      '})',
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o640 })
    if (process.platform !== 'win32') await Promise.all([chmod(specPath, 0o640), chmod(configPath, 0o640)])
    const risk = options.manifest.phases.find((phase) => phase.id === item.caseId)?.risk
    const verification = options.verifyReadOnly && risk === 'read'
      ? await runPlaywright(configPath, options.outputDirectory)
      : undefined
    cases.push({
      caseId: item.caseId,
      status: verification ? (verification.exitCode === 0 ? 'verified' : 'verification_failed') : 'candidate',
      specPath, configPath, diagnostics: compiled.diagnostics, ...(verification ? { verification } : {}),
    })
  }
  const replayManifest: ReplayAssetManifest = {
    version: '1.0', kind: 'playwright-replay-assets', workflowId: options.result.workflowId,
    sourceSha256: options.result.sourceSha256, generatedAt: new Date().toISOString(), cases,
  }
  await writePrivateJson(resolve(directory, 'replay-manifest.json'), replayManifest)
  return replayManifest
}

async function runPlaywright(configPath: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  return await new Promise((resolveResult) => {
    const child = spawn(process.execPath, [packageFilePath('@playwright/test', 'cli.js'), 'test', '--config', configPath, '--reporter=line'], {
      cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const append = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-16_384) }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', (error) => resolveResult({ exitCode: 1, output: error.message }))
    child.once('close', (code) => resolveResult({ exitCode: code ?? 1, output }))
  })
}
