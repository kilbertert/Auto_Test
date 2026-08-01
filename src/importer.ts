import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { DiagnosticBag } from './core/diagnostics.js'
import type { ImportResult, TestCaseIR, TestSuiteIR } from './core/types.js'
import { parseCaseParts } from './ir/parse.js'
import { redactSensitiveText, slugify } from './input/text.js'
import { readWorkbookCases } from './input/xlsx.js'
import { validateSuite } from './validation/schema.js'

export interface ImportOptions {
  filePath: string
  baseUrl: string
  sheetName?: string
  authProfile?: string
  limit?: number
  destructiveActions?: 'blocked' | 'requireApproval'
}

function normalizeBaseUrl(value: string): { baseUrl: string; allowedOrigin: string } {
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('baseUrl 只允许 http:// 或 https://')
  }
  return {
    baseUrl: parsed.toString(),
    allowedOrigin: `${parsed.origin}/`,
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100
}

function requiredValue(
  value: string | undefined,
  label: string,
  code: string,
  diagnostics: DiagnosticBag,
  sheet: string,
  row: number,
  caseId?: string,
): string | null {
  if (value?.trim()) return value.trim()
  diagnostics.error(code, `${label}不能为空`, {
    sheet,
    row,
    ...(caseId ? { caseId } : {}),
  })
  return null
}

export async function importXlsxToIr(options: ImportOptions): Promise<ImportResult> {
  const diagnostics = new DiagnosticBag()
  if (extname(options.filePath).toLowerCase() !== '.xlsx') {
    throw new Error('MVP 只接受 .xlsx 文件')
  }
  const { baseUrl, allowedOrigin } = normalizeBaseUrl(options.baseUrl)
  const file = await readFile(options.filePath)
  const maxBytes = 25 * 1024 * 1024
  if (file.byteLength > maxBytes) {
    throw new Error(`XLSX 文件超过 25 MB 上限：${file.byteLength} bytes`)
  }
  if (file[0] !== 0x50 || file[1] !== 0x4b) {
    throw new Error('文件不是有效的 XLSX/ZIP 容器')
  }
  const sha256 = createHash('sha256').update(file).digest('hex')
  const workbook = await readWorkbookCases(options.filePath, diagnostics, {
    ...(options.sheetName ? { sheetName: options.sheetName } : {}),
  })

  const cases: TestCaseIR[] = []
  const seenIds = new Set<string>()
  let invalidRows = 0
  const limit = Math.max(1, Math.min(options.limit ?? 20, 20))

  for (const row of workbook.rows) {
    if (cases.length >= limit) break
    const rawId = requiredValue(row.values.caseId, '用例ID', 'case_id_missing', diagnostics, row.sheetName, row.sourceRow)
    const caseId = rawId ? redactSensitiveText(rawId) : null
    const title = requiredValue(row.values.title, '用例标题', 'title_missing', diagnostics, row.sheetName, row.sourceRow, caseId ?? undefined)
    const stepsText = requiredValue(row.values.steps, '测试步骤', 'steps_missing', diagnostics, row.sheetName, row.sourceRow, caseId ?? undefined)
    const expectedText = requiredValue(row.values.expected, '预期结果', 'expected_missing', diagnostics, row.sheetName, row.sourceRow, caseId ?? undefined)

    if (!caseId || !title || !stepsText || !expectedText) {
      invalidRows += 1
      continue
    }
    if (seenIds.has(caseId)) {
      diagnostics.error('duplicate_case_id', `用例ID「${caseId}」重复`, {
        sheet: row.sheetName,
        row: row.sourceRow,
        caseId,
      })
      invalidRows += 1
      continue
    }
    seenIds.add(caseId)

    const parts = parseCaseParts(row, caseId, diagnostics)
    if (parts.steps.length === 0) {
      diagnostics.error('steps_empty_after_parse', '测试步骤解析后为空', {
        sheet: row.sheetName,
        row: row.sourceRow,
        caseId,
      })
      invalidRows += 1
      continue
    }
    if (parts.assertions.length === 0) {
      diagnostics.error('assertions_empty_after_parse', '预期结果解析后没有产生断言', {
        sheet: row.sheetName,
        row: row.sourceRow,
        caseId,
      })
      invalidRows += 1
      continue
    }

    const confidence = average([
      ...parts.steps.map((step) => step.confidence),
      ...parts.assertions.map((assertion) => assertion.confidence),
    ])
    const testCase: TestCaseIR = {
      id: caseId,
      title: redactSensitiveText(title),
      priority: parts.priority,
      risk: parts.risk,
      ...(row.values.authProfile ? { authProfile: redactSensitiveText(row.values.authProfile) } : {}),
      ...(parts.modulePath.length ? { modulePath: parts.modulePath.map(redactSensitiveText) } : {}),
      ...(parts.tags.length ? { tags: parts.tags.map(redactSensitiveText) } : {}),
      ...(parts.dependencies.length ? { dependencies: parts.dependencies.map(redactSensitiveText) } : {}),
      ...(parts.preconditions.length ? { preconditions: parts.preconditions } : {}),
      ...(parts.dataBindings.length ? { dataBindings: parts.dataBindings } : {}),
      steps: parts.steps,
      assertions: parts.assertions,
      ...(parts.cleanupSteps.length ? { cleanupSteps: parts.cleanupSteps } : {}),
      review: {
        status: 'draft',
        ambiguities: parts.ambiguities,
        confidence,
      },
      sourceRow: row.sourceRow,
    }
    cases.push(testCase)
  }

  const fileName = basename(options.filePath)
  const suiteId = `${slugify(basename(fileName, extname(fileName)))}-${sha256.slice(0, 8)}`
  const suite: TestSuiteIR = {
    version: '1.0',
    suiteId,
    source: {
      format: 'xlsx',
      fileName,
      ...(workbook.sheetName ? { sheetName: workbook.sheetName } : {}),
      sha256,
    },
    target: {
      baseUrl,
      allowedOrigins: [allowedOrigin],
      ...(options.authProfile ? { authProfile: options.authProfile } : {}),
    },
    policy: {
      caseTimeoutMs: 60_000,
      retries: 1,
      repair: {
        maxAttempts: 2,
        allowedChanges: ['locator', 'waitCondition'],
        assertionMutation: 'forbidden',
      },
      destructiveActions: options.destructiveActions ?? 'blocked',
    },
    cases,
  }

  const schema = validateSuite(suite)
  diagnostics.items.push(...schema.diagnostics)
  const processedRows = cases.length + invalidRows
  const skippedByLimit = Math.max(0, workbook.rows.length - processedRows)
  if (skippedByLimit > 0) {
    diagnostics.info('case_limit_applied', `MVP 单次最多导入 ${limit} 条有效用例，其余行未处理`)
  }

  return {
    suite,
    schemaValid: schema.valid,
    report: {
      sourceFile: options.filePath,
      headerMap: workbook.headerMap,
      unknownHeaders: workbook.unknownHeaders,
      summary: {
        sheetName: workbook.sheetName,
        headerRow: workbook.headerRow,
        totalDataRows: workbook.totalDataRows,
        importedCases: cases.length,
        skippedRows: workbook.skippedRows + invalidRows + skippedByLimit,
        errors: diagnostics.count('error'),
        warnings: diagnostics.count('warning'),
      },
      diagnostics: diagnostics.items,
    },
  }
}
