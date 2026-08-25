import { basename, extname } from 'node:path'
import type { DiagnosticBag } from '../core/diagnostics.js'
import type { RawCaseRow, WorkbookReadResult } from '../input/xlsx.js'
import { redactSensitiveText, slugify, splitList, splitNumberedItems } from '../input/text.js'
import type { WorkflowRisk } from './types.js'

/**
 * Native standard test-case table parsing for the AgentHost intake path.
 *
 * This module is the only parser behind the standard-table branch of
 * `intakeWorkflowXlsx`. It deliberately does not build the legacy importer's
 * `TestCaseIR`: it returns only the intermediate structure the intake manifest
 * actually consumes (keyed by source row) and reports every parse problem
 * through the shared diagnostic bag, so intake keeps sole authority over which
 * diagnostics reach the intake report. Row validity, case IDs, risk, priority,
 * step and assertion wording, and diagnostic codes/messages preserve the
 * behavior the standard branch exposed through the legacy importer.
 *
 * Unlike the legacy importer + IR schema path, this parser does not emit IR
 * `schema_validation` diagnostics (including the former non-`/cases`
 * `uniqueItems` findings for duplicate dependencies or labels). Plaintext
 * sensitive-value probing is no longer a schema concern here; neutral fields
 * are redacted in this module and test-data/instruction text is further
 * handled by `sanitizeText` during intake.
 */

/** Upper bound of valid cases one workbook may contribute; rows past the cap stay in intake as fallback phases. */
export const STANDARD_TABLE_CASE_LIMIT = 10_000

export interface StandardTableSecretBinding {
  name: string
  secretRef: string
}

export interface StandardTableCase {
  sourceRow: number
  id: string
  risk: WorkflowRisk
  preconditions: string[]
  modulePath: string[]
  dependencies: string[]
  secretDataBindings: StandardTableSecretBinding[]
  hasCleanupSteps: boolean
  ambiguities: string[]
}

export interface StandardTableParseResult {
  workflowId: string
  source: {
    fileName: string
    sheetName: string
    sha256: string
  }
  casesBySourceRow: Map<number, StandardTableCase>
}

export interface StandardTableParseOptions {
  filePath: string
  sha256: string
  workbook: WorkbookReadResult
  diagnostics: DiagnosticBag
}

const RECOGNIZED_PRIORITIES = new Set(['P0', '0', '高', 'HIGH', '1', 'P1', '中', 'MEDIUM', '2', 'P2', '低', 'LOW', '3', 'P3', '4'])
const ASSERTION_URL_PATTERN = /(https?:\/\/\S+|(?<!\d)\/(?:[A-Za-z_#?][A-Za-z0-9_#?=&./-]*))/

function diagnosticContext(row: RawCaseRow, caseId: string): { sheet: string; row: number; caseId: string } {
  return { sheet: row.sheetName, row: row.sourceRow, caseId }
}

function requiredValue(
  value: string | undefined,
  label: string,
  code: string,
  diagnostics: DiagnosticBag,
  row: RawCaseRow,
  caseId?: string,
): string | null {
  if (value?.trim()) return value.trim()
  diagnostics.error(code, `${label}不能为空`, caseId ? diagnosticContext(row, caseId) : { sheet: row.sheetName, row: row.sourceRow })
  return null
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

/**
 * Extract the `${secret:...}` test-data references intake can bind. Generated
 * values, literals and plaintext-sensitive values never enter the manifest, so
 * they only keep their binding name slot to preserve legacy name allocation
 * (a repeated name still shifts later bindings to `name-2`, `name-3`, ...).
 */
function parseSecretDataBindings(
  text: string,
  diagnostics: DiagnosticBag,
  row: RawCaseRow,
  caseId: string,
): StandardTableSecretBinding[] {
  if (!text.trim()) return []
  const segments = text.split(/[\n,，;；]+/).map((segment) => segment.trim()).filter(Boolean)
  const bindings: StandardTableSecretBinding[] = []
  const used = new Set<string>()
  for (const segment of segments) {
    const match = /^([^:=：]+?)\s*[:=：]\s*(.+)$/.exec(segment)
    if (!match) {
      diagnostics.warning('test_data_unparsed', '存在无法解析为 key=value 的测试数据片段', diagnosticContext(row, caseId))
      continue
    }
    const rawName = match[1]?.trim() ?? ''
    const rawValue = match[2]?.trim() ?? ''
    if (!rawName || !rawValue) continue
    const name = uniqueBindingName(rawName, used)
    const secretRef = /^\$\{secret:([^}]+)}$/.exec(rawValue)?.[1]?.trim()
    if (secretRef && !secretRef.startsWith('unresolved.')) bindings.push({ name, secretRef })
  }
  return bindings
}

/** Step action vocabulary intake needs: whether a step source text describes a recognizable action or needs human/AI interpretation. */
function isRecognizedStepAction(text: string): boolean {
  if (/取消勾选|取消选中/.test(text)) return true
  if (/勾选|选中复选/.test(text)) return true
  if (/上传|选择文件/.test(text)) return true
  if (/等待|直到|轮询/.test(text)) return true
  if (/按下|回车|enter|键盘/i.test(text)) return true
  if (/下拉|选择国家|选择类型|选择状态|选择选项/.test(text)) return true
  if (/输入|填写|填入|清空|键入/.test(text)) return true
  if (/点击|单击|双击|点选/.test(text)) return true
  if (/^(打开|进入|访问|跳转|返回)/.test(text)) return true
  return false
}

function stepTexts(
  text: string,
  diagnostics: DiagnosticBag,
  row: RawCaseRow,
  caseId: string,
  ambiguities: string[],
): string[] {
  return splitNumberedItems(text).map((raw) => {
    const sourceText = redactSensitiveText(raw)
    if (!isRecognizedStepAction(sourceText)) {
      ambiguities.push(`步骤需要人工或 AI 解释：${sourceText}`)
      diagnostics.warning('manual_step', `无法可靠识别步骤动作：「${sourceText}」`, diagnosticContext(row, caseId))
    }
    return sourceText
  })
}

function assertionClauses(text: string, ambiguities: string[]): string[] {
  const clauses = splitNumberedItems(text)
    .flatMap((item) => item.split(/[，,；;]+/))
    .map((item) => redactSensitiveText(item.trim()))
    .filter(Boolean)
  for (const clause of clauses) {
    if (ASSERTION_URL_PATTERN.test(clause)) continue
    if (/无跳转/.test(clause)) {
      ambiguities.push(`断言「${clause}」需要明确允许的 URL`)
      continue
    }
    if (/标题|不显示|不可见|隐藏|无错误提示|未出现|禁用|不可点击|启用|可点击|选中|勾选/.test(clause)) continue
    if (/跳转到|进入.+页面/.test(clause)) ambiguities.push(`页面断言「${clause}」缺少具体 URL 或稳定页面标志`)
  }
  return clauses
}

function inferRisk(text: string): WorkflowRisk {
  if (/删除|强制停止|强停|关停|结算|支付|发布|退款|注销|下线|清空数据|停用/.test(text)) return 'destructive'
  if (/新增|创建|添加|编辑|修改|保存|提交|上传|绑定|解绑|注册|启动设备|停止设备|开始充电|启动充电|发送|导入/.test(text)) return 'write'
  return 'read'
}

function normalizeRisk(
  raw: string,
  behaviorText: string,
  diagnostics: DiagnosticBag,
  row: RawCaseRow,
  caseId: string,
): { risk: WorkflowRisk; inferred: boolean } {
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

/** Priority itself never reaches the manifest; only its normalization diagnostics stay part of the intake report. */
function reportPriority(raw: string, diagnostics: DiagnosticBag, row: RawCaseRow, caseId: string): void {
  const value = raw.trim().toUpperCase()
  if (RECOGNIZED_PRIORITIES.has(value)) return
  if (value) diagnostics.warning('priority_unknown', `无法识别优先级「${raw}」，使用 P2`, diagnosticContext(row, caseId))
  else diagnostics.warning('priority_defaulted', '未填写优先级，使用 P2', diagnosticContext(row, caseId))
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

interface ParsedStandardRow {
  steps: string[]
  cleanupSteps: string[]
  assertionCount: number
  risk: WorkflowRisk
  preconditions: string[]
  modulePath: string[]
  dependencies: string[]
  secretDataBindings: StandardTableSecretBinding[]
  ambiguities: string[]
}

function parseStandardRow(row: RawCaseRow, caseId: string, diagnostics: DiagnosticBag): ParsedStandardRow {
  const values = row.values
  const ambiguities: string[] = []
  const secretDataBindings = parseSecretDataBindings(values.testData ?? '', diagnostics, row, caseId)
  const steps = stepTexts(values.steps ?? '', diagnostics, row, caseId, ambiguities)
  const cleanupSteps = stepTexts(values.cleanup ?? '', diagnostics, row, caseId, ambiguities)
  const assertionCount = assertionClauses(values.expected ?? '', ambiguities).length
  const risk = normalizeRisk(
    values.risk ?? '',
    `${values.steps ?? ''}\n${values.cleanup ?? ''}\n${values.title ?? ''}`,
    diagnostics,
    row,
    caseId,
  )
  if (risk.inferred) ambiguities.push(`风险等级暂推断为 ${risk.risk}`)
  if (risk.risk !== 'read' && cleanupSteps.length === 0) {
    diagnostics.error('cleanup_required', `${risk.risk} 用例必须填写清理步骤或经过人工豁免`, diagnosticContext(row, caseId))
    ambiguities.push('写入或破坏性用例缺少清理步骤')
  }
  reportPriority(values.priority ?? '', diagnostics, row, caseId)
  return {
    steps,
    cleanupSteps,
    assertionCount,
    risk: risk.risk,
    // Neutral fields are redacted before they can become manifest resources.
    preconditions: splitNumberedItems(values.precondition ?? '').map(redactSensitiveText),
    modulePath: buildModulePath(row).map(redactSensitiveText),
    dependencies: splitList(values.dependencies ?? '').map(redactSensitiveText),
    secretDataBindings,
    ambiguities,
  }
}

export function parseStandardTableCases(options: StandardTableParseOptions): StandardTableParseResult {
  const { filePath, sha256, workbook, diagnostics } = options
  const casesBySourceRow = new Map<number, StandardTableCase>()
  const seenIds = new Set<string>()
  let validCases = 0
  let invalidRows = 0
  for (const row of workbook.rows) {
    if (validCases >= STANDARD_TABLE_CASE_LIMIT) break
    const rawId = requiredValue(row.values.caseId, '用例ID', 'case_id_missing', diagnostics, row)
    const caseId = rawId ? redactSensitiveText(rawId) : null
    const title = requiredValue(row.values.title, '用例标题', 'title_missing', diagnostics, row, caseId ?? undefined)
    const stepsText = requiredValue(row.values.steps, '测试步骤', 'steps_missing', diagnostics, row, caseId ?? undefined)
    const expectedText = requiredValue(row.values.expected, '预期结果', 'expected_missing', diagnostics, row, caseId ?? undefined)
    if (!caseId || !title || !stepsText || !expectedText) {
      invalidRows += 1
      continue
    }
    if (seenIds.has(caseId)) {
      diagnostics.error('duplicate_case_id', `用例ID「${caseId}」重复`, diagnosticContext(row, caseId))
      invalidRows += 1
      continue
    }
    seenIds.add(caseId)
    const parsed = parseStandardRow(row, caseId, diagnostics)
    if (parsed.steps.length === 0) {
      diagnostics.error('steps_empty_after_parse', '测试步骤解析后为空', diagnosticContext(row, caseId))
      invalidRows += 1
      continue
    }
    if (parsed.assertionCount === 0) {
      diagnostics.error('assertions_empty_after_parse', '预期结果解析后没有产生断言', diagnosticContext(row, caseId))
      invalidRows += 1
      continue
    }
    validCases += 1
    casesBySourceRow.set(row.sourceRow, {
      sourceRow: row.sourceRow,
      id: caseId,
      risk: parsed.risk,
      preconditions: parsed.preconditions,
      modulePath: parsed.modulePath,
      dependencies: parsed.dependencies,
      secretDataBindings: parsed.secretDataBindings,
      hasCleanupSteps: parsed.cleanupSteps.length > 0,
      ambiguities: parsed.ambiguities,
    })
  }
  const processedRows = validCases + invalidRows
  const skippedByLimit = Math.max(0, workbook.rows.length - processedRows)
  if (skippedByLimit > 0) {
    // Message kept verbatim from the legacy importer so intake reports stay stable across the migration.
    diagnostics.info('case_limit_applied', `MVP 单次最多导入 ${STANDARD_TABLE_CASE_LIMIT} 条有效用例，其余行未处理`)
  }
  const fileName = basename(filePath)
  return {
    workflowId: `${slugify(basename(fileName, extname(fileName)))}-${sha256.slice(0, 8)}`,
    source: { fileName, sheetName: workbook.sheetName ?? '', sha256 },
    casesBySourceRow,
  }
}
