import { createHash } from 'node:crypto'
import { DiagnosticBag } from '../core/diagnostics.js'
import type {
  AssertionIR,
  DataBindingIR,
  LocatorIR,
  StepIR,
  TestCaseIR,
  TestSuiteIR,
  WaitConditionIR,
} from '../core/types.js'
import { slugify } from '../input/text.js'
import { secretEnvironmentName } from '../runtime/data.js'
import { locatorExpression } from '../runtime/locator.js'
import { validateSuite } from '../validation/schema.js'

export interface CompiledSuite {
  fileName: string
  source: string
  diagnostics: DiagnosticBag
  sourceMap: CompiledSourceMap | null
}

export interface CompiledTargetSourceMap {
  id: string
  sourceText: string
  line: number
}

export interface CompiledCaseSourceMap {
  caseId: string
  title: string
  sourceRow?: number
  testLine: number
  steps: CompiledTargetSourceMap[]
  assertions: CompiledTargetSourceMap[]
  cleanupSteps: CompiledTargetSourceMap[]
}

export interface CompiledSourceMap {
  version: '1.0'
  suiteId: string
  generatedFile: string
  irSha256: string
  generatedSha256: string
  source: TestSuiteIR['source']
  cases: CompiledCaseSourceMap[]
}

const ariaRoles = new Set([
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'meter',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
])

const assertionOperators: Record<AssertionIR['kind'], ReadonlySet<AssertionIR['operator']>> = {
  visible: new Set(['equals']),
  hidden: new Set(['equals']),
  text: new Set(['equals', 'contains', 'matches']),
  url: new Set(['equals', 'contains', 'matches']),
  title: new Set(['equals', 'contains', 'matches']),
  value: new Set(['equals', 'contains', 'matches']),
  count: new Set(['equals', 'gt', 'gte', 'lt', 'lte']),
  enabled: new Set(['equals']),
  checked: new Set(['equals']),
}

function q(value: unknown): string {
  return JSON.stringify(value)
}

function regexSource(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function regexExpression(value: string, operator: AssertionIR['operator']): string {
  return `new RegExp(${q(operator === 'matches' ? value : regexSource(value))})`
}

function valueExpression(step: StepIR): string {
  if (step.valueRef) return `data[${q(step.valueRef)}]`
  if (step.literalValue !== undefined) return q(step.literalValue)
  return 'undefined'
}

function waitLines(waitFor: WaitConditionIR, locator: LocatorIR | undefined, indent: string): string[] {
  if (waitFor.kind === 'url') {
    const expected = waitFor.expected ?? ''
    return [`${indent}await expect(page).toHaveURL(new RegExp(${q(regexSource(expected))}), { timeout: ${waitFor.timeoutMs ?? 10_000} })`]
  }
  if (waitFor.kind === 'response') {
    return [`${indent}throw new Error('response wait must be compiled around its triggering action')`]
  }
  if (!locator) return [`${indent}throw new Error('wait condition requires locator')`]
  const subject = locatorExpression(locator)
  const timeout = waitFor.timeoutMs ?? 10_000
  switch (waitFor.kind) {
    case 'visible':
      return [`${indent}await ${subject}.waitFor({ state: 'visible', timeout: ${timeout} })`]
    case 'hidden':
      return [`${indent}await ${subject}.waitFor({ state: 'hidden', timeout: ${timeout} })`]
    case 'attached':
      return [`${indent}await ${subject}.waitFor({ state: 'attached', timeout: ${timeout} })`]
    case 'detached':
      return [`${indent}await ${subject}.waitFor({ state: 'detached', timeout: ${timeout} })`]
    default:
      return []
  }
}

function stepLines(step: StepIR, indent: string): string[] {
  const locator = step.locator ? locatorExpression(step.locator) : null
  const value = valueExpression(step)
  const lines: string[] = [`${indent}await test.step(${q(step.sourceText)}, async () => {`]
  const inner = `${indent}  `

  switch (step.action) {
    case 'navigate': {
      const target = `String(${value})`
      lines.push(`${inner}assertAllowedOrigin(${target})`)
      lines.push(`${inner}await page.goto(${target})`)
      break
    }
    case 'click':
      lines.push(`${inner}await ${locator}.click()`)
      break
    case 'fill':
      lines.push(`${inner}await ${locator}.fill(String(${value}))`)
      break
    case 'select':
      lines.push(`${inner}await ${locator}.selectOption(String(${value}))`)
      break
    case 'check':
      lines.push(`${inner}await ${locator}.check()`)
      break
    case 'uncheck':
      lines.push(`${inner}await ${locator}.uncheck()`)
      break
    case 'press':
      lines.push(`${inner}await ${locator ? `${locator}.press(String(${value}))` : `page.keyboard.press(String(${value}))`}`)
      break
    case 'upload':
      lines.push(`${inner}await ${locator}.setInputFiles(String(${value}))`)
      break
    case 'wait_for':
      if (step.waitFor) lines.push(...waitLines(step.waitFor, step.locator, inner))
      break
    case 'manual':
      lines.push(`${inner}throw new Error('manual step cannot execute')`)
      break
  }
  if (step.action !== 'wait_for' && step.waitFor) lines.push(...waitLines(step.waitFor, step.locator, inner))
  lines.push(`${inner}assertAllowedOrigin(page.url())`)
  lines.push(`${indent}})`)
  return lines
}

function assertionLines(assertion: AssertionIR, indent: string): string[] {
  const source = `${indent}await test.step(${q(assertion.sourceText)}, async () => {`
  const inner = `${indent}  `
  const lines = [source]
  const subject = assertion.locator ? locatorExpression(assertion.locator) : null

  lines.push(`${inner}assertAllowedOrigin(page.url())`)

  switch (assertion.kind) {
    case 'url':
      if (assertion.operator === 'equals') lines.push(`${inner}await expect(page).toHaveURL(${q(String(assertion.expected))})`)
      else lines.push(`${inner}await expect(page).toHaveURL(${regexExpression(String(assertion.expected), assertion.operator)})`)
      break
    case 'title':
      if (assertion.operator === 'equals') lines.push(`${inner}await expect(page).toHaveTitle(${q(String(assertion.expected))})`)
      else lines.push(`${inner}await expect(page).toHaveTitle(${regexExpression(String(assertion.expected), assertion.operator)})`)
      break
    case 'visible':
      lines.push(`${inner}await expect(${subject}).toBeVisible()`)
      break
    case 'hidden':
      lines.push(`${inner}await expect(${subject}).toBeHidden()`)
      break
    case 'text':
      if (assertion.operator === 'equals') lines.push(`${inner}await expect(${subject}).toHaveText(${q(String(assertion.expected))})`)
      else if (assertion.operator === 'matches') lines.push(`${inner}await expect(${subject}).toHaveText(${regexExpression(String(assertion.expected), assertion.operator)})`)
      else lines.push(`${inner}await expect(${subject}).toContainText(${q(String(assertion.expected))})`)
      break
    case 'value':
      if (assertion.operator === 'equals') lines.push(`${inner}await expect(${subject}).toHaveValue(${q(String(assertion.expected))})`)
      else lines.push(`${inner}await expect(${subject}).toHaveValue(${regexExpression(String(assertion.expected), assertion.operator)})`)
      break
    case 'enabled':
      lines.push(`${inner}await expect(${subject}).${assertion.expected === false ? 'toBeDisabled' : 'toBeEnabled'}()`)
      break
    case 'checked':
      lines.push(`${inner}await expect(${subject}).${assertion.expected === false ? 'not.toBeChecked' : 'toBeChecked'}()`)
      break
    case 'count': {
      const expected = Number(assertion.expected)
      if (assertion.operator === 'equals') lines.push(`${inner}await expect(${subject}).toHaveCount(${expected})`)
      else {
        const matcher: Record<string, string> = { gt: 'toBeGreaterThan', gte: 'toBeGreaterThanOrEqual', lt: 'toBeLessThan', lte: 'toBeLessThanOrEqual' }
        lines.push(`${inner}await expect.poll(() => ${subject}.count()).${matcher[assertion.operator] ?? 'toBe'}(${expected})`)
      }
      break
    }
  }
  lines.push(`${indent}})`)
  return lines
}

function validateBinding(binding: DataBindingIR, testCase: TestCaseIR, diagnostics: DiagnosticBag): void {
  if (binding.source === 'secret' && binding.secretRef?.startsWith('unresolved.')) {
    diagnostics.error('unresolved_secret', `数据「${binding.name}」仍是未解析 secretRef`, { caseId: testCase.id })
  }
  if (binding.source === 'secret' && binding.value !== undefined) {
    diagnostics.error('secret_literal_forbidden', `秘密数据「${binding.name}」不得包含明文 value`, { caseId: testCase.id })
  }
  if (binding.source === 'generated' && !['uuid', 'timestamp'].includes(binding.generator ?? '')) {
    diagnostics.error('generator_unsupported', `不支持数据生成器「${binding.generator ?? ''}」`, { caseId: testCase.id })
  }
}

function validateLocator(locator: LocatorIR | undefined, sourceText: string, testCase: TestCaseIR, diagnostics: DiagnosticBag): void {
  if (locator?.strategy === 'role' && !ariaRoles.has(locator.value)) {
    diagnostics.error('locator_role_invalid', `定位器「${sourceText}」包含无效 ARIA role「${locator.value}」`, { caseId: testCase.id })
  }
}

function validateRegex(value: string, sourceText: string, testCase: TestCaseIR, diagnostics: DiagnosticBag): void {
  try {
    new RegExp(value)
  } catch {
    diagnostics.error('assertion_regex_invalid', `断言「${sourceText}」包含无效正则表达式`, { caseId: testCase.id })
  }
}

function validateStep(step: StepIR, bindingNames: Set<string>, testCase: TestCaseIR, diagnostics: DiagnosticBag): void {
  const needsLocator = ['click', 'fill', 'select', 'check', 'uncheck', 'upload'].includes(step.action)
  const needsValue = ['navigate', 'fill', 'select', 'press', 'upload'].includes(step.action)
  if (step.action === 'manual') diagnostics.error('manual_step_blocked', `步骤「${step.sourceText}」尚未解释`, { caseId: testCase.id })
  if (needsLocator && !step.locator) diagnostics.error('step_locator_missing', `步骤「${step.sourceText}」缺少稳定定位器`, { caseId: testCase.id })
  validateLocator(step.locator, step.sourceText, testCase, diagnostics)
  if (needsValue && !step.valueRef && step.literalValue === undefined) {
    diagnostics.error('step_value_missing', `步骤「${step.sourceText}」缺少输入值`, { caseId: testCase.id })
  }
  if (step.valueRef && step.literalValue !== undefined) {
    diagnostics.error('step_value_ambiguous', `步骤「${step.sourceText}」不能同时包含 valueRef 和 literalValue`, { caseId: testCase.id })
  }
  if (step.valueRef && !bindingNames.has(step.valueRef)) {
    diagnostics.error('step_value_ref_missing', `步骤「${step.sourceText}」引用了不存在的数据「${step.valueRef}」`, { caseId: testCase.id })
  }
  if (step.action === 'wait_for' && !step.waitFor) diagnostics.error('wait_condition_missing', `等待步骤「${step.sourceText}」缺少 waitFor`, { caseId: testCase.id })
  if (step.waitFor?.kind === 'response') diagnostics.error('response_wait_unsupported', 'MVP 编译器暂不支持 response wait', { caseId: testCase.id })
  if (step.waitFor?.kind === 'url' && !step.waitFor.expected?.trim()) {
    diagnostics.error('url_wait_expected_missing', `等待步骤「${step.sourceText}」缺少期望 URL`, { caseId: testCase.id })
  }
}

function validateAssertion(assertion: AssertionIR, testCase: TestCaseIR, diagnostics: DiagnosticBag): void {
  if (!['url', 'title'].includes(assertion.kind) && !assertion.locator) {
    diagnostics.error('assertion_locator_missing', `断言「${assertion.sourceText}」缺少稳定定位器`, { caseId: testCase.id })
  }
  if (assertion.kind === 'url' && assertion.expected === 'UNCHANGED') {
    diagnostics.error('url_oracle_unresolved', `断言「${assertion.sourceText}」需要明确 URL`, { caseId: testCase.id })
  }
  validateLocator(assertion.locator, assertion.sourceText, testCase, diagnostics)
  if (!assertionOperators[assertion.kind].has(assertion.operator)) {
    diagnostics.error('assertion_operator_invalid', `断言「${assertion.sourceText}」不支持操作符「${assertion.operator}」`, { caseId: testCase.id })
  }
  if (['text', 'url', 'title', 'value'].includes(assertion.kind) && typeof assertion.expected !== 'string') {
    diagnostics.error('assertion_expected_type', `断言「${assertion.sourceText}」的期望值必须是字符串`, { caseId: testCase.id })
  }
  if (['visible', 'hidden'].includes(assertion.kind) && assertion.expected !== true) {
    diagnostics.error('assertion_expected_type', `断言「${assertion.sourceText}」的期望值必须是 true`, { caseId: testCase.id })
  }
  if (['enabled', 'checked'].includes(assertion.kind) && typeof assertion.expected !== 'boolean') {
    diagnostics.error('assertion_expected_type', `断言「${assertion.sourceText}」的期望值必须是布尔值`, { caseId: testCase.id })
  }
  if (assertion.kind === 'count' && (!Number.isInteger(assertion.expected) || Number(assertion.expected) < 0)) {
    diagnostics.error('assertion_expected_type', `断言「${assertion.sourceText}」的期望值必须是非负整数`, { caseId: testCase.id })
  }
  if (assertion.operator === 'matches' && typeof assertion.expected === 'string') {
    validateRegex(assertion.expected, assertion.sourceText, testCase, diagnostics)
  }
}

function validateCase(testCase: TestCaseIR, suite: TestSuiteIR, diagnostics: DiagnosticBag): void {
  if (testCase.review.status !== 'approved') diagnostics.error('case_not_approved', '用例尚未审核批准', { caseId: testCase.id })
  if (testCase.review.ambiguities.length > 0) diagnostics.error('case_has_ambiguities', '用例仍有未解决歧义', { caseId: testCase.id })
  if (testCase.risk === 'destructive' && suite.policy.destructiveActions === 'blocked') {
    diagnostics.error('destructive_blocked', '破坏性用例被套件策略阻止', { caseId: testCase.id })
  }
  if (testCase.risk !== 'read' && (!testCase.cleanupSteps || testCase.cleanupSteps.length === 0)) {
    diagnostics.error('cleanup_missing', '写入或破坏性用例缺少清理步骤', { caseId: testCase.id })
  }
  const bindings = testCase.dataBindings ?? []
  const bindingNames = new Set<string>()
  const secretEnvironmentNames = new Map<string, string>()
  for (const binding of bindings) {
    if (bindingNames.has(binding.name)) diagnostics.error('binding_duplicate', `数据名称「${binding.name}」重复`, { caseId: testCase.id })
    bindingNames.add(binding.name)
    if (binding.source === 'secret' && binding.secretRef) {
      const environmentName = secretEnvironmentName(binding.secretRef)
      const existingRef = secretEnvironmentNames.get(environmentName)
      if (existingRef && existingRef !== binding.secretRef) {
        diagnostics.error('secret_env_collision', `secretRef「${existingRef}」与「${binding.secretRef}」映射到同一环境变量`, { caseId: testCase.id })
      }
      secretEnvironmentNames.set(environmentName, binding.secretRef)
    }
    validateBinding(binding, testCase, diagnostics)
  }
  for (const step of testCase.steps) validateStep(step, bindingNames, testCase, diagnostics)
  for (const assertion of testCase.assertions) validateAssertion(assertion, testCase, diagnostics)
  for (const step of testCase.cleanupSteps ?? []) validateStep(step, bindingNames, testCase, diagnostics)
}

function validateTarget(suite: TestSuiteIR, diagnostics: DiagnosticBag): string[] {
  const allowedOrigins: string[] = []
  let baseOrigin = ''
  try {
    const baseUrl = new URL(suite.target.baseUrl)
    baseOrigin = baseUrl.origin
    if (baseUrl.username || baseUrl.password) diagnostics.error('target_credentials_forbidden', 'baseUrl 不得包含用户名或密码')
  } catch {
    diagnostics.error('target_url_invalid', 'baseUrl 不是有效 URL')
  }
  for (const value of suite.target.allowedOrigins) {
    try {
      const url = new URL(value)
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        diagnostics.error('allowed_origin_invalid', `allowedOrigins 必须是无凭据、路径、查询或片段的 origin：「${value}」`)
      }
      allowedOrigins.push(url.origin)
    } catch {
      diagnostics.error('allowed_origin_invalid', `allowedOrigins 包含无效 URL：「${value}」`)
    }
  }
  if (baseOrigin && !allowedOrigins.includes(baseOrigin)) {
    diagnostics.error('base_origin_not_allowed', `baseUrl 的 origin「${baseOrigin}」不在 allowedOrigins 中`)
  }
  return [...new Set(allowedOrigins)]
}

function dataLines(bindings: DataBindingIR[], indent: string): string[] {
  const lines = [`${indent}const data: Record<string, string | number | boolean> = {}`]
  for (const binding of bindings) {
    if (binding.source === 'secret') lines.push(`${indent}data[${q(binding.name)}] = requiredEnv(${q(secretEnvironmentName(binding.secretRef ?? ''))})`)
    else if (binding.source === 'generated' && binding.generator === 'uuid') lines.push(`${indent}data[${q(binding.name)}] = randomUUID()`)
    else if (binding.source === 'generated' && binding.generator === 'timestamp') lines.push(`${indent}data[${q(binding.name)}] = Date.now()`)
    else lines.push(`${indent}data[${q(binding.name)}] = ${q(binding.value)}`)
  }
  return lines
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function compileCase(testCase: TestCaseIR, timeoutMs: number, startLine: number): {
  lines: string[]
  sourceMap: CompiledCaseSourceMap
} {
  const lines: string[] = []
  const sourceMap: CompiledCaseSourceMap = {
    caseId: testCase.id,
    title: testCase.title,
    ...(testCase.sourceRow !== undefined ? { sourceRow: testCase.sourceRow } : {}),
    testLine: startLine,
    steps: [],
    assertions: [],
    cleanupSteps: [],
  }
  lines.push(`test(${q(`${testCase.id} ${testCase.title}`)}, async ({ page }) => {`)
  lines.push(`  test.setTimeout(${timeoutMs})`)
  lines.push(...dataLines(testCase.dataBindings ?? [], '  '))
  if (testCase.cleanupSteps?.length) {
    lines.push('  try {')
    for (const step of testCase.steps) {
      sourceMap.steps.push({ id: step.id, sourceText: step.sourceText, line: startLine + lines.length })
      lines.push(...stepLines(step, '    '))
    }
    for (const assertion of testCase.assertions) {
      sourceMap.assertions.push({ id: assertion.id, sourceText: assertion.sourceText, line: startLine + lines.length })
      lines.push(...assertionLines(assertion, '    '))
    }
    lines.push('  } finally {')
    for (const step of testCase.cleanupSteps) {
      sourceMap.cleanupSteps.push({ id: step.id, sourceText: step.sourceText, line: startLine + lines.length })
      lines.push(...stepLines(step, '    '))
    }
    lines.push('  }')
  } else {
    for (const step of testCase.steps) {
      sourceMap.steps.push({ id: step.id, sourceText: step.sourceText, line: startLine + lines.length })
      lines.push(...stepLines(step, '  '))
    }
    for (const assertion of testCase.assertions) {
      sourceMap.assertions.push({ id: assertion.id, sourceText: assertion.sourceText, line: startLine + lines.length })
      lines.push(...assertionLines(assertion, '  '))
    }
  }
  lines.push('})')
  return { lines, sourceMap }
}

export function compilePlaywrightSuite(input: unknown): CompiledSuite {
  const diagnostics = new DiagnosticBag()
  const schema = validateSuite(input)
  diagnostics.items.push(...schema.diagnostics)
  if (!schema.valid) return { fileName: 'invalid-suite.spec.ts', source: '', diagnostics, sourceMap: null }

  const suite = input as TestSuiteIR
  const allowedOrigins = validateTarget(suite, diagnostics)
  for (const testCase of suite.cases) validateCase(testCase, suite, diagnostics)

  const fileName = `${slugify(suite.suiteId)}.spec.ts`
  if (diagnostics.hasErrors) return { fileName, source: '', diagnostics, sourceMap: null }

  const lines = [
    "import { randomUUID } from 'node:crypto'",
    "import { expect, test } from '@playwright/test'",
    '',
    'function requiredEnv(name: string): string {',
    '  const value = process.env[name]',
    "  if (!value) throw new Error(`Missing required secret environment variable: ${name}`)",
    '  return value',
    '}',
    '',
    `const allowedOrigins = new Set(${q(allowedOrigins)})`,
    '',
    'function assertAllowedOrigin(url: string): void {',
    '  const parsed = new URL(url)',
    "  if (!['http:', 'https:'].includes(parsed.protocol) || !allowedOrigins.has(parsed.origin)) {",
    '    throw new Error(`Navigation left allowed origins: ${parsed.origin}`)',
    '  }',
    '}',
    '',
    `test.use({ baseURL: ${q(suite.target.baseUrl)} })`,
    `test.describe.configure({ retries: ${suite.policy.retries} })`,
    '',
  ]
  const caseMaps: CompiledCaseSourceMap[] = []
  suite.cases.forEach((testCase, index) => {
    if (index > 0) lines.push('')
    const compiledCase = compileCase(testCase, suite.policy.caseTimeoutMs, lines.length + 1)
    lines.push(...compiledCase.lines)
    caseMaps.push(compiledCase.sourceMap)
  })
  lines.push('')
  const source = lines.join('\n')
  return {
    fileName,
    source,
    diagnostics,
    sourceMap: {
      version: '1.0',
      suiteId: suite.suiteId,
      generatedFile: fileName,
      irSha256: sha256(JSON.stringify(suite)),
      generatedSha256: sha256(source),
      source: structuredClone(suite.source),
      cases: caseMaps,
    },
  }
}
