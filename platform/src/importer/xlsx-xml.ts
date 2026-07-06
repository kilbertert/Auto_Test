/**
 * xlsx XML 直读解析器。
 *
 * 测试用例.xlsx 的 xl/styles.xml 损坏,openpyxl/pandas 直接读会崩,
 * 因此必须解压 xlsx(zip)后用 fast-xml-parser 直读三个 XML:
 *   xl/workbook.xml                  — sheet 名 + r:id
 *   xl/_rels/workbook.xml.rels       — r:id → worksheets/sheetN.xml
 *   xl/sharedStrings.xml             — 共享字符串表(<si><t>...</t></si>)
 *   xl/worksheets/sheetN.xml         — 单元格(<c r="A1" t="s"><v>0</v></c>)
 *
 * t="s" 时 <v> 是 sharedStrings 下标;t="inlineStr" 时取 <is><t>;否则 <v> 为字面值。
 */

import { readFileSync } from 'node:fs'
import AdmZip from 'adm-zip'
import { XMLParser } from 'fast-xml-parser'

/** 解析后的单个 sheet。 */
export interface ParsedSheet {
  name: string
  /** 所有行,每行按列索引顺序排列,空单元格为 ''。 */
  rows: string[][]
}

/** parseXlsx 的返回结构。 */
export interface ParsedXlsx {
  sheets: ParsedSheet[]
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // 不把文本节点转成 number/boolean,避免 16~19 位银行卡号精度丢失
  parseTagValue: false,
  trimValues: true,
})

/** 把 fast-xml-parser 可能产出的 单值/数组/undefined 统一成数组。 */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/** 从一个可能是 string | {#text} | 对象 的节点中递归提取纯文本。 */
function extractText(node: unknown): string {
  if (node === undefined || node === null) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    if ('#text' in obj) return String(obj['#text'] ?? '')
    if ('t' in obj) return extractText(obj.t)
    if ('r' in obj) return extractText(obj.r)
    if ('is' in obj) return extractText(obj.is)
    return ''
  }
  return ''
}

/** 列字母(A/B/.../AA)→0 基索引。 */
function colLettersToIndex(cellRef: string): number {
  const match = /^([A-Za-z]+)/.exec(cellRef)
  if (!match) return -1
  let idx = 0
  for (const ch of match[1].toUpperCase()) {
    idx = idx * 26 + (ch.charCodeAt(0) - 64)
  }
  return idx - 1
}

/** 从 <c> 单元格对象取出文本值。 */
function cellValue(cell: Record<string, unknown>, sharedStrings: string[]): string {
  const type = cell['@_t']
  // 内联字符串:<c t="inlineStr"><is><t>...</t></is></c>
  if (type === 'inlineStr') {
    return extractText(cell.is)
  }
  // 共享字符串:<c t="s"><v>索引</v></c>;空单元格可能无 <v>
  if (type === 's') {
    const raw = cell.v
    if (raw === undefined) return ''
    const idx = Number(extractText(raw))
    return Number.isFinite(idx) ? (sharedStrings[idx] ?? '') : ''
  }
  // 字面值(数字/字符串/布尔/错误)或无类型:取 <v>
  if (cell.v !== undefined) {
    return extractText(cell.v)
  }
  return ''
}

/** 读取 zip 内某个 entry 的文本;不存在返回 ''。 */
function readEntry(zip: AdmZip, entryPath: string): string {
  const entry = zip.getEntry(entryPath)
  if (!entry) return ''
  return zip.readAsText(entry)
}

/** 解析共享字符串表,返回按出现顺序的字符串数组。 */
function parseSharedStrings(xml: string): string[] {
  if (!xml) return []
  const doc = xmlParser.parse(xml) as Record<string, unknown>
  const sst = doc.sst as Record<string, unknown> | undefined
  if (!sst) return []
  const siList = asArray(sst.si as unknown)
  return siList.map((si) => extractText(si))
}

/** 解析 workbook.xml + rels,返回 [{name, target}]。 */
function parseWorkbook(
  workbookXml: string,
  relsXml: string,
): { name: string; target: string }[] {
  const wbDoc = xmlParser.parse(workbookXml) as Record<string, unknown>
  const wb = wbDoc.workbook as Record<string, unknown> | undefined
  const sheetsNode = wb?.sheets as Record<string, unknown> | undefined
  const sheetList = asArray(sheetsNode?.sheet as unknown) as unknown as Record<string, unknown>[]

  // r:id 属性名带命名空间前缀,可能是 '@_r:id';兼容任意 *:id
  const getRid = (sheet: Record<string, unknown>): string => {
    for (const key of Object.keys(sheet)) {
      if (key.startsWith('@_') && key.endsWith(':id')) return String(sheet[key])
    }
    const direct = sheet['@_r:id'] ?? sheet['@_id']
    return direct !== undefined ? String(direct) : ''
  }

  // rels: rId → target
  const relsDoc = xmlParser.parse(relsXml) as Record<string, unknown>
  const relsNode = relsDoc.Relationships as Record<string, unknown> | undefined
  const relList = asArray(relsNode?.Relationship as unknown) as unknown as Record<string, unknown>[]
  const rIdToTarget = new Map<string, string>()
  for (const rel of relList) {
    const id = String(rel['@_Id'] ?? '')
    const target = String(rel['@_Target'] ?? '')
    if (id) rIdToTarget.set(id, target)
  }

  return sheetList.map((sheet) => {
    const name = String(sheet['@_name'] ?? '')
    const rId = getRid(sheet)
    let target = rIdToTarget.get(rId) ?? ''
    // target 相对于 xl/,统一成 'xl/...' 绝对路径
    if (target.startsWith('/')) target = target.slice(1)
    if (target && !target.startsWith('xl/')) target = 'xl/' + target
    return { name, target }
  })
}

/** 解析单个 worksheet XML,返回所有行(每行 string[],按列索引顺序)。 */
function parseWorksheet(xml: string, sharedStrings: string[]): string[][] {
  if (!xml) return []
  const doc = xmlParser.parse(xml) as Record<string, unknown>
  const ws = doc.worksheet as Record<string, unknown> | undefined
  const sheetData = ws?.sheetData as Record<string, unknown> | undefined
  const rowList = asArray(sheetData?.row as unknown) as unknown as Record<string, unknown>[]

  const rows: string[][] = []
  for (const row of rowList) {
    const cellList = asArray(row.c as unknown) as unknown as Record<string, unknown>[]
    if (cellList.length === 0) {
      rows.push([])
      continue
    }
    // 先收集 (colIndex, value),再按最大列号展开成数组,空位填 ''
    const cells: { col: number; val: string }[] = []
    let maxCol = -1
    for (const cell of cellList) {
      const ref = String(cell['@_r'] ?? '')
      const col = colLettersToIndex(ref)
      if (col < 0) continue
      cells.push({ col, val: cellValue(cell, sharedStrings) })
      if (col > maxCol) maxCol = col
    }
    const out = new Array<string>(maxCol + 1).fill('')
    for (const { col, val } of cells) out[col] = val
    rows.push(out)
  }
  return rows
}

/**
 * 直读 xlsx 文件,返回每个 sheet 的所有行。
 *
 * @param filePath xlsx 文件绝对/相对路径
 * @returns { sheets: [{ name, rows: string[][] }] },行内空单元格为 ''
 */
export function parseXlsx(filePath: string): ParsedXlsx {
  const buf = readFileSync(filePath)
  const zip = new AdmZip(buf)

  const workbookXml = readEntry(zip, 'xl/workbook.xml')
  const relsXml = readEntry(zip, 'xl/_rels/workbook.xml.rels')
  const sheetMetas = parseWorkbook(workbookXml, relsXml)

  const sharedStrings = parseSharedStrings(readEntry(zip, 'xl/sharedStrings.xml'))

  const sheets: ParsedSheet[] = sheetMetas.map(({ name, target }) => {
    const rows = parseWorksheet(readEntry(zip, target), sharedStrings)
    return { name, rows }
  })

  return { sheets }
}
