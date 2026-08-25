import { spawnSync } from 'node:child_process'
import { access, readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

const removedScriptNames = [
  'import',
  'compile',
  'explore',
  'validate:locators',
  'classify',
  'repair',
  'report',
  'fixture',
  'demo:compile',
  'demo:test',
  'demo:report',
  'plan:workflow',
  'plan-recovery:workflow',
  'explore:workflow',
  'refine:workflow',
  'approve:workflow',
  'execute:workflow',
  'pipeline:workflow',
  'autonomous:workflow',
] as const

const historicalDocuments = new Set([
  'docs/architecture-journey-ir-runtime-to-codex-native.md',
  'docs/e2e-charge-acceptance.md',
  'docs/mvp-spec.md',
  'docs/repository-audit.md',
])

const legacyImportPattern = /from\s+['"](?:(?:\.\.?)\/)+(?:compiler\/playwright|exploration\/|repair\/|report\/|runtime\/|importer|ir\/|validation\/)(?:[^'"\n]+)?['"]/

async function expectMissing(relativePath: string): Promise<void> {
  await expect(access(resolve(root, relativePath))).rejects.toThrow()
}

async function relativeFiles(directory: string, suffix: string): Promise<string[]> {
  const entries = await readdir(resolve(root, directory), { recursive: true })
  return entries.filter((entry) => entry.endsWith(suffix)).map((entry) => `${directory}/${entry}`)
}

function removedScriptCommandPattern(name: string): RegExp {
  return new RegExp(`npm run ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_:-])`, 'g')
}

function runCliHelp(entry: string): string {
  const result = spawnSync(process.execPath, ['--import', 'tsx', resolve(root, 'src', 'cli', entry), '--help'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.toString()
}

describe('legacy IR to Playwright chain removal', () => {
  it('removes the compiler, exploration, repair, classification, importer, schema, integrated report, demo, and fixture files', async () => {
    const legacyPaths = [
      'src/compiler/playwright.ts',
      'src/importer.ts',
      'src/ir/parse.ts',
      'src/exploration/apply-candidate.ts',
      'src/exploration/cli-session.ts',
      'src/exploration/locator-parser.ts',
      'src/exploration/types.ts',
      'src/repair/classifier.ts',
      'src/repair/orchestrator.ts',
      'src/repair/planner.ts',
      'src/repair/types.ts',
      'src/validation/schema.ts',
      'src/validation/locator-validator.ts',
      'src/cli/import-xlsx.ts',
      'src/cli/compile-ir.ts',
      'src/cli/explore.ts',
      'src/cli/validate-locators.ts',
      'src/cli/classify-failures.ts',
      'src/cli/repair.ts',
      'src/cli/report.ts',
      'src/cli/plan-workflow.ts',
      'src/cli/plan-recovery-workflow.ts',
      'src/cli/explore-workflow.ts',
      'src/cli/refine-workflow.ts',
      'src/cli/approve-workflow.ts',
      'src/cli/execute-workflow.ts',
      'src/cli/workflow-pipeline.ts',
      'src/report/playwright-json.ts',
      'src/report/build.ts',
      'src/report/html.ts',
      'src/report/types.ts',
      'src/report/redact.ts',
      'src/runtime/data.ts',
      'src/runtime/locator.ts',
      'schemas/test-case-ir.schema.json',
      'schemas/workflow-captcha-response.schema.json',
      'schemas/workflow-locator-response.schema.json',
      'schemas/workflow-planner-response.schema.json',
      'examples/login-suite.ir.json',
      'examples/local-login-suite.ir.json',
      'playwright.demo.config.ts',
      'tests/fixtures/site/server.mjs',
      'tests/report.test.ts',
    ]
    for (const path of legacyPaths) await expectMissing(path)
  })

  it('removes the legacy npm commands while preserving replay compilation and workflow acceptance reporting', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    for (const name of removedScriptNames) {
      expect(manifest.scripts, name).not.toHaveProperty(name)
    }
    expect(manifest.scripts['compile:replay']).toBeDefined()
    expect(manifest.scripts['report:workflow']).toBeDefined()
  })

  it('stops re-exporting the removed modules from the public index', async () => {
    const source = await readFile(resolve(root, 'src/index.ts'), 'utf8')
    for (const specifier of [
      './compiler/playwright.js',
      './exploration/',
      './repair/',
      './report/',
      './runtime/',
      './validation/schema.js',
      './validation/locator-validator.js',
      './importer.js',
      './workflow/planner.js',
      './workflow/plan-exploration.js',
      './workflow/autonomy-state.js',
      './workflow/autonomy-types.js',
      './workflow/autonomous-controller.js',
      './workflow/failure-diagnosis.js',
      './workflow/policy-gate.js',
      './workflow/recovery-planner.js',
      './workflow/playwright-driver.js',
      './workflow/runtime-engine.js',
      './workflow/runtime-validation.js',
      './workflow/structured-model-cli.js',
      './workflow/table-entities.js',
      './workflow/auth-broker.js',
      './workflow/diagnostics.js',
      './agent/competition.js',
    ]) {
      expect(source, specifier).not.toContain(specifier)
    }
  })

  it('does not expose removed runtime commands or legacy parameters in CLI help', () => {
    const helpText = [
      runCliHelp('agent-test.ts'),
      runCliHelp('easy.ts'),
      runCliHelp('compile-mcp-replay.ts'),
    ].join('\n')

    expect(helpText).not.toContain('--legacy-runtime')
    for (const name of removedScriptNames) expect(helpText, name).not.toMatch(removedScriptCommandPattern(name))
  })

  it('keeps current main-chain source imports from reaching the removed report, compiler, or runtime modules', async () => {
    for (const file of await relativeFiles('src', '.ts')) {
      const source = await readFile(resolve(root, file), 'utf8')
      expect(source, file).not.toMatch(legacyImportPattern)
    }
  })

  it('keeps product documentation free of removed executable entry points while exempting historical documents', async () => {
    const files = [
      'README.md',
      'templates/README.md',
      ...(await relativeFiles('docs', '.md')),
    ]

    for (const file of files) {
      if (historicalDocuments.has(file)) continue
      const source = await readFile(resolve(root, file), 'utf8')
      expect(source, file).not.toContain('--legacy-runtime')
      for (const name of removedScriptNames) expect(source, file).not.toMatch(removedScriptCommandPattern(name))
    }
  })

  it('exports only the current AgentHost-native public surface', async () => {
    const source = await readFile(resolve(root, 'src/index.ts'), 'utf8')
    for (const specifier of [
      './core/types.js',
      './input/headers.js',
      './input/text.js',
      './workflow/intake.js',
      './workflow/input-bundle.js',
      './workflow/intake-secrets.js',
      './workflow/target-urls.js',
      './workflow/acceptance-report.js',
      './workflow/environment-profile.js',
      './workflow/model-profile.js',
      './workflow/types.js',
      './workflow/xlsx-media.js',
      './agent/host.js',
      './agent/host-registry.js',
      './agent/codex-host.js',
      './agent/codex-provider.js',
      './agent/omp-host.js',
      './agent/omp-provider.js',
      './agent/provider-runtime.js',
      './agent/runner.js',
      './agent/result.js',
      './agent/state.js',
      './agent/workspace.js',
      './agent/execution-receipts.js',
      './agent/evidence-artifact.js',
      './agent/result-workbook.js',
      './agent/replay-assets.js',
      './compiler/mcp-replay.js',
    ]) {
      expect(source, specifier).toContain(specifier)
    }
  })
})
