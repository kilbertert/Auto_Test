import { describe, expect, it } from 'vitest'
import { applyLocatorCandidate } from '../src/exploration/apply-candidate.js'
import { parsePlaywrightLocator } from '../src/exploration/locator-parser.js'
import type { LocatorCandidateReport } from '../src/exploration/types.js'
import type { TestSuiteIR } from '../src/core/types.js'
import { resolveDataBindings, secretEnvironmentName } from '../src/runtime/data.js'
import { workflowSecretEnvironment } from '../src/workflow/intake-secrets.js'
import { locatorExpression } from '../src/runtime/locator.js'

describe('Playwright CLI locator parsing', () => {
  it('parses role locators into structured IR', () => {
    const locator = parsePlaywrightLocator("getByRole('button', { name: '登录', exact: true })")

    expect(locator).toEqual({
      strategy: 'role',
      value: 'button',
      name: '登录',
      exact: true,
      source: 'playwrightCli',
    })
    expect(locatorExpression(locator)).toBe('page.getByRole("button", { name: "登录", exact: true })')
  })

  it('parses test ID, CSS and XPath locators', () => {
    expect(parsePlaywrightLocator("page.getByTestId('current-user')")).toMatchObject({
      strategy: 'testId',
      value: 'current-user',
    })
    expect(parsePlaywrightLocator("locator('form > button')")).toMatchObject({
      strategy: 'css',
      value: 'form > button',
    })
    expect(parsePlaywrightLocator("locator('xpath=//button[@type=\"submit\"]')")).toMatchObject({
      strategy: 'xpath',
      value: '//button[@type="submit"]',
    })
  })

  it('rejects position-based locator chains', () => {
    expect(() => parsePlaywrightLocator("getByRole('button').nth(0)")).toThrow(/unsupported/i)
  })

  it('rejects chained locators that would lose their parent scope', () => {
    expect(() => parsePlaywrightLocator("page.getByRole('dialog').getByText('确定')")).toThrow(/unsupported/i)
  })

  it('rejects trailing statements', () => {
    expect(() => parsePlaywrightLocator("getByRole('button'); doSomething()"))
      .toThrow(/trailing statements/i)
  })
})

describe('runtime data resolution', () => {
  it('maps secret references to environment variables without changing their values', () => {
    expect(secretEnvironmentName('admin.username')).toBe('AUTO_TEST_SECRET_ADMIN_USERNAME')
    expect(resolveDataBindings(
      [{ name: 'username', source: 'secret', secretRef: 'admin.username' }],
      { AUTO_TEST_SECRET_ADMIN_USERNAME: 'synthetic-user' },
    )).toEqual({ username: 'synthetic-user' })
  })

  it('fails closed when a required secret is absent', () => {
    expect(() => resolveDataBindings(
      [{ name: 'password', source: 'secret', secretRef: 'admin.password' }],
      {},
    )).toThrow('AUTO_TEST_SECRET_ADMIN_PASSWORD')
  })

  it('rejects empty secret references', () => {
    expect(() => secretEnvironmentName('')).toThrow(/must not be empty/i)
  })

  it('rejects secret references that normalize to the same environment variable', () => {
    expect(() => workflowSecretEnvironment({
      'fixture.a-b': 'first',
      'fixture.a_b': 'second',
    }, {})).toThrow(/collide/i)
  })
})

describe('candidate application', () => {
  it('changes only the selected locator and drops no assertion semantics', () => {
    const suite = {
      version: '1.0',
      suiteId: 'suite',
      source: { format: 'xlsx', fileName: 'cases.xlsx', sha256: '0'.repeat(64) },
      target: { baseUrl: 'https://example.test/', allowedOrigins: ['https://example.test/'] },
      policy: {
        caseTimeoutMs: 60_000,
        retries: 0,
        repair: { maxAttempts: 0, allowedChanges: ['locator'], assertionMutation: 'forbidden' },
        destructiveActions: 'blocked',
      },
      cases: [{
        id: 'case-1',
        title: 'login',
        priority: 'P0',
        risk: 'read',
        steps: [{ id: 'step-1', action: 'click', targetDescription: '登录', sourceText: '点击登录', confidence: 1 }],
        assertions: [{
          id: 'assert-1',
          kind: 'url',
          operator: 'contains',
          expected: '/dashboard',
          sourceText: '进入首页',
          oracleSource: 'tester',
          immutable: true,
          confidence: 1,
        }],
        review: { status: 'approved', ambiguities: [], confidence: 1 },
      }],
    } satisfies TestSuiteIR
    const report = {
      version: '1.0',
      generatedAt: new Date(0).toISOString(),
      suiteId: 'suite',
      caseId: 'case-1',
      targetId: 'step-1',
      targetType: 'step',
      sourceText: '点击登录',
      snapshotRef: 'e9',
      generatedExpression: "getByRole('button', { name: '登录' })",
      locator: { strategy: 'role', value: 'button', name: '登录', source: 'playwrightCli' },
      current: { count: 1, visible: true, enabled: true, editable: false, url: 'https://example.test/' },
      afterReload: { count: 1, visible: true, enabled: true, editable: false, url: 'https://example.test/' },
      stableAfterReload: true,
      diagnostics: [],
    } satisfies LocatorCandidateReport

    const updated = applyLocatorCandidate(suite, report)

    expect(updated.cases[0]!.steps[0]!.locator).toEqual(report.locator)
    expect(updated.cases[0]!.assertions[0]!.expected).toBe('/dashboard')
    expect(updated.cases[0]!.review.status).toBe('approved')
    expect(JSON.stringify(updated)).not.toContain('e9')
  })

  it('rejects unstable candidates', () => {
    const suite = {
      version: '1.0',
      suiteId: 'suite',
      source: { format: 'xlsx', fileName: 'cases.xlsx', sha256: '0'.repeat(64) },
      target: { baseUrl: 'https://example.test/', allowedOrigins: ['https://example.test/'] },
      policy: {
        caseTimeoutMs: 60_000,
        retries: 0,
        repair: { maxAttempts: 0, allowedChanges: ['locator'], assertionMutation: 'forbidden' },
        destructiveActions: 'blocked',
      },
      cases: [{
        id: 'case-1',
        title: 'login',
        priority: 'P0',
        risk: 'read',
        steps: [{ id: 'step-1', action: 'click', targetDescription: '登录', sourceText: '点击登录', confidence: 1 }],
        assertions: [{ id: 'assert-1', kind: 'url', operator: 'contains', expected: '/', sourceText: '首页', oracleSource: 'tester', immutable: true, confidence: 1 }],
        review: { status: 'approved', ambiguities: [], confidence: 1 },
      }],
    } satisfies TestSuiteIR
    const report = {
      version: '1.0',
      generatedAt: new Date(0).toISOString(),
      suiteId: 'suite',
      caseId: 'case-1',
      targetId: 'step-1',
      targetType: 'step',
      sourceText: '点击登录',
      snapshotRef: 'e9',
      generatedExpression: "getByRole('button')",
      locator: { strategy: 'role', value: 'button', source: 'playwrightCli' },
      current: { count: 2, visible: null, enabled: null, editable: null, url: 'https://example.test/' },
      afterReload: { count: 2, visible: null, enabled: null, editable: null, url: 'https://example.test/' },
      stableAfterReload: false,
      diagnostics: [{ severity: 'error', code: 'not_unique', message: 'not unique' }],
    } satisfies LocatorCandidateReport

    expect(() => applyLocatorCandidate(suite, report)).toThrow(/unstable/i)
  })
})
