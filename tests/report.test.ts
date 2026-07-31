import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { compilePlaywrightSuite } from '../src/compiler/playwright.js'
import type { TestSuiteIR } from '../src/core/types.js'
import type { BoundedRepairReport } from '../src/repair/types.js'
import { buildIntegratedRunReport } from '../src/report/build.js'
import { renderIntegratedRunReportHtml } from '../src/report/html.js'
import { parsePlaywrightJsonReport } from '../src/report/playwright-json.js'

const fixturePath = resolve(import.meta.dirname, '../examples/local-login-suite.ir.json')
let suite: TestSuiteIR

beforeAll(async () => {
  suite = JSON.parse(await readFile(fixturePath, 'utf8')) as TestSuiteIR
})

function playwrightReport(status: 'passed' | 'failed' = 'passed') {
  return {
    suites: [{
      specs: [{
        title: 'local-login-001 正确账号密码登录成功',
        file: 'local-login.spec.ts',
        line: 22,
        tests: [{
          expectedStatus: 'passed',
          projectName: 'chromium',
          status: status === 'passed' ? 'expected' : 'unexpected',
          results: [{
            status,
            duration: 320,
            retry: 0,
            startTime: '2026-07-28T00:00:00.000Z',
            errors: status === 'failed' ? [{ message: 'received secret-report-value' }] : [],
            steps: [
              { title: '打开登录页面', duration: 20 },
              { title: '输入正确用户名', duration: 30 },
            ],
            attachments: [{ name: 'trace', contentType: 'application/zip', path: resolve('artifacts/trace.zip') }],
          }],
        }],
      }],
    }],
  }
}

describe('Playwright JSON parsing', () => {
  it('extracts case executions, steps and safe attachment paths', () => {
    const parsed = parsePlaywrightJsonReport(playwrightReport(), ['local-login-001'])

    expect(parsed[0]).toMatchObject({ caseId: 'local-login-001', file: 'local-login.spec.ts', line: 22 })
    expect(parsed[0]?.executions[0]).toMatchObject({
      projectName: 'chromium',
      status: 'passed',
      durationMs: 320,
      attachments: [{ name: 'trace', path: 'artifacts/trace.zip' }],
    })
    expect(parsed[0]?.executions[0]?.steps[0]).toEqual({ title: '打开登录页面', durationMs: 20 })
  })

  it('redacts runtime secret values from errors', () => {
    process.env.AUTO_TEST_SECRET_REPORT = 'secret-report-value'
    try {
      const parsed = parsePlaywrightJsonReport(playwrightReport('failed'), ['local-login-001'])
      expect(parsed[0]?.executions[0]?.errors[0]).toContain('[REDACTED]')
      expect(parsed[0]?.executions[0]?.errors[0]).not.toContain('secret-report-value')
    } finally {
      delete process.env.AUTO_TEST_SECRET_REPORT
    }
  })
})

describe('integrated run report', () => {
  it('links source rows, IR targets, generated lines and execution steps', () => {
    const compiled = compilePlaywrightSuite(suite)
    expect(compiled.sourceMap).not.toBeNull()
    const executions = parsePlaywrightJsonReport(playwrightReport(), ['local-login-001'])
    const report = buildIntegratedRunReport({ suite, sourceMap: compiled.sourceMap!, executions })

    expect(report.summary).toMatchObject({ total: 1, passed: 1, failed: 0 })
    expect(report.cases[0]).toMatchObject({
      caseId: 'local-login-001',
      sourceRow: 2,
      status: 'passed',
      code: { testLine: 22 },
    })
    expect(report.cases[0]?.steps[0]).toMatchObject({
      id: 'step-1',
      codeLine: 27,
      executionSteps: [{ title: '打开登录页面', durationMs: 20 }],
    })
    expect(report.cases[0]?.dataBindings).toEqual([
      { name: 'username', source: 'secret', secretRef: 'demo.username' },
      { name: 'password', source: 'secret', secretRef: 'demo.password' },
    ])
  })

  it('rejects a source map from another IR revision', () => {
    const compiled = compilePlaywrightSuite(suite)
    const changed = structuredClone(suite)
    changed.cases[0]!.title = 'changed title'

    expect(() => buildIntegratedRunReport({ suite: changed, sourceMap: compiled.sourceMap! })).toThrow(/does not match/i)
  })

  it('rejects a repaired report from another final IR revision', () => {
    const compiled = compilePlaywrightSuite(suite)
    const repair = {
      finalStatus: 'repaired',
      finalIrSha256: '0'.repeat(64),
    } as BoundedRepairReport

    expect(() => buildIntegratedRunReport({ suite, sourceMap: compiled.sourceMap!, repair })).toThrow(/final IR hash/i)
  })

  it('renders an escaped, filterable static HTML report', () => {
    const compiled = compilePlaywrightSuite(suite)
    const report = buildIntegratedRunReport({ suite, sourceMap: compiled.sourceMap! })
    const unsafe = structuredClone(report)
    unsafe.cases[0]!.title = '<script>alert(1)</script>'
    const html = renderIntegratedRunReportHtml(unsafe)

    expect(html).toContain('data-filter="failed"')
    expect(html).toContain('id="case-search"')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('renders repair before and after evidence', () => {
    const compiled = compilePlaywrightSuite(suite)
    const report = buildIntegratedRunReport({ suite, sourceMap: compiled.sourceMap! })
    report.cases[0]!.repairs = [{
      kind: 'locator',
      caseId: 'local-login-001',
      targetId: 'step-2',
      targetType: 'step',
      reason: 'stable candidate',
      before: { strategy: 'role', value: 'textbox', name: '旧用户名', source: 'playwrightCli' },
      after: { strategy: 'role', value: 'textbox', name: '用户名', source: 'playwrightCli' },
      candidateGeneratedAt: '2026-07-28T00:00:00.000Z',
    }]

    const html = renderIntegratedRunReportHtml(report)
    expect(html).toContain('Before')
    expect(html).toContain('After')
    expect(html).toContain('旧用户名')
    expect(html).toContain('stable candidate')
  })
})
