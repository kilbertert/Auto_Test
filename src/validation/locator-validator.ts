import { chromium, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import type {
  AssertionIR,
  Diagnostic,
  StepIR,
  TestCaseIR,
  TestSuiteIR,
  WaitConditionIR,
} from '../core/types.js'
import { compilePlaywrightSuite } from '../compiler/playwright.js'
import { redactSensitiveText } from '../input/text.js'
import { resolveDataBindings, type RuntimeValue } from '../runtime/data.js'
import { createLocator, locatorExpression } from '../runtime/locator.js'

export type ValidationTargetType = 'step' | 'assertion' | 'cleanup'
export type RuntimeFailureKind =
  | 'locator_not_found'
  | 'locator_ambiguous'
  | 'locator_not_visible'
  | 'locator_not_enabled'
  | 'locator_not_editable'
  | 'action_timeout'
  | 'action_error'
  | 'wait_timeout'
  | 'assertion_mismatch'
  | 'navigation_error'
  | 'origin_violation'
  | 'missing_data'
  | 'environment_error'
  | 'unknown'

export interface RuntimeFailureEvidence {
  kind: RuntimeFailureKind
  phase: 'setup' | ValidationTargetType
  message: string
  targetId?: string
  sourceText?: string
}

export interface LocatorCheckResult {
  replay: number
  targetId: string
  targetType: ValidationTargetType
  sourceText: string
  expression: string
  url: string
  count: number
  visible: boolean | null
  enabled: boolean | null
  editable: boolean | null
  passed: boolean
  message?: string
}

export interface ReplayValidationResult {
  replay: number
  status: 'passed' | 'failed'
  durationMs: number
  checks: LocatorCheckResult[]
  error?: string
  failure?: RuntimeFailureEvidence
}

export interface CaseLocatorValidationResult {
  caseId: string
  title: string
  status: 'passed' | 'failed' | 'blocked'
  stableAcrossReplays: boolean
  replays: ReplayValidationResult[]
  blockedReason?: string
}

export interface LocatorValidationReport {
  version: '1.0'
  generatedAt: string
  suiteId: string
  requestedReplays: number
  cases: CaseLocatorValidationResult[]
  summary: {
    total: number
    passed: number
    failed: number
    blocked: number
    locatorChecks: number
  }
}

export interface LocatorValidationOptions {
  caseIds?: string[]
  replays?: number
  headless?: boolean
  allowWrite?: boolean
  allowDestructive?: boolean
}

export class LocatorValidationInputError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super('Locator validation input is invalid')
  }
}

class RuntimeExecutionError extends Error {
  constructor(readonly failure: RuntimeFailureEvidence, options?: ErrorOptions) {
    super(failure.message, options)
  }
}

function executionError(
  kind: RuntimeFailureKind,
  phase: RuntimeFailureEvidence['phase'],
  message: string,
  target?: StepIR | AssertionIR,
  cause?: unknown,
): RuntimeExecutionError {
  return new RuntimeExecutionError({
    kind,
    phase,
    message,
    ...(target ? { targetId: target.id, sourceText: target.sourceText } : {}),
  }, cause !== undefined ? { cause } : undefined)
}

function locatorFailureKind(check: LocatorCheckResult): RuntimeFailureKind {
  if (check.count === 0) return 'locator_not_found'
  if (check.count > 1) return 'locator_ambiguous'
  if (check.visible === false) return 'locator_not_visible'
  if (check.enabled === false) return 'locator_not_enabled'
  if (check.editable === false) return 'locator_not_editable'
  return 'unknown'
}

function actionFailureKind(step: StepIR, error: unknown): RuntimeFailureKind {
  const message = error instanceof Error ? error.message : String(error)
  if (step.action === 'navigate') return 'navigation_error'
  if (step.action === 'upload' && /ENOENT|no such file|cannot find/i.test(message)) return 'missing_data'
  if (/timeout|timed out|waiting for/i.test(message)) return 'action_timeout'
  return 'action_error'
}

function regexSource(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function valueForStep(step: StepIR, data: Record<string, RuntimeValue>): RuntimeValue | undefined {
  if (step.valueRef) return data[step.valueRef]
  return step.literalValue
}

function allowedOrigins(suite: TestSuiteIR): Set<string> {
  return new Set(suite.target.allowedOrigins.map((value) => new URL(value).origin))
}

function assertAllowedOrigin(page: Page, origins: Set<string>): void {
  const url = new URL(page.url())
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !origins.has(url.origin)) {
    throw new Error(`Navigation left allowed origins: ${url.origin}`)
  }
}

function reportUrl(value: string): string {
  const url = new URL(value)
  return `${url.origin}${url.pathname}`
}

function actionabilityMessage(step: StepIR, count: number, visible: boolean | null, enabled: boolean | null, editable: boolean | null): string | undefined {
  if (count !== 1) return `locator matched ${count} elements; expected exactly 1`
  if (visible !== true) return 'locator is not visible'
  if (['click', 'fill', 'select', 'check', 'uncheck', 'press', 'upload'].includes(step.action) && enabled !== true) {
    return 'locator is not enabled'
  }
  if (step.action === 'fill' && editable !== true) return 'locator is not editable'
  return undefined
}

async function inspectStepLocator(
  page: Page,
  step: StepIR,
  replay: number,
  targetType: 'step' | 'cleanup',
): Promise<{ locator: Locator; check: LocatorCheckResult }> {
  if (!step.locator) throw new Error(`Step ${step.id} has no locator`)
  const locator = createLocator(page, step.locator)
  const count = await locator.count()
  const visible = count === 1 ? await locator.isVisible() : null
  const enabled = count === 1 ? await locator.isEnabled() : null
  const editable = count === 1 && step.action === 'fill' ? await locator.isEditable() : null
  const message = actionabilityMessage(step, count, visible, enabled, editable)
  return {
    locator,
    check: {
      replay,
      targetId: step.id,
      targetType,
      sourceText: step.sourceText,
      expression: locatorExpression(step.locator),
      url: reportUrl(page.url()),
      count,
      visible,
      enabled,
      editable,
      passed: message === undefined,
      ...(message ? { message } : {}),
    },
  }
}

async function inspectAssertionLocator(
  page: Page,
  assertion: AssertionIR,
  replay: number,
): Promise<{ locator: Locator; check: LocatorCheckResult }> {
  if (!assertion.locator) throw new Error(`Assertion ${assertion.id} has no locator`)
  const locator = createLocator(page, assertion.locator)
  const count = await locator.count()
  const visible = count === 1 ? await locator.isVisible() : null
  const enabled = count === 1 ? await locator.isEnabled() : null
  const editable = count === 1 && assertion.kind === 'value' ? await locator.isEditable() : null
  const allowsMultiple = assertion.kind === 'count'
  const allowsMissing = assertion.kind === 'hidden'
  const passed = allowsMultiple || (allowsMissing ? count <= 1 : count === 1)
  const message = passed ? undefined : `locator matched ${count} elements; assertion requires ${allowsMissing ? '0 or 1' : 'exactly 1'}`
  return {
    locator,
    check: {
      replay,
      targetId: assertion.id,
      targetType: 'assertion',
      sourceText: assertion.sourceText,
      expression: locatorExpression(assertion.locator),
      url: reportUrl(page.url()),
      count,
      visible,
      enabled,
      editable,
      passed,
      ...(message ? { message } : {}),
    },
  }
}

async function applyWait(page: Page, waitFor: WaitConditionIR, locator: Locator | undefined): Promise<void> {
  const timeout = waitFor.timeoutMs ?? 10_000
  if (waitFor.kind === 'url') {
    await expect(page).toHaveURL(new RegExp(regexSource(waitFor.expected ?? '')), { timeout })
    return
  }
  if (!locator) throw new Error(`Wait condition ${waitFor.kind} requires a locator`)
  switch (waitFor.kind) {
    case 'visible':
    case 'hidden':
    case 'attached':
    case 'detached':
      await locator.waitFor({ state: waitFor.kind, timeout })
      return
    case 'response':
      throw new Error('Response waits are not supported by the locator validator')
  }
}

async function executeStep(
  page: Page,
  step: StepIR,
  data: Record<string, RuntimeValue>,
  origins: Set<string>,
  replay: number,
  targetType: 'step' | 'cleanup',
  checks: LocatorCheckResult[],
): Promise<void> {
  let locator: Locator | undefined
  if (step.locator) {
    const inspected = await inspectStepLocator(page, step, replay, targetType)
    locator = inspected.locator
    checks.push(inspected.check)
    if (!inspected.check.passed) {
      throw executionError(locatorFailureKind(inspected.check), targetType, inspected.check.message ?? 'locator validation failed', step)
    }
  }
  const value = valueForStep(step, data)
  if (step.action === 'wait_for') {
    try {
      await applyWait(page, step.waitFor!, locator)
    } catch (error) {
      throw executionError('wait_timeout', targetType, error instanceof Error ? error.message : String(error), step, error)
    }
  } else {
    try {
      switch (step.action) {
        case 'navigate':
          await page.goto(String(value))
          break
        case 'click':
          await locator!.click()
          break
        case 'fill':
          await locator!.fill(String(value))
          break
        case 'select':
          await locator!.selectOption(String(value))
          break
        case 'check':
          await locator!.check()
          break
        case 'uncheck':
          await locator!.uncheck()
          break
        case 'press':
          if (locator) await locator.press(String(value))
          else await page.keyboard.press(String(value))
          break
        case 'upload':
          await locator!.setInputFiles(String(value))
          break
        case 'manual':
          throw new Error(`Manual step cannot execute: ${step.id}`)
      }
    } catch (error) {
      if (error instanceof RuntimeExecutionError) throw error
      throw executionError(actionFailureKind(step, error), targetType, error instanceof Error ? error.message : String(error), step, error)
    }
    if (step.waitFor) {
      try {
        await applyWait(page, step.waitFor, locator)
      } catch (error) {
        throw executionError('wait_timeout', targetType, error instanceof Error ? error.message : String(error), step, error)
      }
    }
  }
  try {
    assertAllowedOrigin(page, origins)
  } catch (error) {
    throw executionError('origin_violation', targetType, error instanceof Error ? error.message : String(error), step, error)
  }
}

async function executeAssertion(
  page: Page,
  assertion: AssertionIR,
  origins: Set<string>,
  replay: number,
  checks: LocatorCheckResult[],
): Promise<void> {
  try {
    assertAllowedOrigin(page, origins)
  } catch (error) {
    throw executionError('origin_violation', 'assertion', error instanceof Error ? error.message : String(error), assertion, error)
  }
  let locator: Locator | undefined
  if (assertion.locator) {
    const inspected = await inspectAssertionLocator(page, assertion, replay)
    locator = inspected.locator
    checks.push(inspected.check)
    if (!inspected.check.passed) {
      throw executionError(locatorFailureKind(inspected.check), 'assertion', inspected.check.message ?? 'locator validation failed', assertion)
    }
  }
  const expected = assertion.expected
  try {
    switch (assertion.kind) {
      case 'url':
        await expect(page).toHaveURL(assertion.operator === 'equals' ? String(expected) : new RegExp(assertion.operator === 'matches' ? String(expected) : regexSource(String(expected))))
        break
      case 'title':
        await expect(page).toHaveTitle(assertion.operator === 'equals' ? String(expected) : new RegExp(assertion.operator === 'matches' ? String(expected) : regexSource(String(expected))))
        break
      case 'visible':
        await expect(locator!).toBeVisible()
        break
      case 'hidden':
        await expect(locator!).toBeHidden()
        break
      case 'text':
        if (assertion.operator === 'equals') await expect(locator!).toHaveText(String(expected))
        else if (assertion.operator === 'matches') await expect(locator!).toHaveText(new RegExp(String(expected)))
        else await expect(locator!).toContainText(String(expected))
        break
      case 'value':
        await expect(locator!).toHaveValue(assertion.operator === 'equals' ? String(expected) : new RegExp(assertion.operator === 'matches' ? String(expected) : regexSource(String(expected))))
        break
      case 'enabled':
        if (expected === false) await expect(locator!).toBeDisabled()
        else await expect(locator!).toBeEnabled()
        break
      case 'checked':
        if (expected === false) await expect(locator!).not.toBeChecked()
        else await expect(locator!).toBeChecked()
        break
      case 'count':
        if (assertion.operator === 'equals') await expect(locator!).toHaveCount(Number(expected))
        else {
          const observed = expect.poll(() => locator!.count())
          if (assertion.operator === 'gt') await observed.toBeGreaterThan(Number(expected))
          else if (assertion.operator === 'gte') await observed.toBeGreaterThanOrEqual(Number(expected))
          else if (assertion.operator === 'lt') await observed.toBeLessThan(Number(expected))
          else await observed.toBeLessThanOrEqual(Number(expected))
        }
        break
    }
  } catch (error) {
    if (error instanceof RuntimeExecutionError) throw error
    throw executionError('assertion_mismatch', 'assertion', error instanceof Error ? error.message : String(error), assertion, error)
  }
}

function sanitizeError(error: unknown, data: Record<string, RuntimeValue>): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const value of Object.values(data)) {
    const text = String(value)
    if (text) message = message.replaceAll(text, '[REDACTED]')
  }
  return redactSensitiveText(message)
}

function failureEvidence(error: unknown, data: Record<string, RuntimeValue>): RuntimeFailureEvidence {
  const failure = error instanceof RuntimeExecutionError
    ? error.failure
    : { kind: 'unknown' as const, phase: 'setup' as const, message: error instanceof Error ? error.message : String(error) }
  return { ...failure, message: sanitizeError(failure.message, data) }
}

function blockedReason(testCase: TestCaseIR, options: LocatorValidationOptions): string | undefined {
  if (testCase.risk === 'write' && !options.allowWrite) return 'write case requires --allow-write'
  if (testCase.risk === 'destructive' && !options.allowDestructive) return 'destructive case requires --allow-destructive'
  return undefined
}

async function validateCase(
  browser: Browser,
  suite: TestSuiteIR,
  testCase: TestCaseIR,
  replayCount: number,
  options: LocatorValidationOptions,
): Promise<CaseLocatorValidationResult> {
  const reason = blockedReason(testCase, options)
  if (reason) return { caseId: testCase.id, title: testCase.title, status: 'blocked', stableAcrossReplays: false, replays: [], blockedReason: reason }

  let data: Record<string, RuntimeValue> = {}
  try {
    data = resolveDataBindings(testCase.dataBindings ?? [])
  } catch (error) {
    const failure: RuntimeFailureEvidence = {
      kind: 'missing_data',
      phase: 'setup',
      message: sanitizeError(error, data),
    }
    return {
      caseId: testCase.id,
      title: testCase.title,
      status: 'failed',
      stableAcrossReplays: false,
      replays: [{ replay: 1, status: 'failed', durationMs: 0, checks: [], error: failure.message, failure }],
    }
  }

  const origins = allowedOrigins(suite)
  const replays: ReplayValidationResult[] = []
  for (let replay = 1; replay <= replayCount; replay += 1) {
    const startedAt = Date.now()
    const checks: LocatorCheckResult[] = []
    let context: BrowserContext | undefined
    let page: Page | undefined
    let replayError: unknown
    let replayFailure: RuntimeFailureEvidence | undefined
    try {
      context = await browser.newContext({ baseURL: suite.target.baseUrl })
      page = await context.newPage()
      page.setDefaultTimeout(suite.policy.caseTimeoutMs)
      page.setDefaultNavigationTimeout(suite.policy.caseTimeoutMs)
      for (const step of testCase.steps) await executeStep(page, step, data, origins, replay, 'step', checks)
      for (const assertion of testCase.assertions) await executeAssertion(page, assertion, origins, replay, checks)
    } catch (error) {
      replayError = error
      replayFailure = error instanceof RuntimeExecutionError
        ? failureEvidence(error, data)
        : {
            kind: 'environment_error',
            phase: 'setup',
            message: sanitizeError(error, data),
          }
    } finally {
      if (page) {
        try {
          for (const step of testCase.cleanupSteps ?? []) await executeStep(page, step, data, origins, replay, 'cleanup', checks)
        } catch (cleanupError) {
          if (!replayError) {
            replayError = cleanupError
            replayFailure = failureEvidence(cleanupError, data)
          }
        }
      }
      await context?.close()
    }
    replays.push({
      replay,
      status: replayError ? 'failed' : 'passed',
      durationMs: Date.now() - startedAt,
      checks,
      ...(replayError ? { error: sanitizeError(replayError, data) } : {}),
      ...(replayFailure ? { failure: replayFailure } : {}),
    })
  }
  const observedTargets = new Map<string, number>()
  for (const replay of replays) {
    for (const check of replay.checks) {
      const key = `${check.targetType}:${check.targetId}`
      observedTargets.set(key, (observedTargets.get(key) ?? 0) + (check.passed ? 1 : 0))
    }
  }
  const stableAcrossReplays =
    replays.every((item) => item.status === 'passed') &&
    [...observedTargets.values()].every((count) => count === replayCount)
  return {
    caseId: testCase.id,
    title: testCase.title,
    status: stableAcrossReplays ? 'passed' : 'failed',
    stableAcrossReplays,
    replays,
  }
}

export async function validateLocators(
  input: unknown,
  options: LocatorValidationOptions = {},
): Promise<LocatorValidationReport> {
  const compiled = compilePlaywrightSuite(input)
  if (compiled.diagnostics.hasErrors) throw new LocatorValidationInputError(compiled.diagnostics.items)
  const suite = input as TestSuiteIR
  const requested = options.caseIds?.length
    ? suite.cases.filter((testCase) => options.caseIds!.includes(testCase.id))
    : suite.cases
  const missing = options.caseIds?.filter((caseId) => !suite.cases.some((testCase) => testCase.id === caseId)) ?? []
  if (missing.length) throw new Error(`Unknown case IDs: ${missing.join(', ')}`)
  const replayCount = options.replays ?? 2
  if (!Number.isInteger(replayCount) || replayCount < 1 || replayCount > 3) throw new Error('replays must be an integer from 1 to 3')

  let browser: Browser
  try {
    browser = await chromium.launch({ headless: options.headless ?? true })
  } catch (error) {
    const message = sanitizeError(error, {})
    const cases: CaseLocatorValidationResult[] = requested.map((testCase) => ({
      caseId: testCase.id,
      title: testCase.title,
      status: 'failed',
      stableAcrossReplays: false,
      replays: [{
        replay: 1,
        status: 'failed',
        durationMs: 0,
        checks: [],
        error: message,
        failure: { kind: 'environment_error', phase: 'setup', message },
      }],
    }))
    return {
      version: '1.0',
      generatedAt: new Date().toISOString(),
      suiteId: suite.suiteId,
      requestedReplays: replayCount,
      cases,
      summary: { total: cases.length, passed: 0, failed: cases.length, blocked: 0, locatorChecks: 0 },
    }
  }
  const cases: CaseLocatorValidationResult[] = []
  try {
    for (const testCase of requested) cases.push(await validateCase(browser, suite, testCase, replayCount, options))
  } finally {
    await browser.close()
  }
  return {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    suiteId: suite.suiteId,
    requestedReplays: replayCount,
    cases,
    summary: {
      total: cases.length,
      passed: cases.filter((item) => item.status === 'passed').length,
      failed: cases.filter((item) => item.status === 'failed').length,
      blocked: cases.filter((item) => item.status === 'blocked').length,
      locatorChecks: cases.flatMap((item) => item.replays).flatMap((item) => item.checks).length,
    },
  }
}
