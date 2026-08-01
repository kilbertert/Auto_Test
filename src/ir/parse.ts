import { DiagnosticBag } from '../core/diagnostics.js'
import type {
  AssertionIR,
  DataBindingIR,
  Priority,
  RiskLevel,
  StepAction,
  StepIR,
} from '../core/types.js'
import type { RawCaseRow } from '../input/xlsx.js'
import { redactSensitiveText, slugify, splitList, splitNumberedItems } from '../input/text.js'

const SENSITIVE_KEY = /用户名|账号|密码|验证码|手机号|身份证|银行卡|password|passwd|pwd|token|secret|api[ _-]?key/i
const SENSITIVE_VALUE = /(?:\+?65[\s-]?\d{8}\b|\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b|\b\d{16,19}\b|\b(?:sk-|ak_)[A-Za-z0-9_-]{12,})/

export interface ParsedCaseParts {
  priority: Priority
  risk: RiskLevel
  riskInferred: boolean
  modulePath: string[]
  dependencies: string[]
  tags: string[]
  preconditions: string[]
  dataBindings: DataBindingIR[]
  steps: StepIR[]
  assertions: AssertionIR[]
  cleanupSteps: StepIR[]
  ambiguities: string[]
}

function diagnosticContext(row: RawCaseRow, caseId?: string): { sheet: string; row: number; caseId?: string } {
  return caseId
    ? { sheet: row.sheetName, row: row.sourceRow, caseId }
    : { sheet: row.sheetName, row: row.sourceRow }
}

export function normalizePriority(raw: string, diagnostics: DiagnosticBag, row: RawCaseRow, caseId: string): Priority {
  const value = raw.trim().toUpperCase()
  if (['P0', '0', '高', 'HIGH', '1'].includes(value)) return 'P0'
  if (['P1', '中', 'MEDIUM', '2'].includes(value)) return 'P1'
  if (['P2', '低', 'LOW', '3'].includes(value)) return 'P2'
  if (['P3', '4'].includes(value)) return 'P3'
  if (value) {
    diagnostics.warning('priority_unknown', `无法识别优先级「${raw}」，使用 P2`, diagnosticContext(row, caseId))
  } else {
    diagnostics.warning('priority_defaulted', '未填写优先级，使用 P2', diagnosticContext(row, caseId))
  }
  return 'P2'
}

function inferRisk(text: string): RiskLevel {
  if (/删除|强制停止|强停|关停|结算|支付|发布|退款|注销|下线|清空数据|停用/.test(text)) {
    return 'destructive'
  }
  if (/新增|创建|添加|编辑|修改|保存|提交|上传|绑定|解绑|注册|启动设备|停止设备|开始充电|启动充电|发送|导入/.test(text)) {
    return 'write'
  }
  return 'read'
}

export function normalizeRisk(
  raw: string,
  behaviorText: string,
  diagnostics: DiagnosticBag,
  row: RawCaseRow,
  caseId: string,
): { risk: RiskLevel; inferred: boolean } {
  const value = raw.trim().toLowerCase()
  if (['read', '只读', '查询'].includes(value)) return { risk: 'read', inferred: false }
  if (['write', '写入', '修改'].includes(value)) return { risk: 'write', inferred: false }
  if (['destructive', '破坏性', '高风险'].includes(value)) return { risk: 'destructive', inferred: false }

  const risk = value ? 'destructive' : inferRisk(behaviorText)
  diagnostics.warning(
    value ? 'risk_invalid' : 'risk_inferred',
    value ? `风险等级「${raw}」非法，按 destructive 阻断处理` : `未填写风险等级，暂推断为 ${risk}，必须审核`,
    diagnosticContext(row, caseId),
  )
  return { risk, inferred: true }
}

function splitModulePart(value: string): string[] {
  return value
    .split(/\s*(?:\/|>|＞)\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function buildModulePath(row: RawCaseRow): string[] {
  const values = row.values
  const parts = [values.project, values.port, values.module, values.function, values.subfunction]
    .filter((value): value is string => Boolean(value))
    .flatMap(splitModulePart)
  return parts.filter((part, index) => index === 0 || part !== parts[index - 1])
}

function uniqueBindingName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix += 1
  const value = `${base}-${suffix}`
  used.add(value)
  return value
}

function parseDataBindings(
  text: string,
  diagnostics: DiagnosticBag,
  row: RawCaseRow,
  caseId: string,
  ambiguities: string[],
): DataBindingIR[] {
  if (!text.trim()) return []
  const segments = text.split(/[\n,，;；]+/).map((segment) => segment.trim()).filter(Boolean)
  const bindings: DataBindingIR[] = []
  const used = new Set<string>()

  for (const segment of segments) {
    const match = /^([^:=：]+?)\s*[:=：]\s*(.+)$/.exec(segment)
    if (!match) {
      ambiguities.push(`无法解析测试数据片段：${redactSensitiveText(segment)}`)
      diagnostics.warning('test_data_unparsed', '存在无法解析为 key=value 的测试数据片段', diagnosticContext(row, caseId))
      continue
    }
    const rawName = match[1]?.trim() ?? ''
    const rawValue = match[2]?.trim() ?? ''
    if (!rawName || !rawValue) continue
    const name = uniqueBindingName(rawName, used)

    const secret = /^\$\{secret:([^}]+)}$/.exec(rawValue)
    if (secret?.[1]) {
      bindings.push({ name, source: 'secret', secretRef: secret[1].trim() })
      continue
    }
    const generated = /^\$\{random:([^}]+)}$/.exec(rawValue)
    if (generated?.[1]) {
      bindings.push({ name, source: 'generated', generator: generated[1].trim() })
      continue
    }
    if (SENSITIVE_KEY.test(rawName) || SENSITIVE_VALUE.test(rawValue)) {
      const secretRef = `unresolved.${slugify(caseId)}.${slugify(rawName)}`
      bindings.push({ name, source: 'secret', secretRef })
      ambiguities.push(`测试数据「${rawName}」必须映射到正式 secretRef`)
      diagnostics.error('plaintext_secret', `测试数据「${rawName}」包含明文敏感值，已从 IR 中移除`, diagnosticContext(row, caseId))
      continue
    }
    bindings.push({ name, source: 'literal', value: redactSensitiveText(rawValue) })
  }
  return bindings
}

function detectAction(text: string): StepAction {
  if (/取消勾选|取消选中/.test(text)) return 'uncheck'
  if (/勾选|选中复选/.test(text)) return 'check'
  if (/上传|选择文件/.test(text)) return 'upload'
  if (/等待|直到|轮询/.test(text)) return 'wait_for'
  if (/按下|回车|enter|键盘/i.test(text)) return 'press'
  if (/下拉|选择国家|选择类型|选择状态|选择选项/.test(text)) return 'select'
  if (/输入|填写|填入|清空|键入/.test(text)) return 'fill'
  if (/点击|单击|双击|点选/.test(text)) return 'click'
  if (/^(打开|进入|访问|跳转|返回)/.test(text)) return 'navigate'
  return 'manual'
}

function targetDescription(text: string, action: StepAction): string {
  const patterns: Partial<Record<StepAction, RegExp>> = {
    navigate: /^(?:打开|进入|访问|跳转到?|返回到?)\s*/,
    click: /^(?:点击|单击|双击|点选)\s*/,
    fill: /^(?:在)?\s*(?:输入|填写|填入|清空|键入)\s*/,
    select: /^(?:在)?\s*(?:下拉|选择)\s*/,
    check: /^(?:勾选|选中)\s*/,
    uncheck: /^(?:取消勾选|取消选中)\s*/,
    upload: /^(?:上传|选择文件)\s*/,
    press: /^(?:按下|按)\s*/,
    wait_for: /^(?:等待|直到)\s*/,
  }
  const cleaned = redactSensitiveText(text).replace(patterns[action] ?? /^$/, '').trim()
  return cleaned || redactSensitiveText(text)
}

function findValueRef(text: string, bindings: DataBindingIR[]): string | undefined {
  const aliases: Record<string, string[]> = {
    username: ['用户名', '账号', '用户账号'],
    user: ['用户名', '账号'],
    password: ['密码'],
    passwd: ['密码'],
    pwd: ['密码'],
    captcha: ['验证码'],
    verificationcode: ['验证码'],
    phone: ['手机号', '手机号码'],
    mobile: ['手机号', '手机号码'],
  }
  return bindings.find((binding) => {
    if (text.includes(binding.name)) return true
    const key = binding.name.toLowerCase().replace(/[^a-z0-9]/g, '')
    return (aliases[key] ?? []).some((alias) => text.includes(alias))
  })?.name
}

function extractLiteralValue(text: string): string | undefined {
  if (SENSITIVE_KEY.test(text)) return undefined
  const quoted = /[“"'‘]([^”"'’]+)[”"'’]/.exec(text)?.[1]?.trim()
  if (quoted) return redactSensitiveText(quoted)
  return undefined
}

function parseSteps(
  text: string,
  prefix: string,
  bindings: DataBindingIR[],
  diagnostics: DiagnosticBag,
  row: RawCaseRow,
  caseId: string,
  ambiguities: string[],
): StepIR[] {
  return splitNumberedItems(text).map((raw, index) => {
    const sourceText = redactSensitiveText(raw)
    const action = detectAction(sourceText)
    if (action === 'manual') {
      ambiguities.push(`步骤需要人工或 AI 解释：${sourceText}`)
      diagnostics.warning('manual_step', `无法可靠识别步骤动作：「${sourceText}」`, diagnosticContext(row, caseId))
    }
    const valueRef = findValueRef(sourceText, bindings)
    const literalValue = valueRef ? undefined : extractLiteralValue(sourceText)
    return {
      id: `${prefix}-${index + 1}`,
      action,
      targetDescription: targetDescription(sourceText, action),
      ...(valueRef ? { valueRef } : {}),
      ...(literalValue ? { literalValue } : {}),
      sourceText,
      confidence: action === 'manual' ? 0.3 : 0.85,
    }
  })
}

function expectedText(clause: string): string {
  return clause
    .replace(/^(?:页面|系统)?\s*(?:应|应该)?\s*(?:显示|展示|提示|出现|包含)\s*/, '')
    .replace(/^(?:成功)?\s*跳转到?\s*/, '')
    .trim() || clause
}

function parseAssertions(text: string, ambiguities: string[]): AssertionIR[] {
  const clauses = splitNumberedItems(text)
    .flatMap((item) => item.split(/[，,；;]+/))
    .map((item) => redactSensitiveText(item.trim()))
    .filter(Boolean)

  return clauses.map((clause, index): AssertionIR => {
    const base = {
      id: `assert-${index + 1}`,
      sourceText: clause,
      oracleSource: 'tester' as const,
      immutable: true as const,
    }
    const url = /(https?:\/\/\S+|(?<!\d)\/(?:[A-Za-z_#?][A-Za-z0-9_#?=&./-]*))/.exec(clause)?.[1]
    if (url) return { ...base, kind: 'url', operator: 'contains', expected: url, confidence: 0.95 }
    if (/无跳转/.test(clause)) {
      ambiguities.push(`断言「${clause}」需要明确允许的 URL`)
      return { ...base, kind: 'url', operator: 'equals', expected: 'UNCHANGED', confidence: 0.4 }
    }
    if (/标题/.test(clause)) return { ...base, kind: 'title', operator: 'contains', expected: expectedText(clause), confidence: 0.75 }
    if (/不显示|不可见|隐藏|无错误提示|未出现/.test(clause)) {
      const target = expectedText(clause).replace(/^(?:不|未|无)/, '')
      return { ...base, kind: 'hidden', targetDescription: target, operator: 'equals', expected: true, confidence: 0.75 }
    }
    if (/禁用|不可点击/.test(clause)) {
      return { ...base, kind: 'enabled', targetDescription: expectedText(clause), operator: 'equals', expected: false, confidence: 0.75 }
    }
    if (/启用|可点击/.test(clause)) {
      return { ...base, kind: 'enabled', targetDescription: expectedText(clause), operator: 'equals', expected: true, confidence: 0.75 }
    }
    if (/选中|勾选/.test(clause)) {
      const negated = /未选中|不应选中|不要选中|取消选中|未勾选|不应勾选|取消勾选/.test(clause)
      return { ...base, kind: 'checked', targetDescription: expectedText(clause), operator: 'equals', expected: !negated, confidence: 0.75 }
    }
    if (/跳转到|进入.+页面/.test(clause)) {
      ambiguities.push(`页面断言「${clause}」缺少具体 URL 或稳定页面标志`)
    }
    return { ...base, kind: 'text', operator: 'contains', expected: expectedText(clause), confidence: 0.7 }
  })
}

export function parseCaseParts(
  row: RawCaseRow,
  caseId: string,
  diagnostics: DiagnosticBag,
): ParsedCaseParts {
  const values = row.values
  const ambiguities: string[] = []
  const dataBindings = parseDataBindings(values.testData ?? '', diagnostics, row, caseId, ambiguities)
  const steps = parseSteps(values.steps ?? '', 'step', dataBindings, diagnostics, row, caseId, ambiguities)
  const cleanupSteps = parseSteps(values.cleanup ?? '', 'cleanup', dataBindings, diagnostics, row, caseId, ambiguities)
  const assertions = parseAssertions(values.expected ?? '', ambiguities)
  const riskResult = normalizeRisk(
    values.risk ?? '',
    `${values.steps ?? ''}\n${values.cleanup ?? ''}\n${values.title ?? ''}`,
    diagnostics,
    row,
    caseId,
  )
  if (riskResult.inferred) ambiguities.push(`风险等级暂推断为 ${riskResult.risk}`)
  if (riskResult.risk !== 'read' && cleanupSteps.length === 0) {
    diagnostics.error('cleanup_required', `${riskResult.risk} 用例必须填写清理步骤或经过人工豁免`, diagnosticContext(row, caseId))
    ambiguities.push('写入或破坏性用例缺少清理步骤')
  }

  return {
    priority: normalizePriority(values.priority ?? '', diagnostics, row, caseId),
    risk: riskResult.risk,
    riskInferred: riskResult.inferred,
    modulePath: buildModulePath(row),
    dependencies: splitList(values.dependencies ?? ''),
    tags: splitList(values.tags ?? ''),
    preconditions: splitNumberedItems(values.precondition ?? '').map(redactSensitiveText),
    dataBindings,
    steps,
    assertions,
    cleanupSteps,
    ambiguities,
  }
}
