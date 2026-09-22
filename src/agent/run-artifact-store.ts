import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { WorkflowIntakeManifest } from '../workflow/types.js'
import { caseResultPath, readCaseResultRecords, type CodexCaseResultRecord } from './case-result-store.js'
import { readExecutionReceipts } from './execution-receipts.js'
import { readEnvironmentRequirements } from './environment-requirements.js'
import { writePrivateJson } from './state.js'
import type {
  CodexTestCaseDecision,
  CodexTestEnvironmentRequirement,
  CodexTestExecutionReceipt,
  CodexTestFieldCompositionGate,
  CodexTestMutationLedgerEntry,
} from './types.js'

/**
 * Canonical location of every run journal artifact under one run root. The
 * store derives this layout; no other module may re-derive a journal path.
 */
export interface RunArtifactLayout {
  /** Immutable run identity record a resumed run is checked against. */
  manifestPath: string
  mutationLedgerPath: string
  environmentRequirementsPath: string
  executionReceiptsPath: string
  fieldCompositionsPath: string
  caseResultsPath: string
  /** One hashed record per recorded Case; absent until the first record is written. */
  caseResultRecordsDirectory: string
}

const PRIVATE_DIRECTORY = '.agent-private'
const WORKSPACE_DIRECTORY = 'agent-workspace'

/**
 * Artifacts a new run starts with. A resumed run creates the same ones, except
 * those it must never recreate: writing them would erase the run's own record.
 */
const NEW_RUN_ARTIFACTS = [
  'mutationLedgerPath',
  'environmentRequirementsPath',
  'executionReceiptsPath',
  'fieldCompositionsPath',
  'caseResultsPath',
] as const
const NEVER_RECREATED_ARTIFACTS = new Set<(typeof NEW_RUN_ARTIFACTS)[number]>(['mutationLedgerPath', 'caseResultsPath'])
const RESUME_CREATED_ARTIFACTS = NEW_RUN_ARTIFACTS
  .filter((artifact) => !NEVER_RECREATED_ARTIFACTS.has(artifact))

export function runArtifactLayout(runRoot: string): RunArtifactLayout {
  const root = resolve(runRoot)
  const privateDirectory = resolve(root, PRIVATE_DIRECTORY)
  const workspaceDirectory = resolve(root, WORKSPACE_DIRECTORY)
  return {
    manifestPath: resolve(workspaceDirectory, 'test-manifest.json'),
    mutationLedgerPath: resolve(privateDirectory, 'mutation-ledger.json'),
    environmentRequirementsPath: resolve(privateDirectory, 'environment-requirements.json'),
    executionReceiptsPath: resolve(workspaceDirectory, 'execution-receipts.json'),
    fieldCompositionsPath: resolve(privateDirectory, 'field-compositions.json'),
    caseResultsPath: resolve(workspaceDirectory, 'case-results.json'),
    caseResultRecordsDirectory: resolve(privateDirectory, 'case-results'),
  }
}

/** The immutable run identity every read-back entry is checked against. */
export interface RunArtifactIdentity {
  workflowId: string
  sourceSha256: string
  /** Immutable Case membership; an entry naming anything outside it is rejected. */
  caseIds: string[]
}

export function runArtifactIdentity(manifest: WorkflowIntakeManifest): RunArtifactIdentity {
  return {
    workflowId: manifest.workflowId,
    sourceSha256: manifest.source.sha256,
    caseIds: manifest.phases.map((phase) => phase.id),
  }
}

/**
 * What one absent artifact means. `empty` is a journal with nothing recorded
 * yet; `error` is a run root that does not hold an initialized run. Callers
 * cannot confuse the two because every read reports which one it saw.
 */
export type RunArtifactMissingMeaning = 'empty' | 'error'

export interface RunArtifactRead<T> {
  missing: boolean
  missingMeans: RunArtifactMissingMeaning
  entries: T
  /** Identity and content rejections; entries are trustworthy only when this is empty. */
  problems: string[]
}

export interface RunArtifactStore {
  readonly runRoot: string
  readonly identity: RunArtifactIdentity
  readonly layout: RunArtifactLayout
  /** Create the journal of a new run, or bring a resumed run up to date. */
  initialize(options: { resume: boolean }): Promise<void>
  readMutationLedger(): Promise<RunArtifactRead<CodexTestMutationLedgerEntry[]>>
  readEnvironmentRequirements(): Promise<RunArtifactRead<CodexTestEnvironmentRequirement[]>>
  readExecutionReceipts(): Promise<RunArtifactRead<CodexTestExecutionReceipt[]>>
  readFieldCompositionGates(): Promise<RunArtifactRead<CodexTestFieldCompositionGate[]>>
  readCaseResultDecisions(): Promise<RunArtifactRead<CodexTestCaseDecision[]>>
  readCaseResultRecords(): Promise<RunArtifactRead<CodexCaseResultRecord[]>>
  /** Canonical storage location of one Case's result record. */
  caseResultRecordPath(caseId: string): string
}

export interface OpenRunArtifactStoreOptions {
  /** The run root that owns the journal; every artifact path is derived from it. */
  runRoot: string
  /** The immutable run identity; every read-back entry is checked against it. */
  manifest: WorkflowIntakeManifest
}

/**
 * Open the run journal of one run root. Path layout, initialization, and
 * read-back identity live here so that Runner, control-server MCP tools,
 * Recovery, comparison, and observe consumers share one rule set instead of
 * re-deriving paths and validation per caller.
 */
export function openRunArtifactStore(options: OpenRunArtifactStoreOptions): RunArtifactStore {
  return new FilesystemRunArtifactStore(options)
}

/** One validated journal reading: entries plus the identity rejections behind them. */
interface JournalConversion<E> {
  entries: E[]
  problems: string[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function existsPath(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

function missingProblem(label: string, path: string): string {
  return `${label} is missing under ${path}; the run root is not an initialized Auto-Test run`
}

function unknownCaseProblem(label: string, caseId: string, id?: string): string {
  return `${label}${id ? ` ${id}` : ''} references an unknown case ${caseId}`
}

async function readArrayArtifact(
  label: string,
  path: string,
): Promise<{ missing: boolean; value: unknown[]; problems: string[] }> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true, value: [], problems: [] }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { missing: false, value: [], problems: [`${label} is not valid JSON: ${errorMessage(error)}`] }
  }
  if (!Array.isArray(parsed)) {
    return { missing: false, value: [], problems: [`${label} is invalid: expected a JSON array of entries`] }
  }
  return { missing: false, value: parsed, problems: [] }
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
}

function isMutationLedgerEntry(value: unknown): value is CodexTestMutationLedgerEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string' &&
    typeof entry.caseId === 'string' &&
    typeof entry.description === 'string' &&
    (entry.risk === 'write' || entry.risk === 'destructive') &&
    (entry.status === 'pending' || entry.status === 'compensated' || entry.status === 'accepted') &&
    isIsoTimestamp(entry.createdAt) &&
    isIsoTimestamp(entry.updatedAt) &&
    Array.isArray(entry.evidence) &&
    entry.evidence.every((item) => typeof item === 'string')
}

function isFieldCompositionGate(value: unknown): value is CodexTestFieldCompositionGate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const gate = value as Partial<CodexTestFieldCompositionGate>
  return typeof gate.id === 'string' && typeof gate.caseId === 'string'
}

function isCaseResultDecision(value: unknown): value is CodexTestCaseDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const decision = value as Partial<CodexTestCaseDecision>
  return typeof decision.caseId === 'string'
}

function isExecutionReceipt(value: unknown): value is CodexTestExecutionReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return typeof (value as Partial<CodexTestExecutionReceipt>).id === 'string'
}

function mutationLedgerEntries(
  raw: unknown[],
  identity: RunArtifactIdentity,
): JournalConversion<CodexTestMutationLedgerEntry> {
  const entries: CodexTestMutationLedgerEntry[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const [index, value] of raw.entries()) {
    if (!isMutationLedgerEntry(value)) {
      problems.push(`Mutation Ledger entry ${index} does not match the run contract`)
      continue
    }
    if (!identity.caseIds.includes(value.caseId)) {
      problems.push(unknownCaseProblem('Mutation Ledger entry', value.caseId, value.id))
      continue
    }
    if (seen.has(value.id)) {
      problems.push(`Mutation Ledger contains a duplicate entry id ${value.id}`)
      continue
    }
    seen.add(value.id)
    entries.push(value)
  }
  return { entries, problems }
}

function fieldCompositionGates(
  raw: unknown[],
  identity: RunArtifactIdentity,
): JournalConversion<CodexTestFieldCompositionGate> {
  const entries: CodexTestFieldCompositionGate[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (!isFieldCompositionGate(value)) {
      problems.push('Field composition gate is malformed: expected an object with an id and a caseId')
      continue
    }
    if (!identity.caseIds.includes(value.caseId)) {
      problems.push(unknownCaseProblem('Field composition gate', value.caseId, value.id))
      continue
    }
    if (seen.has(value.id)) {
      problems.push(`Field composition gate ${value.id} is recorded more than once`)
      continue
    }
    seen.add(value.id)
    entries.push(value)
  }
  return { entries, problems }
}

function caseResultDecisions(
  raw: unknown[],
  identity: RunArtifactIdentity,
): JournalConversion<CodexTestCaseDecision> {
  const entries: CodexTestCaseDecision[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (!isCaseResultDecision(value)) {
      problems.push('Case result decision is malformed: expected an object with a caseId')
      continue
    }
    if (!identity.caseIds.includes(value.caseId)) {
      problems.push(unknownCaseProblem('Case result decision', value.caseId))
      continue
    }
    if (seen.has(value.caseId)) {
      problems.push(`Case result decision for ${value.caseId} is recorded more than once`)
      continue
    }
    seen.add(value.caseId)
    entries.push(value)
  }
  return { entries, problems }
}

function environmentRequirementProblems(
  requirements: CodexTestEnvironmentRequirement[],
  identity: RunArtifactIdentity,
): string[] {
  return requirements.flatMap((requirement) => requirement.caseIds
    .filter((caseId) => !identity.caseIds.includes(caseId))
    .map((caseId) => unknownCaseProblem('Environment requirement', caseId, requirement.id)))
}

function executionReceiptProblems(
  receipts: CodexTestExecutionReceipt[],
  identity: RunArtifactIdentity,
): string[] {
  const problems: string[] = []
  for (const [index, receipt] of receipts.entries()) {
    if (!isExecutionReceipt(receipt)) {
      problems.push(`Execution receipt ${index} is malformed: expected an object with an id`)
      continue
    }
    if (receipt.caseId && !identity.caseIds.includes(receipt.caseId)) {
      problems.push(unknownCaseProblem('Execution receipt', receipt.caseId, receipt.id))
    }
  }
  return problems
}

class FilesystemRunArtifactStore implements RunArtifactStore {
  readonly runRoot: string
  readonly identity: RunArtifactIdentity
  readonly layout: RunArtifactLayout
  private readonly manifest: WorkflowIntakeManifest

  constructor(options: OpenRunArtifactStoreOptions) {
    this.runRoot = resolve(options.runRoot)
    this.manifest = options.manifest
    this.identity = runArtifactIdentity(options.manifest)
    this.layout = runArtifactLayout(this.runRoot)
  }

  caseResultRecordPath(caseId: string): string {
    return caseResultPath(this.layout.caseResultRecordsDirectory, caseId)
  }

  async initialize(options: { resume: boolean }): Promise<void> {
    if (options.resume) {
      await this.assertResumeIdentity()
      for (const artifact of RESUME_CREATED_ARTIFACTS) {
        if (!await existsPath(this.layout[artifact])) await writePrivateJson(this.layout[artifact], [])
      }
      return
    }
    for (const artifact of NEW_RUN_ARTIFACTS) {
      await writePrivateJson(this.layout[artifact], [])
    }
  }

  async readMutationLedger(): Promise<RunArtifactRead<CodexTestMutationLedgerEntry[]>> {
    return this.readJournal('Mutation Ledger', this.layout.mutationLedgerPath, 'error',
      (raw) => mutationLedgerEntries(raw, this.identity))
  }

  async readFieldCompositionGates(): Promise<RunArtifactRead<CodexTestFieldCompositionGate[]>> {
    return this.readJournal('Field compositions', this.layout.fieldCompositionsPath, 'empty',
      (raw) => fieldCompositionGates(raw, this.identity))
  }

  async readCaseResultDecisions(): Promise<RunArtifactRead<CodexTestCaseDecision[]>> {
    return this.readJournal('Case results', this.layout.caseResultsPath, 'empty',
      (raw) => caseResultDecisions(raw, this.identity))
  }

  /**
   * Artifacts whose entry normalization already lives in their own store
   * helper. The helper owns how one entry is parsed; the store still owns what
   * an absent artifact means, so each of these treats a missing file as an
   * empty journal instead of as a failed run.
   */
  async readEnvironmentRequirements(): Promise<RunArtifactRead<CodexTestEnvironmentRequirement[]>> {
    const path = this.layout.environmentRequirementsPath
    const missing = !await existsPath(path)
    let entries: CodexTestEnvironmentRequirement[]
    try {
      entries = await readEnvironmentRequirements(path)
    } catch (error) {
      return { missing, missingMeans: 'empty', entries: [], problems: [`Environment requirements could not be read: ${errorMessage(error)}`] }
    }
    const problems = environmentRequirementProblems(entries, this.identity)
    return { missing, missingMeans: 'empty', entries: problems.length === 0 ? entries : [], problems }
  }

  async readExecutionReceipts(): Promise<RunArtifactRead<CodexTestExecutionReceipt[]>> {
    const path = this.layout.executionReceiptsPath
    const missing = !await existsPath(path)
    let entries: CodexTestExecutionReceipt[]
    try {
      entries = await readExecutionReceipts(path)
    } catch (error) {
      return { missing, missingMeans: 'empty', entries: [], problems: [`Execution receipts could not be read: ${errorMessage(error)}`] }
    }
    const problems = executionReceiptProblems(entries, this.identity)
    return { missing, missingMeans: 'empty', entries: problems.length === 0 ? entries : [], problems }
  }

  async readCaseResultRecords(): Promise<RunArtifactRead<CodexCaseResultRecord[]>> {
    const directory = this.layout.caseResultRecordsDirectory
    const missing = !await existsPath(directory)
    try {
      const records = await readCaseResultRecords(directory, this.manifest)
      return { missing, missingMeans: 'empty', entries: records, problems: [] }
    } catch (error) {
      return {
        missing,
        missingMeans: 'empty',
        entries: [],
        problems: [`Case result records could not be read: ${errorMessage(error)}`],
      }
    }
  }

  /**
   * Read one artifact whose entries the store validates itself. A missing
   * artifact keeps the artifact's own meaning instead of being reported as an
   * empty or as a failed read by every caller.
   */
  private async readJournal<E>(
    label: string,
    path: string,
    missingMeans: RunArtifactMissingMeaning,
    convert: (raw: unknown[]) => JournalConversion<E>,
  ): Promise<RunArtifactRead<E[]>> {
    const artifact = await readArrayArtifact(label, path)
    const converted = convert(artifact.value)
    const problems = [...artifact.problems, ...converted.problems]
    return {
      missing: artifact.missing,
      missingMeans,
      // A journal with one rejected entry is not partly readable: callers that
      // ignore the problem list must never act on a subset of the truth.
      entries: problems.length === 0 ? converted.entries : [],
      problems: [...problems, ...(artifact.missing && missingMeans === 'error' ? [missingProblem(label, path)] : [])],
    }
  }

  private async assertResumeIdentity(): Promise<void> {
    let persisted: WorkflowIntakeManifest
    try {
      persisted = JSON.parse(await readFile(this.layout.manifestPath, 'utf8')) as WorkflowIntakeManifest
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Cannot resume a run without its persisted test manifest: ${this.layout.manifestPath}`)
      }
      throw error
    }
    if (persisted.workflowId !== this.manifest.workflowId || persisted.source.sha256 !== this.manifest.source.sha256) {
      throw new Error('Resume input does not match the existing Auto-Test workflow identity')
    }
  }
}
