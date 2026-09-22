import { resolve } from 'node:path'
import type { WorkflowIntakeManifest } from '../workflow/types.js'
import {
  caseResultRecordFileName,
  openRunArtifactStore,
  runArtifactLayout,
  runRootForJournalArtifact,
  type CodexCaseResultRecord,
} from './run-artifact-store.js'
import type { CodexTestCaseResult } from './types.js'

/**
 * This module is a set of compatibility delegates over the RunArtifactStore.
 * The store owns where a per-Case result record lives, what it must contain,
 * and which stored records may be read back; the signatures here remain for
 * callers that still pass a record directory, and go away with the last of them.
 */
export type { CodexCaseResultRecord } from './run-artifact-store.js'

export function caseResultDirectory(runDirectory: string): string {
  return runArtifactLayout(runDirectory).caseResultRecordsDirectory
}

export function caseResultPath(directory: string, caseId: string): string {
  return resolve(directory, caseResultRecordFileName(caseId))
}

export async function writeCaseResultRecords(
  directory: string,
  manifest: WorkflowIntakeManifest,
  epochId: string,
  cases: CodexTestCaseResult[],
): Promise<void> {
  await openRunArtifactStore({ runRoot: runRootForJournalArtifact(directory), manifest })
    .recordCaseResults({ epochId, cases })
}

export async function readCaseResultRecords(
  directory: string,
  manifest: WorkflowIntakeManifest,
): Promise<CodexCaseResultRecord[]> {
  const records = await openRunArtifactStore({ runRoot: runRootForJournalArtifact(directory), manifest })
    .readCaseResultRecords()
  if (records.problems.length > 0) throw new Error(records.problems.join('; '))
  return records.entries
}
