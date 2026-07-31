import * as fs from 'node:fs'
import { readFile, set_fs, utils, type WorkBook } from '@e965/xlsx'
import { DiagnosticBag } from '../core/diagnostics.js'
import { HIERARCHY_COLUMNS, REQUIRED_COLUMNS, resolveHeader, type CanonicalColumn } from './headers.js'
import { normalizeText } from './text.js'

set_fs(fs)

export interface RawCaseRow {
  sheetName: string
  sourceRow: number
  values: Partial<Record<CanonicalColumn, string>>
}

export interface WorkbookReadResult {
  sheetName: string | null
  headerRow: number | null
  headerMap: Record<string, { column: number; header: string }>
  unknownHeaders: string[]
  rows: RawCaseRow[]
  totalDataRows: number
  skippedRows: number
}

export interface WorkbookReadOptions {
  sheetName?: string
}

interface HeaderCandidate {
  sheet: ParsedSheet
  rowIndex: number
  score: number
  headers: string[]
}

interface ParsedSheet {
  sheet: string
  data: unknown[][]
}

function columnName(index: number): string {
  let value = index
  let name = ''
  while (value > 0) {
    value -= 1
    name = String.fromCharCode(65 + (value % 26)) + name
    value = Math.floor(value / 26)
  }
  return name
}

function rowText(row: unknown[]): string[] {
  return row.map((cell) => normalizeText(cell))
}

function findHeaderCandidate(sheets: ParsedSheet[], requestedSheet: string | undefined): HeaderCandidate | null {
  const candidates: HeaderCandidate[] = []
  const selectedSheets = requestedSheet ? sheets.filter((sheet) => sheet.sheet === requestedSheet) : sheets

  for (const sheet of selectedSheets) {
    const maxRows = Math.min(sheet.data.length, 30)
    for (let rowIndex = 0; rowIndex < maxRows; rowIndex++) {
      const headers = rowText(sheet.data[rowIndex] ?? [])
      const canonical = new Set(headers.map(resolveHeader).filter((item): item is CanonicalColumn => Boolean(item)))
      if (!REQUIRED_COLUMNS.every((column) => canonical.has(column))) continue
      candidates.push({ sheet, rowIndex, score: canonical.size, headers })
    }
  }

  return candidates.sort((a, b) => b.score - a.score || a.rowIndex - b.rowIndex)[0] ?? null
}

export async function readWorkbookCases(
  filePath: string,
  diagnostics: DiagnosticBag,
  options: WorkbookReadOptions = {},
): Promise<WorkbookReadResult> {
  const workbook: WorkBook = readFile(filePath, {
    cellDates: true,
    cellFormula: true,
    cellText: false,
    raw: true,
  })
  const sheets: ParsedSheet[] = workbook.SheetNames.map((sheetName) => ({
    sheet: sheetName,
    data: utils.sheet_to_json(workbook.Sheets[sheetName]!, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    }) as unknown[][],
  }))

  if (options.sheetName && !sheets.some((sheet) => sheet.sheet === options.sheetName)) {
    diagnostics.error('sheet_not_found', `未找到工作表「${options.sheetName}」`)
  }

  const candidate = findHeaderCandidate(sheets, options.sheetName)
  if (!candidate) {
    diagnostics.error('header_not_found', '未找到同时包含用例ID、用例标题、测试步骤和预期结果的表头行')
    return {
      sheetName: null,
      headerRow: null,
      headerMap: {},
      unknownHeaders: [],
      rows: [],
      totalDataRows: 0,
      skippedRows: 0,
    }
  }

  const headerColumns = new Map<CanonicalColumn, number>()
  const headerMap: Record<string, { column: number; header: string }> = {}
  const unknownHeaders: string[] = []

  candidate.headers.forEach((header, index) => {
    if (!header) return
    const canonical = resolveHeader(header)
    if (!canonical) {
      unknownHeaders.push(header)
      return
    }
    const column = index + 1
    if (headerColumns.has(canonical)) {
      diagnostics.error('duplicate_header', `表头「${header}」与另一列都映射到 ${canonical}`, {
        sheet: candidate.sheet.sheet,
        row: candidate.rowIndex + 1,
        column: columnName(column),
      })
      return
    }
    headerColumns.set(canonical, column)
    headerMap[canonical] = { column, header }
  })

  for (const required of REQUIRED_COLUMNS) {
    if (!headerColumns.has(required)) {
      diagnostics.error('required_header_missing', `缺少必填表头 ${required}`, {
        sheet: candidate.sheet.sheet,
        row: candidate.rowIndex + 1,
      })
    }
  }

  for (const header of unknownHeaders) {
    diagnostics.warning('unknown_header', `未识别表头「${header}」，该列不会进入 IR`, {
      sheet: candidate.sheet.sheet,
      row: candidate.rowIndex + 1,
    })
  }

  const hierarchy: Partial<Record<CanonicalColumn, string>> = {}
  const rows: RawCaseRow[] = []
  let totalDataRows = 0
  let skippedRows = 0

  for (let rowIndex = candidate.rowIndex + 1; rowIndex < candidate.sheet.data.length; rowIndex++) {
    const source = candidate.sheet.data[rowIndex] ?? []
    const values: Partial<Record<CanonicalColumn, string>> = {}

    for (const [canonical, column] of headerColumns) {
      const value = normalizeText(source[column - 1])
      if (value) values[canonical] = value
    }

    const hasData = Object.values(values).some(Boolean)
    if (!hasData) {
      skippedRows += 1
      continue
    }
    totalDataRows += 1

    for (const canonical of HIERARCHY_COLUMNS) {
      const value = values[canonical]
      if (value) hierarchy[canonical] = value
      else if (hierarchy[canonical]) values[canonical] = hierarchy[canonical]
    }

    rows.push({
      sheetName: candidate.sheet.sheet,
      sourceRow: rowIndex + 1,
      values,
    })
  }

  return {
    sheetName: candidate.sheet.sheet,
    headerRow: candidate.rowIndex + 1,
    headerMap,
    unknownHeaders,
    rows,
    totalDataRows,
    skippedRows,
  }
}
