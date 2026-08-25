import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { read, utils, type WorkBook, type WorkSheet } from '@e965/xlsx'
import { DiagnosticBag } from '../core/diagnostics.js'
import { readWorkbookCases, type RawCaseRow, type WorkbookReadResult } from '../input/xlsx.js'
import { normalizeText, redactSensitiveContent, slugify, splitNumberedItems } from '../input/text.js'
import { parseStandardTableCases } from './standard-table.js'
import type {
  WorkflowCapability,
  WorkflowFailureMode,
  WorkflowIntakeManifest,
  WorkflowIntakeResult,
  WorkflowPhaseDraft,
  WorkflowResource,
  WorkflowRisk,
  WorkflowSecretBinding,
  WorkflowSupplementalImage,
} from './types.js'
import { extractWpsCellImages, mediaTypeForPath, type FormulaImageCell } from './xlsx-media.js'
import { extractWorkflowUrls as extractUrls, normalizeWorkflowUrl as normalizeUrl } from './target-urls.js'

export interface WorkflowIntakeOptions {
  filePath: string
  sheetName?: string
  additionalUrls?: string[]
  supplementalImagePaths?: string[]
}

interface SourceCell {
  address: string
  row: number
  text: string
}

interface SourcePhase {
  sheetName: string
  sourceRow: number
  title: SourceCell
  instruction: SourceCell
  resources: SourceCell[]
}

interface SanitizedText {
  text: string
  bindings: WorkflowSecretBinding[]
  secretMaterial: Record<string, string | string[]>
}

const phonePattern = /\+?65[\s-]?\d{8}\b/g
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const credentialPattern = /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\/([^\s,，;；]+)/i
const labeledCredentialPattern = /(?:账号|用户名|user(?:name)?)\s*[:：]?\s*([^\s,，;；]+)[\s,，;；]*(?:密码|password|passwd|pwd)\s*[:：]?\s*([^\s,，;；]+)/gi
const combinedCredentialPattern = /(?:账号密码|用户名密码|登录凭据|credentials?)\s*[:：]?\s*([^\s,，;；/]+)\s*[,，;；/]\s*([^\s,，;；]+)/gi
const verificationPattern = /(验证码|verification\s*code)\s*[‘'"：:]?\s*([A-Za-z0-9]{4,8})\s*[’'"]?/gi

function formulaId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.match(/DISPIMG\("([^"]+)"/i)?.[1]
}

function formulaImageCells(workbook: WorkBook): FormulaImageCell[] {
  const cells: FormulaImageCell[] = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue
    for (const [address, value] of Object.entries(sheet)) {
      if (address.startsWith('!')) continue
      const cell = value as { f?: string; v?: unknown }
      const id = formulaId(cell.f) ?? formulaId(cell.v)
      if (!id) continue
      cells.push({ formulaId: id, sheetName, sourceCell: address, sourceRow: utils.decode_cell(address).r + 1 })
    }
  }
  return cells
}

function cellText(sheet: WorkSheet, address: string): string {
  const cell = sheet[address] as { w?: string; v?: unknown; f?: string } | undefined
  if (!cell || formulaId(cell.f) || formulaId(cell.v)) return ''
  return normalizeText(cell.w ?? cell.v)
}

function phasesFromSheet(sheetName: string, sheet: WorkSheet): SourcePhase[] {
  if (!sheet['!ref']) return []
  const range = utils.decode_range(sheet['!ref'])
  const phases: SourcePhase[] = []
  for (let row = range.s.r; row <= range.e.r; row++) {
    const values: SourceCell[] = []
    for (let column = range.s.c; column <= range.e.c; column++) {
      const address = utils.encode_cell({ r: row, c: column })
      const value = cellText(sheet, address)
      if (value) values.push({ address, row: row + 1, text: value })
    }
    if (values.length < 2) continue
    phases.push({
      sheetName,
      sourceRow: row + 1,
      title: values[0]!,
      instruction: values[1]!,
      resources: values.slice(2),
    })
  }
  return phases
}

function addBinding(bindings: WorkflowSecretBinding[], phaseId: string, suffix: string, purpose: string, sourceCell: string): string {
  const secretRef = `workflow.${phaseId}.${suffix}`
  if (!bindings.some((binding) => binding.secretRef === secretRef)) {
    bindings.push({ name: suffix, secretRef, purpose, sourceCell })
  }
  return `\${secret:${secretRef}}`
}

function assignSecretMaterial(
  target: Record<string, string | string[]>,
  source: Record<string, string | string[]>,
  label: string,
): void {
  for (const [secretRef, value] of Object.entries(source)) {
    const previous = target[secretRef]
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value)) {
      throw new Error(`${label} 为 secretRef ${secretRef} 提供了冲突值`)
    }
    target[secretRef] = value
  }
}

function sanitizeText(value: string, phaseId: string, sourceCell: string): SanitizedText {
  const bindings: WorkflowSecretBinding[] = []
  const secretMaterial: Record<string, string | string[]> = {}
  let safe = value
  safe = safe.replace(combinedCredentialPattern, (match, rawUsername: string, rawPassword: string) => {
    if (rawUsername.includes('${secret:') || rawPassword.includes('${secret:')) return match
    const username = addBinding(bindings, phaseId, 'username', '登录用户名', sourceCell)
    const password = addBinding(bindings, phaseId, 'password', '登录密码', sourceCell)
    secretMaterial[`workflow.${phaseId}.username`] = rawUsername
    secretMaterial[`workflow.${phaseId}.password`] = rawPassword
    return `账号：${username} 密码：${password}`
  })
  safe = safe.replace(labeledCredentialPattern, (match, rawUsername: string, rawPassword: string) => {
    if (rawUsername.includes('${secret:') || rawPassword.includes('${secret:')) return match
    const username = addBinding(bindings, phaseId, 'username', '登录用户名', sourceCell)
    const password = addBinding(bindings, phaseId, 'password', '登录密码', sourceCell)
    secretMaterial[`workflow.${phaseId}.username`] = rawUsername
    secretMaterial[`workflow.${phaseId}.password`] = rawPassword
    return `账号：${username} 密码：${password}`
  })
  safe = safe.replace(credentialPattern, (match, rawUsername: string, rawPassword: string) => {
    if (rawUsername.includes('${secret:') || rawPassword.includes('${secret:')) return match
    const username = addBinding(bindings, phaseId, 'username', '登录用户名', sourceCell)
    const password = addBinding(bindings, phaseId, 'password', '登录密码', sourceCell)
    secretMaterial[`workflow.${phaseId}.username`] = rawUsername
    secretMaterial[`workflow.${phaseId}.password`] = rawPassword
    return `${username}/${password}`
  })
  if (phonePattern.test(safe)) {
    phonePattern.lastIndex = 0
    const phoneNumbers = [...new Set((safe.match(phonePattern) ?? []).map((phone) => phone.replace(/[\s-]/g, '')))]
    phonePattern.lastIndex = 0
    const reference = addBinding(bindings, phaseId, 'phoneNumbers', '循环执行的手机号列表', sourceCell)
    secretMaterial[`workflow.${phaseId}.phoneNumbers`] = phoneNumbers
    safe = safe.replace(phonePattern, reference)
  }
  phonePattern.lastIndex = 0
  safe = safe.replace(verificationPattern, (_match, label: string, code: string) => {
    const reference = addBinding(bindings, phaseId, 'verificationCode', '测试验证码', sourceCell)
    secretMaterial[`workflow.${phaseId}.verificationCode`] = code
    return `${label}${reference}`
  })
  safe = redactSensitiveContent(safe).replace(emailPattern, '<redacted-email>')
  return { text: safe, bindings, secretMaterial }
}

function instructionParts(value: string): { summary?: string; steps: string[] } {
  const marker = value.match(/\d{1,3}\s*[.、．)）]/)
  if (!marker || marker.index === undefined) return { steps: [value] }
  const summary = value.slice(0, marker.index).replace(/[（(]\s*$/, '').trim()
  const numbered = value.slice(marker.index).replace(/[）)]\s*$/, '').trim()
  const steps = splitNumberedItems(numbered)
  return {
    ...(summary ? { summary } : {}),
    steps: steps.length ? steps : [numbered],
  }
}

/**
 * Default allowable failure modes for an outcome. Mutation cleanup is only a
 * legitimate classification for cases that can write; read-only cases never
 * carry it. The remaining seven modes apply to every live-UI case.
 */
function failureModesFor(risk: WorkflowRisk): WorkflowFailureMode[] {
  const modes: WorkflowFailureMode[] = [
    'input',
    'authentication',
    'environment',
    'locator_navigation',
    'business_assertion',
    'agent_execution',
    'infrastructure',
  ]
  if (risk !== 'read') modes.push('mutation_cleanup')
  return modes
}

function riskFor(value: string): WorkflowRisk {
  if (/(删除|清空|重置|回滚|撤销|终止|停止|关停|强制|结算|支付|退款|remove|delete|reset|rollback|force\s*stop|settlement)/i.test(value)) return 'destructive'
  if (/(保存|提交|创建|新增|修改|编辑|启用|禁用|启动|开始|上传|导入|发布|审核|授权|触发|执行|登录|save|submit|create|update|edit|enable|disable|start|upload|import|publish|approve)/i.test(value)) return 'write'
  return 'read'
}

function explicitRisk(value: string | undefined): WorkflowRisk | undefined {
  const normalized = normalizeText(value).toLowerCase()
  if (['read', '只读', '读取'].includes(normalized)) return 'read'
  if (['write', '写入', '修改'].includes(normalized)) return 'write'
  if (['destructive', '破坏性', '高风险'].includes(normalized)) return 'destructive'
  return undefined
}

function uniquePhaseId(rawCaseId: string, sourceRow: number, usedIds: Set<string>): string {
  const normalized = normalizeText(rawCaseId)
  const base = normalized ? slugify(normalized) : `row-${sourceRow}`
  if (!usedIds.has(base)) {
    usedIds.add(base)
    return base
  }
  let candidate = `${base}-row-${sourceRow}`
  let suffix = 2
  while (usedIds.has(candidate)) candidate = `${base}-row-${sourceRow}-${suffix++}`
  usedIds.add(candidate)
  return candidate
}

function sourceRowLabel(row: RawCaseRow): string {
  return row.values.caseId?.trim() || `row-${row.sourceRow}`
}

function fallbackPhaseFromRow(
  row: RawCaseRow,
  workbook: WorkbookReadResult,
  phaseId: string,
  embeddedAssets: ReturnType<typeof extractWpsCellImages>,
  diagnostics: DiagnosticBag,
): { phase: WorkflowPhaseDraft; secretMaterial: Record<string, string | string[]> } {
  const sourceRow = row.sourceRow
  const sourceCaseId = row.values.caseId?.trim() || undefined
  const cells = {
    title: cellAddress(workbook, 'title', sourceRow),
    steps: cellAddress(workbook, 'steps', sourceRow),
    expected: cellAddress(workbook, 'expected', sourceRow),
    precondition: cellAddress(workbook, 'precondition', sourceRow),
    testData: cellAddress(workbook, 'testData', sourceRow),
    cleanup: cellAddress(workbook, 'cleanup', sourceRow),
  }
  const title = sanitizeText(row.values.title ?? '', phaseId, cells.title)
  const steps = sanitizeText(row.values.steps ?? '', phaseId, cells.steps)
  const expected = sanitizeText(row.values.expected ?? '', phaseId, cells.expected)
  const precondition = sanitizeText(row.values.precondition ?? '', phaseId, cells.precondition)
  const testData = sanitizeText(row.values.testData ?? '', phaseId, cells.testData)
  const cleanup = sanitizeText(row.values.cleanup ?? '', phaseId, cells.cleanup)
  const secretMaterial: Record<string, string | string[]> = {}
  for (const [label, material] of [
    [cells.title, title.secretMaterial],
    [cells.steps, steps.secretMaterial],
    [cells.expected, expected.secretMaterial],
    [cells.precondition, precondition.secretMaterial],
    [cells.testData, testData.secretMaterial],
    [cells.cleanup, cleanup.secretMaterial],
  ] as Array<[string, Record<string, string | string[]>]>) assignSecretMaterial(secretMaterial, material, `单元格 ${label}`)
  const bindings = [...new Map([
    ...title.bindings,
    ...steps.bindings,
    ...expected.bindings,
    ...precondition.bindings,
    ...testData.bindings,
    ...cleanup.bindings,
  ].map((binding) => [binding.secretRef, binding])).values()]
  const missingFields: Array<[string, string]> = [
    !row.values.title?.trim() ? ['title_missing', '用例标题'] : undefined,
    !row.values.steps?.trim() ? ['steps_missing', '测试步骤'] : undefined,
    !row.values.expected?.trim() ? ['expected_missing', '预期结果'] : undefined,
  ].filter((item): item is [string, string] => Boolean(item))
  for (const [code, label] of missingFields) diagnostics.warning(code, `${label}为空；该来源行将保留并交由 Codex 判断`, {
    sheet: row.sheetName,
    row: sourceRow,
    ...(sourceCaseId ? { caseId: sourceCaseId } : {}),
  })
  const raw = Object.values(row.values).filter(Boolean).join('\n')
  const imageIds = embeddedAssets.filter((asset) => asset.metadata.sourceRow === sourceRow).map((asset) => asset.metadata.id)
  const ambiguities = missingFields.map(([, label]) => `来源行缺少${label}`)
  if (imageIds.length > 0) ambiguities.push('内嵌图片需要 Codex 结合原始视觉证据确认其操作语义')
  const resources: WorkflowResource[] = [
    ...(precondition.text ? [{ sourceCell: cells.precondition, text: `前置条件：${precondition.text}`, urls: extractUrls(precondition.text) }] : []),
    ...(testData.text ? [{ sourceCell: cells.testData, text: `测试数据：${testData.text}`, urls: extractUrls(testData.text) }] : []),
    { sourceCell: cells.expected, text: `预期结果：${expected.text}`, urls: extractUrls(expected.text) },
    ...(cleanup.text ? [{ sourceCell: cells.cleanup, text: `清理步骤：${cleanup.text}`, urls: extractUrls(cleanup.text) }] : []),
  ]
  return {
    phase: {
      id: phaseId,
      ...(sourceCaseId ? { sourceCaseId } : {}),
      title: title.text || `来源第 ${sourceRow} 行（${sourceRowLabel(row)}）`,
      sourceRow,
      risk: explicitRisk(row.values.risk) ?? riskFor(raw),
      ...(precondition.text ? { summary: precondition.text } : {}),
      outcome: {
        action: splitNumberedItems(steps.text),
        observable: expected.text ? splitNumberedItems(expected.text) : [],
        evidence: ['interaction', 'observation'],
        cleanup: cleanup.text ? splitNumberedItems(cleanup.text) : [],
        failureModes: failureModesFor(explicitRisk(row.values.risk) ?? riskFor(raw)),
      },
      steps: splitNumberedItems(steps.text).map((step, index) => ({ id: `${phaseId}-step-${index + 1}`, sourceText: step, confidence: 0.5 })),
      resources,
      secretBindings: bindings,
      imageIds,
      review: { status: 'draft', ambiguities },
    },
    secretMaterial,
  }
}

function capabilitiesFor(phases: SourcePhase[], urls: string[], imageCount: number, risks: WorkflowRisk[]): WorkflowCapability[] {
  const text = phases.flatMap((phase) => [phase.title.text, phase.instruction.text, ...phase.resources.map((item) => item.text)]).join('\n')
  const capabilities = new Set<WorkflowCapability>()
  if (imageCount) capabilities.add('embeddedImageUnderstanding')
  if (urls.length > 1) capabilities.add('multiOrigin')
  if (/(多账户|每个手机号|清空缓存|清理.*缓存|from scratch|fresh.*context)/i.test(text)) capabilities.add('freshBrowserContextPerIteration')
  if (/(最新.*订单|匹配.*订单|关联.*订单|order\s*id|用户手机号.*订单)/i.test(text)) capabilities.add('runtimeEntityCapture')
  if (/(验证码|verification\s*code|captcha)/i.test(text)) capabilities.add('otpOrCaptcha')
  if (/(插枪|拔枪|物理|connector)/i.test(text)) capabilities.add('externalPhysicalState')
  if (risks.includes('destructive')) capabilities.add('destructiveApproval')
  if (/(随机时间窗|等待.*分钟|延迟|schedule)/i.test(text)) capabilities.add('scheduledWait')
  return [...capabilities]
}

async function supplementalImage(path: string): Promise<{ metadata: WorkflowSupplementalImage; content: Buffer }> {
  const content = await readFile(path)
  const extension = extname(path).toLowerCase()
  if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)) throw new Error(`不支持补充图片格式：${basename(path)}`)
  if (content.byteLength > 10 * 1024 * 1024) throw new Error(`补充图片超过 10 MB 上限：${basename(path)}`)
  const sha256 = createHash('sha256').update(content).digest('hex')
  return {
    metadata: {
      id: `supplemental-${slugify(basename(path, extension))}-${sha256.slice(0, 8)}`,
      sourceKind: 'supplemental',
      fileName: basename(path),
      mediaType: mediaTypeForPath(path),
      bytes: content.byteLength,
      sha256,
      reviewStatus: 'required',
    },
    content,
  }
}

function cellAddress(workbook: WorkbookReadResult, column: keyof WorkbookReadResult['headerMap'], row: number): string {
  const index = workbook.headerMap[column]?.column
  return index ? `${utils.encode_col(index - 1)}${row}` : `row:${row}`
}

function intakeResult(
  value: Omit<WorkflowIntakeResult, 'secretMaterial'>,
  secretMaterial: WorkflowIntakeResult['secretMaterial'],
): WorkflowIntakeResult {
  const result = value as WorkflowIntakeResult
  Object.defineProperty(result, 'secretMaterial', {
    value: secretMaterial,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return result
}

async function intakeStandardTestCases(
  options: WorkflowIntakeOptions,
  workbook: WorkbookReadResult,
  detectionDiagnostics: DiagnosticBag,
  embeddedAssets: ReturnType<typeof extractWpsCellImages>,
  sourceSha256: string,
): Promise<WorkflowIntakeResult> {
  const targetUrls = [...new Set([
    ...(options.additionalUrls ?? []).map(normalizeUrl).filter((item): item is string => Boolean(item)),
    ...workbook.rows.flatMap((row) => Object.values(row.values).flatMap((value) => extractUrls(value ?? ''))),
  ])]
  if (targetUrls.length === 0) throw new Error('标准测试用例工作流至少需要一个目标 URL')
  const parseDiagnostics = new DiagnosticBag()
  const standard = parseStandardTableCases({
    filePath: options.filePath,
    sha256: sourceSha256,
    workbook,
    diagnostics: parseDiagnostics,
  })
  const diagnostics = new DiagnosticBag()
  const seenDiagnostics = new Set<string>()
  const caseLocalDiagnostics = new Set([
    'case_id_missing',
    'title_missing',
    'steps_missing',
    'expected_missing',
    'steps_empty_after_parse',
    'assertions_empty_after_parse',
    'duplicate_case_id',
    'cleanup_required',
  ])
  for (const item of [...detectionDiagnostics.items, ...parseDiagnostics.items]) {
    const key = JSON.stringify(item)
    if (seenDiagnostics.has(key)) continue
    seenDiagnostics.add(key)
    if (item.code === 'plaintext_secret') continue
    diagnostics.items.push(caseLocalDiagnostics.has(item.code) && item.severity === 'error'
      ? { ...item, severity: 'warning' }
      : item)
  }
  for (const asset of embeddedAssets) {
    diagnostics.warning('embedded_image_review_required', `单元格 ${asset.metadata.sourceCell} 包含内嵌图片，必须完成视觉语义审核`, {
      sheet: asset.metadata.sheetName,
      row: asset.metadata.sourceRow,
      column: asset.metadata.sourceCell.replace(/\d+$/, ''),
    })
  }
  const casesBySourceRow = standard.casesBySourceRow
  const secretMaterial: Record<string, string | string[]> = {}
  const phaseIds = new Set<string>()
  const sourceCaseIds = new Set<string>()
  const phases = workbook.rows.map((source): WorkflowPhaseDraft => {
    const sourceRow = source.sourceRow
    const testCase = casesBySourceRow.get(sourceRow)
    const phaseId = uniquePhaseId(source.values.caseId ?? '', sourceRow, phaseIds)
    const sourceCaseId = source.values.caseId?.trim() || undefined
    if (sourceCaseId && sourceCaseIds.has(sourceCaseId)) {
      diagnostics.warning('duplicate_case_id', `用例ID「${sourceCaseId}」重复，已按来源行建立独立 case`, {
        sheet: source.sheetName,
        row: sourceRow,
        caseId: sourceCaseId,
      })
    }
    if (sourceCaseId) sourceCaseIds.add(sourceCaseId)
    if (!testCase) {
      const fallback = fallbackPhaseFromRow(source, workbook, phaseId, embeddedAssets, diagnostics)
      assignSecretMaterial(secretMaterial, fallback.secretMaterial, `来源行 ${sourceRow}`)
      return fallback.phase
    }
    const dataCell = cellAddress(workbook, 'testData', sourceRow)
    const expectedCell = cellAddress(workbook, 'expected', sourceRow)
    const preconditionCell = cellAddress(workbook, 'precondition', sourceRow)
    const titleCell = cellAddress(workbook, 'title', sourceRow)
    const stepsCell = cellAddress(workbook, 'steps', sourceRow)
    const cleanupCell = cellAddress(workbook, 'cleanup', sourceRow)
    const title = sanitizeText(source.values.title ?? '', phaseId, titleCell)
    const steps = sanitizeText(source.values.steps ?? '', phaseId, stepsCell)
    const cleanup = sanitizeText(source.values.cleanup ?? '', phaseId, cleanupCell)
    const data = sanitizeText(source.values.testData ?? '', phaseId, dataCell)
    const expected = sanitizeText(source.values.expected ?? '', phaseId, expectedCell)
    const preconditions = sanitizeText(source.values.precondition ?? '', phaseId, preconditionCell)
    for (const [label, material] of [
      [titleCell, title.secretMaterial],
      [stepsCell, steps.secretMaterial],
      [cleanupCell, cleanup.secretMaterial],
      [dataCell, data.secretMaterial],
      [expectedCell, expected.secretMaterial],
      [preconditionCell, preconditions.secretMaterial],
    ] as Array<[string, Record<string, string | string[]>]>) {
      assignSecretMaterial(secretMaterial, material, `单元格 ${label}`)
    }
    const explicitBindings: WorkflowSecretBinding[] = testCase.secretDataBindings.map((binding) => ({
      name: binding.name,
      secretRef: binding.secretRef,
      purpose: `测试数据：${binding.name}`,
      sourceCell: dataCell,
    }))
    const secretBindings = [...new Map(
      [
        ...title.bindings,
        ...steps.bindings,
        ...cleanup.bindings,
        ...data.bindings,
        ...expected.bindings,
        ...preconditions.bindings,
        ...explicitBindings,
      ].map((binding) => [binding.secretRef, binding]),
    ).values()]
    for (const binding of secretBindings) {
      diagnostics.warning('secret_moved_to_reference', `单元格 ${binding.sourceCell} 的${binding.purpose}已转换为 secretRef`, {
        ...(source.sheetName ? { sheet: source.sheetName } : {}),
        row: sourceRow,
        column: binding.sourceCell.replace(/\d+$/, ''),
        caseId: sourceCaseId ?? testCase.id,
      })
    }
    const resources: WorkflowResource[] = [
      ...(testCase.modulePath.length ? [{
        sourceCell: cellAddress(workbook, 'module', sourceRow),
        text: `模块路径：${testCase.modulePath.join(' > ')}`,
        urls: [],
      }] : []),
      ...(preconditions.text ? [{ sourceCell: preconditionCell, text: `前置条件：${preconditions.text}`, urls: extractUrls(preconditions.text) }] : []),
      ...(data.text ? [{ sourceCell: dataCell, text: `测试数据：${data.text}`, urls: extractUrls(data.text) }] : []),
      { sourceCell: expectedCell, text: `预期结果：${expected.text}`, urls: extractUrls(expected.text) },
      ...(cleanup.text ? [{ sourceCell: cleanupCell, text: `清理步骤：${cleanup.text}`, urls: extractUrls(cleanup.text) }] : []),
      ...(testCase.dependencies.length ? [{
        sourceCell: cellAddress(workbook, 'dependencies', sourceRow),
        text: `依赖用例：${testCase.dependencies.join(', ')}`,
        urls: [],
      }] : []),
    ]
    const ambiguities = testCase.ambiguities.map((item) => redactSensitiveContent(item))
    const imageIds = embeddedAssets.filter((asset) => asset.metadata.sourceRow === sourceRow).map((asset) => asset.metadata.id)
    if (imageIds.length > 0) ambiguities.push('内嵌图片需要 AI 或测试工程师确认其操作语义')
    if (testCase.risk !== 'read' && !testCase.hasCleanupSteps) {
      ambiguities.push('写入用例没有源测试用例提供的清理步骤；自动执行前必须建立可验证恢复契约')
    }
    return {
      id: phaseId,
      ...(sourceCaseId ? { sourceCaseId } : {}),
      title: title.text || `来源第 ${sourceRow} 行（${sourceRowLabel(source)}）`,
      sourceRow,
      risk: explicitRisk(source.values.risk) ?? testCase.risk,
      ...(testCase.preconditions.length ? { summary: testCase.preconditions.join('；') } : {}),
      outcome: {
        action: splitNumberedItems(steps.text),
        observable: expected.text ? splitNumberedItems(expected.text) : [],
        evidence: ['interaction', 'observation'],
        cleanup: cleanup.text ? splitNumberedItems(cleanup.text) : [],
        failureModes: failureModesFor(explicitRisk(source.values.risk) ?? testCase.risk),
      },
      steps: splitNumberedItems(steps.text).map((step, index) => ({ id: `${phaseId}-step-${index + 1}`, sourceText: step, confidence: 0.85 })),
      resources,
      secretBindings,
      imageIds,
      review: { status: 'draft', ambiguities },
    }
  })
  const supplementalAssets = await Promise.all((options.supplementalImagePaths ?? []).map(supplementalImage))
  const capabilities = new Set<WorkflowCapability>()
  if (targetUrls.length > 1) capabilities.add('multiOrigin')
  if (embeddedAssets.length || supplementalAssets.length) capabilities.add('embeddedImageUnderstanding')
  const sourceText = phases.flatMap((phase) => [phase.title, ...phase.steps.map((step) => step.sourceText), ...phase.resources.map((resource) => resource.text)]).join('\n')
  if (/验证码|captcha|verification\s*code/i.test(sourceText)) capabilities.add('otpOrCaptcha')
  if (/设备.*在线|模拟|socket|websocket|ip\s*端口/i.test(sourceText)) capabilities.add('externalPhysicalState')
  if (phases.some((phase) => phase.risk === 'destructive')) capabilities.add('destructiveApproval')
  const reviewReasons = [
    '标准测试用例表已按源行完整建立 Workflow case 索引；Codex 必须读取原始 Excel 并自行判断业务语义',
    ...(embeddedAssets.length || supplementalAssets.length ? ['所有内嵌和补充图片必须完成视觉语义审核'] : []),
    ...(phases.some((phase) => phase.risk !== 'read' && phase.review.ambiguities.some((item) => item.includes('恢复契约')))
      ? ['存在没有源清理步骤的写入用例，Policy Gate 必须 fail closed 或验证 Recovery Planner 契约']
      : []),
  ]
  const manifest: WorkflowIntakeManifest = {
    version: '1.0',
    kind: 'workflow-intake',
    workflowId: standard.workflowId,
    source: {
      format: 'xlsx',
      fileName: standard.source.fileName,
      sheetName: standard.source.sheetName,
      sha256: standard.source.sha256,
    },
    targetUrls,
    declaredTargetUrls: [...new Set((options.additionalUrls ?? []).map(normalizeUrl).filter((item): item is string => Boolean(item)))],
    requiredCapabilities: [...capabilities],
    phases,
    embeddedImages: embeddedAssets.map((asset) => asset.metadata),
    supplementalImages: supplementalAssets.map((asset) => asset.metadata),
    review: { status: 'draft', reasons: reviewReasons },
  }
  diagnostics.warning('workflow_review_required', '标准测试用例已进入 Codex-native 自治执行链路；解析诊断是来源提示，不是 Agent 启动门')
  return intakeResult({
    manifest,
    assets: [...embeddedAssets, ...supplementalAssets],
    report: {
      sourceFile: options.filePath,
      summary: {
        sheetName: workbook.sheetName,
        phases: phases.length,
        images: embeddedAssets.length + supplementalAssets.length,
        secretBindings: phases.reduce((sum, phase) => sum + phase.secretBindings.length, 0),
        errors: diagnostics.count('error'),
        warnings: diagnostics.count('warning'),
      },
      diagnostics: diagnostics.items,
    },
  }, secretMaterial)
}

export async function intakeWorkflowXlsx(options: WorkflowIntakeOptions): Promise<WorkflowIntakeResult> {
  const diagnostics = new DiagnosticBag()
  if (extname(options.filePath).toLowerCase() !== '.xlsx') throw new Error('工作流 intake 只接受 .xlsx 文件')
  const file = await readFile(options.filePath)
  if (file.byteLength > 25 * 1024 * 1024) throw new Error(`XLSX 文件超过 25 MB 上限：${file.byteLength} bytes`)
  if (file[0] !== 0x50 || file[1] !== 0x4b) throw new Error('文件不是有效的 XLSX/ZIP 容器')
  const standardDiagnostics = new DiagnosticBag()
  const standardWorkbook = await readWorkbookCases(options.filePath, standardDiagnostics, {
    ...(options.sheetName ? { sheetName: options.sheetName } : {}),
  })
  const sha256 = createHash('sha256').update(file).digest('hex')
  const workbook = read(file, { type: 'buffer', cellDates: true, cellFormula: true, cellText: true })
  if (standardWorkbook.headerRow !== null) {
    const embeddedAssets = extractWpsCellImages(file, formulaImageCells(workbook))
      .filter((asset) => asset.metadata.sheetName === standardWorkbook.sheetName)
      .sort((a, b) => a.metadata.sourceRow - b.metadata.sourceRow || a.metadata.sourceCell.localeCompare(b.metadata.sourceCell))
    return intakeStandardTestCases(options, standardWorkbook, standardDiagnostics, embeddedAssets, sha256)
  }

  const sheetNames = options.sheetName ? [options.sheetName] : workbook.SheetNames
  const selected = sheetNames
    .map((sheetName) => ({ sheetName, sheet: workbook.Sheets[sheetName] }))
    .filter((item): item is { sheetName: string; sheet: WorkSheet } => Boolean(item.sheet))
    .map((item) => ({ ...item, phases: phasesFromSheet(item.sheetName, item.sheet) }))
    .sort((a, b) => b.phases.length - a.phases.length)[0]

  if (options.sheetName && !selected) diagnostics.error('sheet_not_found', `未找到工作表「${options.sheetName}」`)
  const sourcePhases = selected?.phases ?? []
  if (!sourcePhases.length) diagnostics.error('workflow_rows_not_found', '未找到“阶段标题 + 操作说明”形式的工作流行')
  else diagnostics.info('workflow_table_detected', `识别到 ${sourcePhases.length} 个工作流阶段`, selected ? { sheet: selected.sheetName } : {})

  const assets = extractWpsCellImages(file, formulaImageCells(workbook))
    .filter((asset) => asset.metadata.sheetName === selected?.sheetName)
    .sort((a, b) => a.metadata.sourceRow - b.metadata.sourceRow || a.metadata.sourceCell.localeCompare(b.metadata.sourceCell))
  const supplementalAssets = await Promise.all((options.supplementalImagePaths ?? []).map(supplementalImage))
  for (const asset of assets) {
    diagnostics.warning('embedded_image_review_required', `单元格 ${asset.metadata.sourceCell} 包含内嵌图片，必须完成视觉语义审核`, {
      sheet: asset.metadata.sheetName,
      row: asset.metadata.sourceRow,
      column: asset.metadata.sourceCell.replace(/\d+$/, ''),
    })
  }
  for (const asset of supplementalAssets) {
    diagnostics.warning('supplemental_image_review_required', `补充图片 ${asset.metadata.fileName} 必须完成视觉语义审核`)
  }

  const targetUrls = new Set<string>()
  for (const url of options.additionalUrls ?? []) {
    const normalized = normalizeUrl(url)
    if (!normalized) diagnostics.error('target_url_invalid', `目标 URL 无效：${url}`)
    else targetUrls.add(normalized)
  }

  const phaseIds = new Set<string>()
  const secretMaterial: Record<string, string | string[]> = {}
  const phases: WorkflowPhaseDraft[] = sourcePhases.map((source, phaseIndex) => {
    const baseId = slugify(source.title.text)
    let phaseId = baseId
    let suffix = 2
    while (phaseIds.has(phaseId)) phaseId = `${baseId}-${suffix++}`
    phaseIds.add(phaseId)
    const instruction = sanitizeText(source.instruction.text, phaseId, source.instruction.address)
    assignSecretMaterial(secretMaterial, instruction.secretMaterial, `单元格 ${source.instruction.address}`)
    const parts = instructionParts(instruction.text)
    const resources = source.resources.map((resource) => {
      const sanitized = sanitizeText(resource.text, phaseId, resource.address)
      assignSecretMaterial(secretMaterial, sanitized.secretMaterial, `单元格 ${resource.address}`)
      for (const binding of sanitized.bindings) instruction.bindings.push(binding)
      const urls = extractUrls(resource.text)
      for (const url of urls) targetUrls.add(url)
      return { sourceCell: resource.address, text: sanitized.text, urls }
    })
    for (const url of extractUrls(source.instruction.text)) targetUrls.add(url)
    const uniqueBindings = [...new Map(instruction.bindings.map((binding) => [binding.secretRef, binding])).values()]
    for (const binding of uniqueBindings) {
      diagnostics.warning('secret_moved_to_reference', `单元格 ${binding.sourceCell} 的${binding.purpose}已转换为 secretRef`, {
        sheet: source.sheetName,
        row: source.sourceRow,
        column: binding.sourceCell.replace(/\d+$/, ''),
      })
    }
    const imageIds = assets.filter((asset) => asset.metadata.sourceRow === source.sourceRow).map((asset) => asset.metadata.id)
    const raw = [source.title.text, source.instruction.text, ...source.resources.map((item) => item.text)].join('\n')
    const ambiguities = [
      ...(imageIds.length ? ['内嵌图片需要 AI 或测试工程师确认其操作语义'] : []),
      ...(/随机时间窗/.test(raw) ? ['随机时间窗必须在执行前收敛为明确范围或策略'] : []),
      ...(/最新.*订单|匹配.*订单/.test(raw) ? ['必须以本轮运行产生的实体 ID 关联订单，不能只按列表第一行操作'] : []),
    ]
    return {
      id: phaseId,
      title: redactSensitiveContent(source.title.text),
      sourceRow: source.sourceRow,
      risk: riskFor(raw),
      ...(parts.summary ? { summary: parts.summary } : {}),
      outcome: {
        action: parts.steps,
        observable: parts.summary ? [parts.summary] : [],
        evidence: ['interaction', 'observation'],
        cleanup: [],
        failureModes: failureModesFor(riskFor(raw)),
      },
      steps: parts.steps.map((step, stepIndex) => ({ id: `phase-${phaseIndex + 1}-step-${stepIndex + 1}`, sourceText: step, confidence: 0.7 })),
      resources,
      secretBindings: uniqueBindings,
      imageIds,
      review: { status: 'draft', ambiguities },
    }
  })

  const fileName = basename(options.filePath)
  const workflowId = `${slugify(basename(fileName, extname(fileName)))}-${sha256.slice(0, 8)}`
  const requiredCapabilities = capabilitiesFor(sourcePhases, [...targetUrls], assets.length + supplementalAssets.length, phases.map((phase) => phase.risk))
  const reviewReasons = [
    '工作流型 Excel 不是标准测试用例表，必须补全每个阶段的明确断言',
    ...(assets.length || supplementalAssets.length ? ['所有内嵌和补充图片必须完成视觉语义审核'] : []),
    ...(phases.some((phase) => phase.risk === 'destructive') ? ['破坏性阶段需要显式批准和可验证的清理/恢复策略'] : []),
  ]
  const manifest: WorkflowIntakeManifest = {
    version: '1.0',
    kind: 'workflow-intake',
    workflowId,
    source: {
      format: 'xlsx',
      fileName,
      sheetName: selected?.sheetName ?? options.sheetName ?? '',
      sha256,
    },
    targetUrls: [...targetUrls],
    declaredTargetUrls: [...new Set((options.additionalUrls ?? []).map(normalizeUrl).filter((item): item is string => Boolean(item)))],
    requiredCapabilities,
    phases,
    embeddedImages: assets.map((asset) => asset.metadata),
    supplementalImages: supplementalAssets.map((asset) => asset.metadata),
    review: { status: 'draft', reasons: reviewReasons },
  }

  diagnostics.warning('workflow_review_required', '工作流 intake 只生成可审核清单，不会绕过断言、风险和图片审核直接执行')
  return intakeResult({
    manifest,
    assets: [...assets, ...supplementalAssets],
    report: {
      sourceFile: options.filePath,
      summary: {
        sheetName: selected?.sheetName ?? null,
        phases: phases.length,
        images: assets.length + supplementalAssets.length,
        secretBindings: phases.reduce((sum, phase) => sum + phase.secretBindings.length, 0),
        errors: diagnostics.count('error'),
        warnings: diagnostics.count('warning'),
      },
      diagnostics: diagnostics.items,
    },
  }, secretMaterial)
}
