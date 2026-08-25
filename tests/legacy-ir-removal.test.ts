import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

async function expectMissing(relativePath: string): Promise<void> {
  await expect(access(resolve(root, relativePath))).rejects.toThrow()
}

describe('legacy IR to Playwright chain removal', () => {
  it('removes the compiler, exploration, repair, classification, importer, schema, integrated report, demo, and fixture files', async () => {
    const legacyPaths = [
      'src/compiler/playwright.ts',
      'src/importer.ts',
      'src/ir/parse.ts',
      'src/exploration/apply-candidate.ts',
      'src/repair/classifier.ts',
      'src/validation/schema.ts',
      'src/validation/locator-validator.ts',
      'src/cli/import-xlsx.ts',
      'src/cli/compile-ir.ts',
      'src/cli/explore.ts',
      'src/cli/validate-locators.ts',
      'src/cli/classify-failures.ts',
      'src/cli/repair.ts',
      'src/cli/report.ts',
      'src/report/playwright-json.ts',
      'src/report/build.ts',
      'src/report/html.ts',
      'src/report/types.ts',
      'src/report/redact.ts',
      'schemas/test-case-ir.schema.json',
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
    for (const name of ['import', 'compile', 'explore', 'validate:locators', 'classify', 'repair', 'report', 'fixture', 'demo:compile', 'demo:test', 'demo:report']) {
      expect(manifest.scripts, name).not.toHaveProperty(name)
    }
    expect(manifest.scripts['compile:replay']).toBeDefined()
    expect(manifest.scripts['report:workflow']).toBeDefined()
  })

  it('stops re-exporting the removed modules from the public index', async () => {
    const source = await readFile(resolve(root, 'src/index.ts'), 'utf8')
    for (const specifier of ['./compiler/playwright.js', './exploration/', './repair/', './validation/schema.js', './validation/locator-validator.js', './importer.js']) {
      expect(source, specifier).not.toContain(specifier)
    }
  })
})
