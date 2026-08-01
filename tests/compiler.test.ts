import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { compilePlaywrightSuite } from '../src/compiler/playwright.js'
import type { TestSuiteIR } from '../src/core/types.js'

const fixturePath = resolve(import.meta.dirname, '../examples/local-login-suite.ir.json')
const tsxLoader = pathToFileURL(resolve(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs')).href
let approvedSuite: TestSuiteIR

function cloneSuite(): TestSuiteIR {
  return structuredClone(approvedSuite)
}

function diagnosticCodes(result: ReturnType<typeof compilePlaywrightSuite>): string[] {
  return result.diagnostics.items.map((item) => item.code)
}

beforeAll(async () => {
  approvedSuite = JSON.parse(await readFile(fixturePath, 'utf8')) as TestSuiteIR
})

describe('Playwright compiler', () => {
  it('compiles an approved suite without embedding secret values', () => {
    const result = compilePlaywrightSuite(cloneSuite())

    expect(result.diagnostics.hasErrors).toBe(false)
    expect(result.fileName).toBe('local-login-approved.spec.ts')
    expect(result.source).toContain('AUTO_TEST_SECRET_DEMO_USERNAME')
    expect(result.source).toContain('AUTO_TEST_SECRET_DEMO_PASSWORD')
    expect(result.source).not.toContain('demo.username')
    expect(result.source).not.toContain('demo.password')
    expect(result.source).toContain('test.describe.configure({ retries: 1 })')
    expect(result.source).toContain('test.setTimeout(60000)')
    expect(result.source).toContain('assertAllowedOrigin(page.url())')
    expect(result.source.indexOf('assertAllowedOrigin(String(')).toBeLessThan(result.source.indexOf('await page.goto(String('))
    expect(result.sourceMap).toMatchObject({
      version: '1.0',
      suiteId: 'local-login-approved',
      source: { fileName: 'test-cases.xlsx', sheetName: '测试用例' },
    })
    expect(result.sourceMap?.cases[0]).toMatchObject({
      caseId: 'local-login-001',
      sourceRow: 2,
      testLine: expect.any(Number),
    })
    expect(result.sourceMap?.cases[0]?.steps.map((step) => step.id)).toEqual(['step-1', 'step-2', 'step-3', 'step-4'])
    expect(result.sourceMap?.cases[0]?.assertions.map((assertion) => assertion.id)).toEqual(['assert-1', 'assert-2'])
    for (const target of [
      ...(result.sourceMap?.cases[0]?.steps ?? []),
      ...(result.sourceMap?.cases[0]?.assertions ?? []),
    ]) {
      expect(result.source.split('\n')[target.line - 1]).toContain('test.step')
    }
  })

  it('rejects draft cases before generating source', () => {
    const suite = cloneSuite()
    suite.cases[0]!.review.status = 'draft'

    const result = compilePlaywrightSuite(suite)

    expect(result.source).toBe('')
    expect(diagnosticCodes(result)).toContain('case_not_approved')
  })

  it('rejects missing locators and unresolved secrets', () => {
    const suite = cloneSuite()
    delete suite.cases[0]!.steps[1]!.locator
    suite.cases[0]!.dataBindings![0]!.secretRef = 'unresolved.username'

    const result = compilePlaywrightSuite(suite)
    const codes = diagnosticCodes(result)

    expect(result.source).toBe('')
    expect(codes).toContain('step_locator_missing')
    expect(codes).toContain('unresolved_secret')
  })

  it('rejects references to missing data bindings', () => {
    const suite = cloneSuite()
    suite.cases[0]!.steps[1]!.valueRef = 'missing_username'

    const result = compilePlaywrightSuite(suite)

    expect(diagnosticCodes(result)).toContain('step_value_ref_missing')
  })

  it('rejects assertion operator and expected-value mismatches', () => {
    const suite = cloneSuite()
    suite.cases[0]!.assertions[1]!.operator = 'gt'
    suite.cases[0]!.assertions[1]!.expected = 1

    const result = compilePlaywrightSuite(suite)
    const codes = diagnosticCodes(result)

    expect(codes).toContain('assertion_operator_invalid')
    expect(codes).toContain('assertion_expected_type')
  })

  it('returns schema diagnostics for malformed input instead of throwing', () => {
    const result = compilePlaywrightSuite({ suiteId: 'broken' })

    expect(result.fileName).toBe('invalid-suite.spec.ts')
    expect(result.source).toBe('')
    expect(result.sourceMap).toBeNull()
    expect(diagnosticCodes(result)).toContain('schema_validation')
  })

  it('requires expected text for URL and response wait conditions', () => {
    const suite = cloneSuite()
    suite.cases[0]!.steps[0]!.waitFor = { kind: 'url' }

    const result = compilePlaywrightSuite(suite)

    expect(result.source).toBe('')
    expect(diagnosticCodes(result)).toContain('schema_validation')
  })

  it('loads the IR schema independently of the caller working directory', () => {
    const moduleUrl = pathToFileURL(resolve(import.meta.dirname, '../src/validation/schema.ts')).href
    const result = spawnSync(process.execPath, [
      '--import', tsxLoader, '--input-type=module', '--eval',
      `const { validateSuite } = await import(${JSON.stringify(moduleUrl)}); console.log(validateSuite({}).valid)`,
    ], { cwd: tmpdir(), encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('false')
  })
})
