import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { basename, extname, posix, resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { utils } from '@e965/xlsx'
import he from 'he'
import { redactSensitiveContent } from '../input/text.js'
import type { WorkflowIntakeManifest } from '../workflow/types.js'
import type { CodexTestAgentResult, CodexTestCaseResult } from './types.js'

const localFileHeader = 0x04034b50
const centralDirectoryHeader = 0x02014b50
const endOfCentralDirectory = 0x06054b50
const dataDescriptor = 0x08074b50

const resultColumns = [
  ['Auto-Test 状态', 'status'],
  ['失败来源', 'failureSource'],
  ['失败类型', 'failureKind'],
  ['执行摘要', 'summary'],
  ['证据索引', 'evidence'],
  ['环境需求', 'environment'],
] as const

type ResultColumnKey = typeof resultColumns[number][1]

interface ZipEntry {
  name: string
  central: Buffer
  flags: number
  method: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

interface ZipArchive {
  entries: ZipEntry[]
  centralOffset: number
  centralEnd: number
  endOffset: number
}

export interface ResultWorkbookArtifact {
  path: string
  sheetName: string
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - 0xffff - 22)
  for (let offset = buffer.length - 22; offset >= earliest; offset--) {
    if (buffer.readUInt32LE(offset) !== endOfCentralDirectory) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === buffer.length) return offset
  }
  throw new Error('XLSX ZIP archive has no valid end-of-central-directory record')
}

function parseZipArchive(buffer: Buffer): ZipArchive {
  const endOffset = findEndOfCentralDirectory(buffer)
  const disk = buffer.readUInt16LE(endOffset + 4)
  const centralDisk = buffer.readUInt16LE(endOffset + 6)
  const entryCount = buffer.readUInt16LE(endOffset + 10)
  const centralSize = buffer.readUInt32LE(endOffset + 12)
  const centralOffset = buffer.readUInt32LE(endOffset + 16)
  if (disk !== 0 || centralDisk !== 0) throw new Error('Multi-disk XLSX archives are not supported')
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 XLSX archives are not supported for result writeback')
  }
  if (centralOffset + centralSize > endOffset) throw new Error('XLSX central directory is invalid')
  const entries: ZipEntry[] = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > centralOffset + centralSize || buffer.readUInt32LE(cursor) !== centralDirectoryHeader) {
      throw new Error('XLSX central directory entry is invalid')
    }
    const fileNameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const size = 46 + fileNameLength + extraLength + commentLength
    if (cursor + size > centralOffset + centralSize) throw new Error('XLSX central directory entry is truncated')
    entries.push({
      name: buffer.subarray(cursor + 46, cursor + 46 + fileNameLength).toString('utf8'),
      central: buffer.subarray(cursor, cursor + size),
      flags: buffer.readUInt16LE(cursor + 8),
      method: buffer.readUInt16LE(cursor + 10),
      crc32: buffer.readUInt32LE(cursor + 16),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      uncompressedSize: buffer.readUInt32LE(cursor + 24),
      localOffset: buffer.readUInt32LE(cursor + 42),
    })
    cursor += size
  }
  if (cursor !== centralOffset + centralSize) throw new Error('XLSX central directory contains unsupported trailing records')
  return { entries, centralOffset, centralEnd: cursor, endOffset }
}

function entryBlock(buffer: Buffer, archive: ZipArchive, entry: ZipEntry): { headerEnd: number; dataEnd: number; end: number } {
  const sorted = [...archive.entries].sort((left, right) => left.localOffset - right.localOffset)
  const index = sorted.findIndex((candidate) => candidate.name === entry.name)
  if (index < 0) throw new Error(`XLSX archive is missing ${entry.name}`)
  const end = index + 1 < sorted.length ? sorted[index + 1]!.localOffset : archive.centralOffset
  if (entry.localOffset + 30 > end || buffer.readUInt32LE(entry.localOffset) !== localFileHeader) {
    throw new Error(`XLSX local entry is invalid: ${entry.name}`)
  }
  const fileNameLength = buffer.readUInt16LE(entry.localOffset + 26)
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28)
  const headerEnd = entry.localOffset + 30 + fileNameLength + extraLength
  const dataEnd = headerEnd + entry.compressedSize
  if (dataEnd > end) throw new Error(`XLSX local entry data is invalid: ${entry.name}`)
  return { headerEnd, dataEnd, end }
}

function zipEntryData(buffer: Buffer, archive: ZipArchive, entry: ZipEntry): Buffer {
  if (entry.flags & 0x1) throw new Error(`Encrypted XLSX ZIP entries are not supported: ${entry.name}`)
  const block = entryBlock(buffer, archive, entry)
  const compressed = buffer.subarray(block.headerEnd, block.dataEnd)
  if (entry.method === 0) return Buffer.from(compressed)
  if (entry.method === 8) return inflateRawSync(compressed)
  throw new Error(`Unsupported XLSX ZIP compression method ${entry.method} for ${entry.name}`)
}

export function readOoxmlPart(buffer: Buffer, name: string): Buffer {
  const archive = parseZipArchive(buffer)
  const entry = archive.entries.find((item) => item.name === name)
  if (!entry) throw new Error(`XLSX archive does not contain ${name}`)
  return zipEntryData(buffer, archive, entry)
}

export function listOoxmlParts(buffer: Buffer): string[] {
  return parseZipArchive(buffer).entries.map((entry) => entry.name)
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let value = 0xffffffff
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function replacementLocalEntry(buffer: Buffer, archive: ZipArchive, entry: ZipEntry, content: Buffer): { content: Buffer; compressedSize: number } {
  if (entry.flags & 0x1) throw new Error(`Encrypted XLSX ZIP entries are not supported: ${entry.name}`)
  const block = entryBlock(buffer, archive, entry)
  const localFlags = buffer.readUInt16LE(entry.localOffset + 6)
  const localMethod = buffer.readUInt16LE(entry.localOffset + 8)
  if (localMethod !== entry.method || localFlags !== entry.flags) throw new Error(`XLSX local header does not match central directory: ${entry.name}`)
  const compressed = entry.method === 0 ? Buffer.from(content) : entry.method === 8 ? deflateRawSync(content) : (() => {
    throw new Error(`Unsupported XLSX ZIP compression method ${entry.method} for ${entry.name}`)
  })()
  const checksum = crc32(content)
  const header = Buffer.from(buffer.subarray(entry.localOffset, block.headerEnd))
  const usesDescriptor = Boolean(entry.flags & 0x8)
  if (usesDescriptor) {
    header.writeUInt32LE(0, 14)
    header.writeUInt32LE(0, 18)
    header.writeUInt32LE(0, 22)
  } else {
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(content.length, 22)
  }
  const trailing = Buffer.from(buffer.subarray(block.dataEnd, block.end))
  if (!usesDescriptor) {
    if (trailing.length > 0) throw new Error(`XLSX local entry has unsupported trailing data: ${entry.name}`)
    return { content: Buffer.concat([header, compressed]), compressedSize: compressed.length }
  }
  const descriptorOffset = trailing.length === 16 && trailing.readUInt32LE(0) === dataDescriptor ? 4 : 0
  if (trailing.length !== descriptorOffset + 12) throw new Error(`XLSX data descriptor is invalid: ${entry.name}`)
  trailing.writeUInt32LE(checksum, descriptorOffset)
  trailing.writeUInt32LE(compressed.length, descriptorOffset + 4)
  trailing.writeUInt32LE(content.length, descriptorOffset + 8)
  return { content: Buffer.concat([header, compressed, trailing]), compressedSize: compressed.length }
}

export function replaceOoxmlPart(buffer: Buffer, name: string, content: Buffer): Buffer {
  const archive = parseZipArchive(buffer)
  const target = archive.entries.find((entry) => entry.name === name)
  if (!target) throw new Error(`XLSX archive does not contain ${name}`)
  const replacement = replacementLocalEntry(buffer, archive, target, content)
  const sorted = [...archive.entries].sort((left, right) => left.localOffset - right.localOffset)
  const localParts: Buffer[] = [buffer.subarray(0, sorted[0]?.localOffset ?? archive.centralOffset)]
  const localOffsets = new Map<string, number>()
  let cursor = localParts[0]!.length
  for (const entry of sorted) {
    localOffsets.set(entry.name, cursor)
    const part = entry.name === name
      ? replacement.content
      : buffer.subarray(entry.localOffset, entryBlock(buffer, archive, entry).end)
    localParts.push(part)
    cursor += part.length
  }
  const centralOffset = cursor
  const centralParts = archive.entries.map((entry) => {
    const central = Buffer.from(entry.central)
    const localOffset = localOffsets.get(entry.name)
    if (localOffset === undefined || localOffset > 0xffffffff) throw new Error(`XLSX local entry offset is invalid: ${entry.name}`)
    central.writeUInt32LE(localOffset, 42)
    if (entry.name === name) {
      central.writeUInt32LE(crc32(content), 16)
      central.writeUInt32LE(replacement.compressedSize, 20)
      central.writeUInt32LE(content.length, 24)
    }
    return central
  })
  const central = Buffer.concat(centralParts)
  const end = Buffer.from(buffer.subarray(archive.endOffset))
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([
    ...localParts,
    central,
    buffer.subarray(archive.centralEnd, archive.endOffset),
    end,
  ])
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/g)) result[match[1]!] = he.decode(match[3]!)
  return result
}

function sheetPartName(workbook: Buffer, sheetName: string): string {
  const workbookXml = readOoxmlPart(workbook, 'xl/workbook.xml').toString('utf8')
  const relationId = [...workbookXml.matchAll(/<sheet\b[^>]*\/?\s*>/g)]
    .map((match) => attributes(match[0]))
    .find((item) => item.name === sheetName)?.['r:id']
  if (!relationId) throw new Error(`XLSX workbook does not contain test-case sheet ${sheetName}`)
  const relationshipsXml = readOoxmlPart(workbook, 'xl/_rels/workbook.xml.rels').toString('utf8')
  const target = [...relationshipsXml.matchAll(/<Relationship\b[^>]*\/?\s*>/g)]
    .map((match) => attributes(match[0]))
    .find((item) => item.Id === relationId)?.Target
  if (!target) throw new Error(`XLSX workbook does not map sheet ${sheetName} to a worksheet part`)
  const part = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('xl', target))
  if (!part.startsWith('xl/')) throw new Error(`XLSX worksheet relation escapes workbook package: ${sheetName}`)
  return part
}

function columnIndex(reference: string): number | undefined {
  const match = /^\$?([A-Z]+)\$?\d+$/i.exec(reference)
  if (!match) return undefined
  let value = 0
  for (const character of match[1]!.toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64
  return value - 1
}

function highestColumn(sheetXml: string): number {
  let highest = -1
  const dimension = /<dimension\b[^>]*\bref=(["'])(.*?)\1[^>]*\/?\s*>/.exec(sheetXml)?.[2]
  if (dimension) {
    for (const reference of dimension.split(':')) highest = Math.max(highest, columnIndex(reference.replace(/\$/g, '')) ?? -1)
  }
  for (const match of sheetXml.matchAll(/<c\b[^>]*\br=(["'])(.*?)\1[^>]*\/?\s*>/g)) {
    highest = Math.max(highest, columnIndex(match[2]!.replace(/\$/g, '')) ?? -1)
  }
  return highest
}

function encodeInlineCell(reference: string, value: string): string {
  const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  const space = /^\s|\s$/.test(value) ? ' xml:space="preserve"' : ''
  return `<c r="${reference}" t="inlineStr"><is><t${space}>${escaped}</t></is></c>`
}

function rowBounds(xml: string, rowNumber: number): { start: number; contentStart: number; end: number } | undefined {
  const tag = /<row\b[^>]*>/g
  for (const match of xml.matchAll(tag)) {
    const row = Number(attributes(match[0]).r)
    if (row !== rowNumber) continue
    const start = match.index!
    const contentStart = start + match[0].length
    const end = xml.indexOf('</row>', contentStart)
    if (end < 0) throw new Error(`Worksheet row ${rowNumber} is not closed`)
    return { start, contentStart, end }
  }
  return undefined
}

function inlineCellText(xml: string): string {
  const match = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(xml)
  return match ? he.decode(match[1]!) : ''
}

function findExistingResultColumns(xml: string, headerRow: number): number[] | undefined {
  const bounds = rowBounds(xml, headerRow)
  if (!bounds) return undefined
  const row = xml.slice(bounds.contentStart, bounds.end)
  const labels = new Map<string, number>()
  for (const cell of row.matchAll(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)) {
    const reference = attributes(cell[0]).r
    const column = reference ? columnIndex(reference.replace(/\$/g, '')) : undefined
    if (column === undefined) continue
    labels.set(inlineCellText(cell[0]), column)
  }
  const columns = resultColumns.map(([label]) => labels.get(label))
  return columns.every((column): column is number => column !== undefined) ? columns : undefined
}

function setCellsInRow(xml: string, rowNumber: number, cells: string[], references: string[]): string {
  const bounds = rowBounds(xml, rowNumber)
  if (!bounds) {
    const row = `<row r="${rowNumber}">${cells.join('')}</row>`
    const sheetDataClose = xml.indexOf('</sheetData>')
    if (sheetDataClose >= 0) return `${xml.slice(0, sheetDataClose)}${row}${xml.slice(sheetDataClose)}`
    return xml.replace(/<sheetData\s*\/>/, `<sheetData>${row}</sheetData>`)
  }
  const content = xml.slice(bounds.contentStart, bounds.end)
  const expected = new Set(references)
  const retained = content.replace(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g, (cell) => {
    const reference = attributes(cell).r?.replace(/\$/g, '')
    return reference && expected.has(reference) ? '' : cell
  })
  return `${xml.slice(0, bounds.contentStart)}${retained}${cells.join('')}${xml.slice(bounds.end)}`
}

function updateDimension(xml: string, finalColumn: number, firstRow: number, finalRow: number): string {
  const match = /<dimension\b[^>]*\bref=(["'])(.*?)\1[^>]*\/?\s*>/.exec(xml)
  if (!match) return xml
  const references = match[2]!.split(':')
  const currentFirst = references[0]!.replace(/\$/g, '')
  const currentLast = references.at(-1)!.replace(/\$/g, '')
  const currentFirstColumn = columnIndex(currentFirst) ?? 0
  const currentFirstRow = Number(/\d+$/.exec(currentFirst)?.[0] ?? firstRow)
  const currentColumn = columnIndex(currentLast) ?? finalColumn
  const currentRow = Number(/\d+$/.exec(currentLast)?.[0] ?? finalRow)
  const first = `${utils.encode_col(currentFirstColumn)}${Math.min(currentFirstRow, firstRow)}`
  const last = `${utils.encode_col(Math.max(currentColumn, finalColumn))}${Math.max(currentRow, finalRow)}`
  return `${xml.slice(0, match.index)}${match[0]!.replace(match[2]!, `${first}:${last}`)}${xml.slice(match.index! + match[0]!.length)}`
}

function statusLabel(outcome: CodexTestCaseResult['outcome']): string {
  return outcome === 'passed' ? '通过' : outcome === 'product_failed' ? '产品不符合预期' : '阻断'
}

function sourceLabel(source: CodexTestCaseResult['failureSource']): string {
  const labels = {
    product: '产品/业务',
    agent_execution: '代理执行',
    environment: '环境/权限/测试数据',
    input: '测试输入',
    infrastructure: '基础设施',
  } as const
  return source ? labels[source] : ''
}

function kindLabel(kind: CodexTestCaseResult['failureKind']): string {
  const labels = {
    assertion: '断言',
    validation: '校验',
    authentication: '认证',
    environment: '环境',
    data: '测试数据',
    execution: '执行',
  } as const
  return kind ? labels[kind] : ''
}

function safeCellText(value: string): string {
  return redactSensitiveContent(value).replace(/\u0000/g, '').slice(0, 8_000)
}

function caseValues(result: CodexTestCaseResult): Record<ResultColumnKey, string> {
  return {
    status: statusLabel(result.outcome),
    failureSource: sourceLabel(result.failureSource),
    failureKind: kindLabel(result.failureKind),
    summary: safeCellText(result.summary),
    evidence: [
      ...result.evidence.map((item) => item.path).filter((path): path is string => Boolean(path)),
      ...(result.executionReceiptIds?.map((id) => `receipt:${id}`) ?? []),
    ].join('\n') || 'codex-agent.result.json',
    environment: result.environmentRequirementIds?.join('\n') ?? '',
  }
}

function patchWorksheet(xml: string, manifest: WorkflowIntakeManifest, result: CodexTestAgentResult): string {
  const sourceRows = manifest.phases.map((phase) => phase.sourceRow)
  const firstRow = Math.min(...sourceRows)
  const headerRow = firstRow > 1 ? firstRow - 1 : firstRow
  const hasSeparateHeader = headerRow !== firstRow
  const existingColumns = hasSeparateHeader ? findExistingResultColumns(xml, headerRow) : undefined
  const columns = existingColumns ?? resultColumns.map((_, index) => highestColumn(xml) + index + 1)
  let patched = xml
  if (hasSeparateHeader && !existingColumns) {
    const references = columns.map((column) => `${utils.encode_col(column)}${headerRow}`)
    patched = setCellsInRow(patched, headerRow, resultColumns.map(([label], index) => encodeInlineCell(references[index]!, label)), references)
  }
  const byCaseId = new Map(result.cases.map((item) => [item.caseId, item]))
  for (const phase of manifest.phases) {
    const caseResult = byCaseId.get(phase.id)
    if (!caseResult) throw new Error(`Result workbook is missing case ${phase.id}`)
    const values = caseValues(caseResult)
    const output = resultColumns.map(([, key]) => hasSeparateHeader ? values[key] : `${resultColumns.find((column) => column[1] === key)![0]}：${values[key]}`)
    const references = columns.map((column) => `${utils.encode_col(column)}${phase.sourceRow}`)
    patched = setCellsInRow(patched, phase.sourceRow, output.map((value, index) => encodeInlineCell(references[index]!, value)), references)
  }
  return updateDimension(patched, Math.max(...columns), Math.min(...sourceRows, headerRow), Math.max(...sourceRows, headerRow))
}

export async function writeResultWorkbook(options: {
  sourceFilePath: string
  outputDirectory: string
  manifest: WorkflowIntakeManifest
  result: CodexTestAgentResult
}): Promise<ResultWorkbookArtifact> {
  const source = await readFile(options.sourceFilePath)
  const part = sheetPartName(source, options.manifest.source.sheetName)
  const sheet = readOoxmlPart(source, part).toString('utf8')
  const outputName = `${basename(options.sourceFilePath, extname(options.sourceFilePath))}-Auto-Test-结果.xlsx`
  const path = resolve(options.outputDirectory, outputName)
  const patched = replaceOoxmlPart(source, part, Buffer.from(patchWorksheet(sheet, options.manifest, options.result), 'utf8'))
  await writeFile(path, patched, { mode: 0o600 })
  return { path, sheetName: options.manifest.source.sheetName }
}
