import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'
import { CFB } from '@e965/xlsx'
import { XMLParser } from 'fast-xml-parser'
import type { ExtractedWorkflowAsset, WorkflowEmbeddedImage } from './types.js'

export type ExtractedWpsCellImage = ExtractedWorkflowAsset & { metadata: WorkflowEmbeddedImage }

export interface FormulaImageCell {
  formulaId: string
  sheetName: string
  sourceCell: string
  sourceRow: number
}

export interface WpsCellImageIndexEntry {
  formulaId: string
  target: string
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
})

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function arrayOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

export function parseWpsCellImageIndex(cellImagesXml: string, relationshipsXml: string): WpsCellImageIndexEntry[] {
  const relationships = record(xmlParser.parse(relationshipsXml)).Relationships
  const targetByRelationship = new Map<string, string>()
  for (const value of arrayOf(record(relationships).Relationship)) {
    const relationship = record(value)
    const id = text(relationship.Id)
    const target = text(relationship.Target)
    if (id && target) targetByRelationship.set(id, target)
  }

  const cellImages = record(xmlParser.parse(cellImagesXml)).cellImages
  const entries: WpsCellImageIndexEntry[] = []
  for (const value of arrayOf(record(cellImages).cellImage)) {
    const pic = record(record(value).pic)
    const formulaId = text(record(record(pic.nvPicPr).cNvPr).name)
    const relationshipId = text(record(record(pic.blipFill).blip).embed)
    const target = targetByRelationship.get(relationshipId)
    if (formulaId && target) entries.push({ formulaId, target })
  }
  return entries
}

function containerEntries(file: Buffer): Map<string, Buffer> {
  const container = CFB.read(file, { type: 'buffer' })
  const entries = new Map<string, Buffer>()
  container.FullPaths.forEach((fullPath: string, index: number) => {
    const normalized = fullPath.replace(/^Root Entry\//, '')
    const content = container.FileIndex[index]?.content
    if (!normalized.endsWith('/') && content) entries.set(normalized, Buffer.from(content))
  })
  return entries
}

export function mediaTypeForPath(path: string): string {
  const extension = extname(path).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.gif') return 'image/gif'
  if (extension === '.webp') return 'image/webp'
  return 'application/octet-stream'
}

export function extractWpsCellImages(file: Buffer, cells: FormulaImageCell[]): ExtractedWpsCellImage[] {
  if (!cells.length) return []
  const entries = containerEntries(file)
  const cellImagesXml = entries.get('xl/cellimages.xml')
  const relationshipsXml = entries.get('xl/_rels/cellimages.xml.rels')
  if (!cellImagesXml || !relationshipsXml) return []

  const cellByFormulaId = new Map(cells.map((cell) => [cell.formulaId, cell]))
  return parseWpsCellImageIndex(cellImagesXml.toString('utf8'), relationshipsXml.toString('utf8'))
    .flatMap((entry, index): ExtractedWpsCellImage[] => {
      const cell = cellByFormulaId.get(entry.formulaId)
      if (!cell) return []
      const path = `xl/${entry.target.replace(/^\.?\//, '')}`
      const content = entries.get(path)
      if (!content) return []
      const originalName = basename(entry.target)
      const fileName = `${cell.sheetName}-${cell.sourceCell}-${index + 1}-${originalName}`
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      const metadata: WorkflowEmbeddedImage = {
        id: `image-${cell.sheetName}-${cell.sourceCell}`,
        sheetName: cell.sheetName,
        sourceCell: cell.sourceCell,
        sourceRow: cell.sourceRow,
        fileName,
        mediaType: mediaTypeForPath(entry.target),
        bytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
        reviewStatus: 'required',
      }
      return [{ metadata, content }]
    })
}
