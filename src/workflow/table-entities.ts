import { createHash } from 'node:crypto'

export interface SelectedEntityRow {
  id: string
  rowIndex: number
  rowText: string
  rowSha256: string
}

function normalizedMatchText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

const ACTION_ALIASES: ReadonlyArray<{ pattern: RegExp; aliases: readonly string[] }> = [
  { pattern: /^(?:delete|remove)$/i, aliases: ['delete', 'remove', '删除', '移除'] },
  { pattern: /^(?:stop|force\s*stop)$/i, aliases: ['stop', 'force stop', '停止', '强停', '关停'] },
]

export function actionNameCandidates(actionNames: string[]): string[] {
  const candidates = new Set<string>()
  for (const actionName of actionNames) {
    const normalized = normalizedMatchText(actionName)
    if (normalized) candidates.add(normalized)
    for (const group of ACTION_ALIASES) {
      if (!group.pattern.test(normalized)) continue
      for (const alias of group.aliases) candidates.add(normalizedMatchText(alias))
    }
  }
  return [...candidates]
}

export function missingTableHeaderLabels(headerText: string, labels: string[]): string[] {
  const normalizedHeader = normalizedMatchText(headerText)
  return labels.filter((label) => !normalizedHeader.includes(normalizedMatchText(label)))
}

export function selectUniqueEntityRow(rows: string[], matches: string[], idPattern: RegExp, exclusions: string[] = []): SelectedEntityRow {
  const normalizedMatches = matches.map(normalizedMatchText)
  const normalizedExclusions = exclusions.map(normalizedMatchText)
  const candidates = rows
    .map((rowText, rowIndex) => ({ rowText, rowIndex, normalized: normalizedMatchText(rowText) }))
    .filter((row) => normalizedMatches.every((match) => row.normalized.includes(match)) && normalizedExclusions.every((excluded) => !row.normalized.includes(excluded)))
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one matching entity row; found ${candidates.length}`)
  }
  const candidate = candidates[0]!
  const values = [candidate.rowText, ...candidate.rowText.split(/\s+/).filter(Boolean)]
  const id = values.reduce<string | undefined>((captured, value) => {
    if (captured) return captured
    idPattern.lastIndex = 0
    return idPattern.exec(value)?.[1]
  }, undefined)
  if (!id) throw new Error('Matched entity row does not contain the configured ID pattern')
  return {
    id,
    rowIndex: candidate.rowIndex,
    rowText: candidate.rowText,
    rowSha256: createHash('sha256').update(candidate.rowText).digest('hex'),
  }
}

export function alignedActionRowIndex(dataRows: string[], actionRows: string[], entityId: string, actionNames: string[]): number {
  const normalizedEntityId = normalizedMatchText(entityId)
  const matching = dataRows.map((row, index) => normalizedMatchText(row).includes(normalizedEntityId) ? index : -1).filter((index) => index >= 0)
  if (matching.length !== 1) throw new Error(`Expected exactly one data row for entity ${entityId}; found ${matching.length}`)
  const rowIndex = matching[0]!
  const actionText = actionRows[rowIndex]
  if (actionText === undefined) throw new Error(`Action table is missing row ${rowIndex} for entity ${entityId}`)
  if (!actionNameCandidates(actionNames).some((name) => normalizedMatchText(actionText).includes(name))) {
    throw new Error(`Aligned action row does not contain an allowed action for entity ${entityId}`)
  }
  return rowIndex
}

export function entityAlreadyStoppedForAction(
  dataRows: string[],
  actionRows: string[],
  entityId: string,
  actionNames: string[],
): boolean {
  if (!actionNames.some((name) => /停止|强停|stop|force\s*stop/i.test(name))) return false
  const normalizedEntityId = normalizedMatchText(entityId)
  const matching = dataRows.map((row, index) => normalizedMatchText(row).includes(normalizedEntityId) ? index : -1).filter((index) => index >= 0)
  if (matching.length !== 1) return false
  const rowIndex = matching[0]!
  const dataText = dataRows[rowIndex] ?? ''
  const actionText = actionRows[rowIndex] ?? ''
  return /离线|已停止|未运行|offline|stopped|not\s*running/i.test(dataText) &&
    !actionNameCandidates(actionNames).some((name) => normalizedMatchText(actionText).includes(name))
}
