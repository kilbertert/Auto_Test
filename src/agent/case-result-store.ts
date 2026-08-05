import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { WorkflowIntakeManifest } from '../workflow/types.js'
import { writePrivateJson } from './state.js'
import type { CodexTestCaseResult } from './types.js'

export interface CodexCaseResultRecord {
  version: '1.0'
  workflowId: string
  sourceSha256: string
  epochId: string
  recordedAt: string
  result: CodexTestCaseResult
}

export function caseResultDirectory(runDirectory: string): string {
  return resolve(runDirectory, '.agent-private', 'case-results')
}

export function caseResultPath(directory: string, caseId: string): string {
  const safeId = createHash('sha256').update(caseId).digest('hex').slice(0, 24)
  return resolve(directory, `${safeId}.json`)
}

export async function writeCaseResultRecords(
  directory: string,
  manifest: WorkflowIntakeManifest,
  epochId: string,
  cases: CodexTestCaseResult[],
): Promise<void> {
  const allowed = new Set(manifest.phases.map((phase) => phase.id))
  const seen = new Set<string>()
  for (const result of cases) {
    if (!allowed.has(result.caseId)) throw new Error(`Cannot persist result for unknown case ${result.caseId}`)
    if (seen.has(result.caseId)) throw new Error(`Cannot persist duplicate result for case ${result.caseId}`)
    seen.add(result.caseId)
    await writePrivateJson(caseResultPath(directory, result.caseId), {
      version: '1.0',
      workflowId: manifest.workflowId,
      sourceSha256: manifest.source.sha256,
      epochId,
      recordedAt: new Date().toISOString(),
      result,
    } satisfies CodexCaseResultRecord)
  }
}

export async function readCaseResultRecords(
  directory: string,
  manifest: WorkflowIntakeManifest,
): Promise<CodexCaseResultRecord[]> {
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const allowed = new Set(manifest.phases.map((phase) => phase.id))
  const seen = new Set<string>()
  const records: CodexCaseResultRecord[] = []
  for (const entry of entries.filter((item) => item.endsWith('.json')).sort()) {
    const path = resolve(directory, entry)
    const record = JSON.parse(await readFile(path, 'utf8')) as CodexCaseResultRecord
    if (!record || typeof record !== 'object' || !record.result || typeof record.result.caseId !== 'string') {
      throw new Error(`Case result record is malformed: ${entry}`)
    }
    if (record.version !== '1.0' || record.workflowId !== manifest.workflowId || record.sourceSha256 !== manifest.source.sha256) {
      throw new Error(`Case result record identity does not match the current run: ${entry}`)
    }
    if (!allowed.has(record.result.caseId)) throw new Error(`Case result record contains an unknown case: ${record.result.caseId}`)
    if (entry !== basename(caseResultPath(directory, record.result.caseId)) || seen.has(record.result.caseId)) {
      throw new Error(`Case result record storage identity is invalid: ${entry}`)
    }
    seen.add(record.result.caseId)
    records.push(record)
  }
  return records
}
