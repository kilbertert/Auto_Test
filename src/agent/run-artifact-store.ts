import { createHash } from 'node:crypto'
import { access, readdir, readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { WorkflowIntakeManifest } from '../workflow/types.js'
import { ExecutionReceiptRecorder, readExecutionReceipts } from './execution-receipts.js'
import { writePrivateJson } from './state.js'
import type {
  CodexTestCaseDecision,
  CodexTestCaseResult,
  CodexTestEnvironmentRequirement,
  CodexTestEnvironmentRequirementKind,
  CodexTestExecutionReceipt,
  CodexTestFieldCompositionGate,
  CodexTestMutationLedgerEntry,
  CodexTestRisk,
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

/** One recorded Case result: the delivered result plus the run identity it belongs to. */
export interface CodexCaseResultRecord {
  version: '1.0'
  workflowId: string
  sourceSha256: string
  epochId: string
  recordedAt: string
  result: CodexTestCaseResult
}

/** What an origin access check answers when it does not grant access. */
export interface EnvironmentAccessResult {
  status: 'allowed' | 'blocked'
  origin: string
  requirementId?: string
  reason?: string
  evidence?: string[]
  requestedAt?: string
  nextAction?: string
}

/** One observed environment prerequisite, before it is normalized into a record. */
export interface EnvironmentRequirementInput {
  caseIds: string[]
  kind: CodexTestEnvironmentRequirementKind
  origin?: string
  condition: string
  evidence: string[]
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
 * Hashed file name of one Case's result record. The file name is the record's
 * storage identity: a record stored under any other name is rejected, so a
 * renamed or hand-placed file can never be read back as a Case result.
 */
export function caseResultRecordFileName(caseId: string): string {
  return `${createHash('sha256').update(caseId).digest('hex').slice(0, 24)}.json`
}

export function normalizeEnvironmentOrigin(value: string): string {
  const parsed = new URL(value)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Origin must use http or https')
  return parsed.origin
}

/**
 * The run root that owns one journal artifact path. Callers that still hand a
 * journal helper a single artifact path rather than the run root (the
 * compatibility delegates, and read-only consumers with a run directory)
 * recover the run root here, so the inverse of the layout stays in one place
 * instead of being guessed per caller.
 */
export function runRootForJournalArtifact(artifactPath: string): string {
  return resolve(artifactPath, '..', '..')
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
  /** Store one delivered Case result per Case, re-recording a Case without duplicating it. */
  recordCaseResults(input: { epochId: string; cases: CodexTestCaseResult[] }): Promise<CodexCaseResultRecord[]>
  /** Open a receipt recorder that appends to this run's canonical receipt artifact. */
  openExecutionReceiptRecorder(input: { caseIds: string[]; namespace?: string }): Promise<ExecutionReceiptRecorder>
  /** Record one observed environment prerequisite, merging a repeat observation of it. */
  recordEnvironmentRequirement(requirement: EnvironmentRequirementInput): Promise<CodexTestEnvironmentRequirement>
  /** Mark one recorded prerequisite satisfied after re-observing it. */
  satisfyEnvironmentRequirement(input: { id: string; evidence: string[] }): Promise<CodexTestEnvironmentRequirement>
  /** Record an unregistered origin as a resumable prerequisite instead of granting access. */
  requestEnvironmentAccess(input: {
    allowedOrigins: string[]
    origin: string
    reason: string
    evidence: string[]
    caseIds: string[]
  }): Promise<EnvironmentAccessResult>
  /** Satisfy pending prerequisites whose origin the Environment Profile now registers. */
  reconcileEnvironmentRequirements(allowedOrigins: string[]): Promise<CodexTestEnvironmentRequirement[]>
  /** Drop case links a recorded result no longer blames on the environment. */
  reconcileEnvironmentRequirementCaseLinks(cases: Array<Pick<CodexTestCaseResult, 'caseId' | 'failureSource' | 'environmentRequirementIds'>>): Promise<CodexTestEnvironmentRequirement[]>
  /** Register one business mutation before it is performed; the entry starts pending. */
  recordMutationLedgerEntry(input: {
    id: string
    caseId: string
    description: string
    risk: Exclude<CodexTestRisk, 'read'>
  }): Promise<CodexTestMutationLedgerEntry>
  /** Resolve one pending mutation as compensated or as an explicitly accepted retained state. */
  transitionMutationLedgerEntry(input: {
    id: string
    status: 'compensated' | 'accepted'
    evidence: string[]
  }): Promise<CodexTestMutationLedgerEntry>
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

function isRunIdentityManifest(value: unknown): value is WorkflowIntakeManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const manifest = value as Partial<WorkflowIntakeManifest>
  return typeof manifest.workflowId === 'string' &&
    typeof manifest.source?.sha256 === 'string' &&
    Array.isArray(manifest.phases)
}

/**
 * Open the journal of a run that already persisted its manifest. A caller that
 * holds a run directory but not the intake manifest (an observe consumer, a
 * comparison, or a compatibility delegate) loads the persisted run identity
 * instead of supplying its own, so read-back identity cannot drift.
 */
export async function openRunArtifactStoreForRun(runRoot: string): Promise<RunArtifactStore> {
  const layout = runArtifactLayout(runRoot)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(layout.manifestPath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Cannot open a run journal without its persisted test manifest: ${layout.manifestPath}`)
    }
    throw error
  }
  if (!isRunIdentityManifest(parsed)) {
    throw new Error(`The persisted test manifest is not a valid run identity: ${layout.manifestPath}`)
  }
  return openRunArtifactStore({ runRoot, manifest: parsed })
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

function stableRequirementId(input: Pick<EnvironmentRequirementInput, 'kind' | 'origin' | 'condition'>): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([input.kind, input.origin ?? '', input.condition.trim()]))
    .digest('hex')
    .slice(0, 16)
  return `environment-${input.kind}-${fingerprint}`
}

/**
 * Normalize one stored prerequisite. Older and hand-written entries are read
 * back through the same rules that recorded them, so a legacy `reason` field
 * keeps its meaning instead of silently dropping a recorded block.
 */
function normalizeRequirement(input: unknown): CodexTestEnvironmentRequirement {
  const item = input as Partial<CodexTestEnvironmentRequirement> & { reason?: unknown }
  const kind = item.kind === 'permission' || item.kind === 'authentication' || item.kind === 'test_data' || item.kind === 'physical'
    ? item.kind
    : 'origin'
  const origin = typeof item.origin === 'string' && item.origin.trim()
    ? normalizeEnvironmentOrigin(item.origin)
    : undefined
  const condition = typeof item.condition === 'string' && item.condition.trim()
    ? item.condition.trim()
    : typeof item.reason === 'string' && item.reason.trim()
      ? item.reason.trim()
      : 'An environment prerequisite was recorded without a condition.'
  const normalized: CodexTestEnvironmentRequirement = {
    id: typeof item.id === 'string' && item.id.trim()
      ? item.id.trim()
      : stableRequirementId({ kind, ...(origin ? { origin } : {}), condition }),
    caseIds: Array.isArray(item.caseIds)
      ? [...new Set(item.caseIds.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())))]
      : [],
    kind,
    ...(origin ? { origin } : {}),
    condition,
    evidence: Array.isArray(item.evidence)
      ? [...new Set(item.evidence.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())))]
      : [],
    status: item.status === 'satisfied' || item.status === 'superseded' ? item.status : 'pending',
    requestedAt: typeof item.requestedAt === 'string' && item.requestedAt.trim()
      ? item.requestedAt
      : new Date(0).toISOString(),
  }
  return normalized
}

/** Read the prerequisite journal as it stands on disk, defaulting an absent one to empty. */
async function readRequirements(path: string): Promise<CodexTestEnvironmentRequirement[]> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!Array.isArray(raw)) throw new Error('Environment requirements must be an array')
    return raw.map(normalizeRequirement)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function uniqueEvidence(evidence: string[]): string[] {
  return [...new Set(evidence.map((value) => value.trim()).filter(Boolean))]
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
    return resolve(this.layout.caseResultRecordsDirectory, caseResultRecordFileName(caseId))
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
   * Journal artifacts whose entries are normalized as they are read back, and
   * whose absence means "nothing recorded yet" rather than a failed run. The
   * store still owns what each read means, so no caller has to decide whether
   * one missing file is an empty journal or an uninitialized run.
   */
  async readEnvironmentRequirements(): Promise<RunArtifactRead<CodexTestEnvironmentRequirement[]>> {
    const path = this.layout.environmentRequirementsPath
    const missing = !await existsPath(path)
    let entries: CodexTestEnvironmentRequirement[]
    try {
      entries = await readRequirements(path)
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

  /**
   * One hashed record per recorded Case. Read-back rejects a record that is
   * malformed, that names another run or another Case, or that is stored under
   * a name that does not belong to its Case, instead of guessing which of
   * several same-shaped records is the real one.
   */
  async readCaseResultRecords(): Promise<RunArtifactRead<CodexCaseResultRecord[]>> {
    const directory = this.layout.caseResultRecordsDirectory
    let stored: string[]
    try {
      stored = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { missing: true, missingMeans: 'empty', entries: [], problems: [] }
      }
      throw error
    }
    const allowed = new Set(this.identity.caseIds)
    const seen = new Set<string>()
    const records: CodexCaseResultRecord[] = []
    const problems: string[] = []
    for (const entry of stored.filter((item) => item.endsWith('.json')).sort()) {
      const path = resolve(directory, entry)
      let record: CodexCaseResultRecord
      try {
        record = JSON.parse(await readFile(path, 'utf8')) as CodexCaseResultRecord
      } catch (error) {
        problems.push(`Case result record is not valid JSON: ${entry}: ${errorMessage(error)}`)
        continue
      }
      if (!record || typeof record !== 'object' || !record.result || typeof record.result.caseId !== 'string') {
        problems.push(`Case result record is malformed: ${entry}`)
        continue
      }
      if (record.version !== '1.0' || record.workflowId !== this.identity.workflowId || record.sourceSha256 !== this.identity.sourceSha256) {
        problems.push(`Case result record identity does not match the current run: ${entry}`)
        continue
      }
      if (!allowed.has(record.result.caseId)) {
        problems.push(`Case result record contains an unknown case: ${record.result.caseId}`)
        continue
      }
      if (entry !== basename(this.caseResultRecordPath(record.result.caseId)) || seen.has(record.result.caseId)) {
        problems.push(`Case result record storage identity is invalid: ${entry}`)
        continue
      }
      seen.add(record.result.caseId)
      records.push(record)
    }
    return {
      missing: false,
      missingMeans: 'empty',
      entries: problems.length === 0 ? records : [],
      problems,
    }
  }

  async recordCaseResults(input: { epochId: string; cases: CodexTestCaseResult[] }): Promise<CodexCaseResultRecord[]> {
    const seen = new Set<string>()
    const records: CodexCaseResultRecord[] = []
    for (const result of input.cases) {
      if (!this.identity.caseIds.includes(result.caseId)) {
        throw new Error(`Cannot persist result for unknown case ${result.caseId}`)
      }
      if (seen.has(result.caseId)) {
        throw new Error(`Cannot persist duplicate result for case ${result.caseId}`)
      }
      seen.add(result.caseId)
      records.push({
        version: '1.0',
        workflowId: this.identity.workflowId,
        sourceSha256: this.identity.sourceSha256,
        epochId: input.epochId,
        recordedAt: new Date().toISOString(),
        result,
      })
    }
    await Promise.all(records.map((record) => writePrivateJson(this.caseResultRecordPath(record.result.caseId), record)))
    return records
  }

  async openExecutionReceiptRecorder(input: { caseIds: string[]; namespace?: string }): Promise<ExecutionReceiptRecorder> {
    const path = this.layout.executionReceiptsPath
    return ExecutionReceiptRecorder.open({
      // A recorder that replayed receipts it was not allowed to read would
      // silently rewrite the journal, so an unreadable journal stops it here.
      read: async () => {
        const receipts = await this.readExecutionReceipts()
        if (receipts.problems.length > 0) {
          throw new Error(`Execution receipts could not be read: ${receipts.problems.join('; ')}`)
        }
        return receipts.entries
      },
      write: (receipts) => writePrivateJson(path, receipts),
    }, input.caseIds, input.namespace ?? 'single-thread')
  }

  async recordEnvironmentRequirement(requirement: EnvironmentRequirementInput): Promise<CodexTestEnvironmentRequirement> {
    const caseIds = [...new Set(requirement.caseIds.map((value) => value.trim()).filter(Boolean))]
    if (caseIds.length === 0) throw new Error('Environment requirement must apply to at least one test case')
    for (const caseId of caseIds) {
      if (!this.identity.caseIds.includes(caseId)) {
        throw new Error(`Cannot record an environment requirement for unknown case ${caseId}`)
      }
    }
    const condition = requirement.condition.trim()
    if (!condition) throw new Error('Environment requirement must state the observed missing condition')
    const evidence = uniqueEvidence(requirement.evidence)
    if (evidence.length === 0) throw new Error('Environment requirement must include saved evidence')
    const origin = requirement.origin ? normalizeEnvironmentOrigin(requirement.origin) : undefined
    if (requirement.kind === 'origin' && !origin) throw new Error('Origin requirements must include an origin')
    const id = stableRequirementId({ kind: requirement.kind, ...(origin ? { origin } : {}), condition })
    const requirements = await readRequirements(this.layout.environmentRequirementsPath)
    const existingIndex = requirements.findIndex((item) => item.id === id)
    const recorded: CodexTestEnvironmentRequirement = existingIndex >= 0
      ? {
          ...requirements[existingIndex]!,
          caseIds: [...new Set([...requirements[existingIndex]!.caseIds, ...caseIds])],
          evidence: [...new Set([...requirements[existingIndex]!.evidence, ...evidence])],
          status: 'pending',
          requestedAt: new Date().toISOString(),
        }
      : {
          id,
          caseIds,
          kind: requirement.kind,
          ...(origin ? { origin } : {}),
          condition,
          evidence,
          status: 'pending',
          requestedAt: new Date().toISOString(),
        }
    if (existingIndex >= 0) requirements[existingIndex] = recorded
    else requirements.push(recorded)
    await writePrivateJson(this.layout.environmentRequirementsPath, requirements)
    return recorded
  }

  async satisfyEnvironmentRequirement(input: { id: string; evidence: string[] }): Promise<CodexTestEnvironmentRequirement> {
    const evidence = uniqueEvidence(input.evidence)
    if (evidence.length === 0) throw new Error('Satisfied environment requirements must include saved evidence')
    const requirements = await readRequirements(this.layout.environmentRequirementsPath)
    const index = requirements.findIndex((item) => item.id === input.id)
    if (index < 0) throw new Error(`Unknown environment requirement: ${input.id}`)
    const satisfied: CodexTestEnvironmentRequirement = {
      ...requirements[index]!,
      status: 'satisfied',
      evidence: [...new Set([...requirements[index]!.evidence, ...evidence])],
    }
    requirements[index] = satisfied
    await writePrivateJson(this.layout.environmentRequirementsPath, requirements)
    return satisfied
  }

  async requestEnvironmentAccess(input: {
    allowedOrigins: string[]
    origin: string
    reason: string
    evidence: string[]
    caseIds: string[]
  }): Promise<EnvironmentAccessResult> {
    const origin = normalizeEnvironmentOrigin(input.origin)
    if (input.allowedOrigins.includes(origin)) return { status: 'allowed', origin }
    if (input.caseIds.length === 0) throw new Error('Environment access requests must apply to at least one test case')
    if (input.evidence.length === 0) throw new Error('Environment access requests must include saved evidence')
    const requirements = await readRequirements(this.layout.environmentRequirementsPath)
    const existing = requirements.find((item) => item.kind === 'origin' && item.origin === origin)
    const recorded = await this.recordEnvironmentRequirement({
      caseIds: input.caseIds,
      kind: 'origin',
      origin,
      condition: existing?.condition ?? input.reason,
      evidence: input.evidence,
    })
    return {
      status: 'blocked',
      origin: recorded.origin!,
      requirementId: recorded.id,
      reason: recorded.condition,
      evidence: recorded.evidence,
      requestedAt: recorded.requestedAt,
      nextAction: 'Register this origin in the Environment Profile, then resume the same run.',
    }
  }

  async reconcileEnvironmentRequirements(allowedOrigins: string[]): Promise<CodexTestEnvironmentRequirement[]> {
    const requirements = await readRequirements(this.layout.environmentRequirementsPath)
    let changed = false
    const reconciled = requirements.map((item) => {
      if (item.kind === 'origin' && item.origin && item.status === 'pending' && allowedOrigins.includes(item.origin)) {
        changed = true
        return { ...item, status: 'satisfied' as const }
      }
      return item
    })
    if (changed) await writePrivateJson(this.layout.environmentRequirementsPath, reconciled)
    return reconciled
  }

  async reconcileEnvironmentRequirementCaseLinks(cases: Array<Pick<CodexTestCaseResult, 'caseId' | 'failureSource' | 'environmentRequirementIds'>>): Promise<CodexTestEnvironmentRequirement[]> {
    const requirements = await readRequirements(this.layout.environmentRequirementsPath)
    const resultByCaseId = new Map(cases.map((item) => [item.caseId, item]))
    let changed = false
    const reconciled = requirements.map((requirement) => {
      if (requirement.status !== 'pending') return requirement
      const caseIds = requirement.caseIds.filter((caseId) => {
        const result = resultByCaseId.get(caseId)
        if (!result) return true
        if (result.failureSource !== 'environment') return false
        if (result.environmentRequirementIds?.includes(requirement.id)) return true
        return !result.environmentRequirementIds?.length
      })
      if (caseIds.length === requirement.caseIds.length) return requirement
      changed = true
      return caseIds.length > 0
        ? { ...requirement, caseIds }
        : { ...requirement, status: 'superseded' as const }
    })
    if (changed) await writePrivateJson(this.layout.environmentRequirementsPath, reconciled)
    return reconciled
  }

  async recordMutationLedgerEntry(input: {
    id: string
    caseId: string
    description: string
    risk: Exclude<CodexTestRisk, 'read'>
  }): Promise<CodexTestMutationLedgerEntry> {
    if (!this.identity.caseIds.includes(input.caseId)) {
      throw new Error(`Cannot record a mutation for unknown case ${input.caseId}`)
    }
    const entries = await this.mutationLedgerForWrite()
    const existing = entries.find((entry) => entry.id === input.id)
    // Re-registering an unresolved mutation is idempotent; a resolved one may
    // only be represented by a new id, or a different business action would
    // silently inherit the earlier one's compensation evidence.
    if (existing && existing.status === 'pending') return existing
    if (existing) throw new Error(`Mutation id ${input.id} is already terminal; use a new id for a new business action`)
    const now = new Date().toISOString()
    const entry: CodexTestMutationLedgerEntry = {
      id: input.id,
      caseId: input.caseId,
      description: input.description,
      risk: input.risk,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      evidence: [],
    }
    entries.push(entry)
    await writePrivateJson(this.layout.mutationLedgerPath, entries)
    return entry
  }

  async transitionMutationLedgerEntry(input: {
    id: string
    status: 'compensated' | 'accepted'
    evidence: string[]
  }): Promise<CodexTestMutationLedgerEntry> {
    const evidence = uniqueEvidence(input.evidence)
    if (evidence.length === 0) {
      throw new Error('Resolved mutations must include saved verification evidence')
    }
    const entries = await this.mutationLedgerForWrite()
    const entry = entries.find((item) => item.id === input.id)
    if (!entry) throw new Error(`Unknown mutation id: ${input.id}`)
    const resolved: CodexTestMutationLedgerEntry = {
      ...entry,
      status: input.status,
      evidence: [...new Set([...entry.evidence, ...evidence])],
      updatedAt: new Date().toISOString(),
    }
    entries[entries.indexOf(entry)] = resolved
    await writePrivateJson(this.layout.mutationLedgerPath, entries)
    return resolved
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

  /**
   * The Ledger as it stands before a write. Appending to an absent ledger
   * creates it, so a missing artifact is empty here; a ledger that fails
   * read-back identity stops the write instead of being overwritten.
   */
  private async mutationLedgerForWrite(): Promise<CodexTestMutationLedgerEntry[]> {
    const artifact = await readArrayArtifact('Mutation Ledger', this.layout.mutationLedgerPath)
    const converted = mutationLedgerEntries(artifact.value, this.identity)
    const problems = [...artifact.problems, ...converted.problems]
    if (problems.length > 0) {
      throw new Error(`Mutation Ledger could not be read: ${problems.join('; ')}`)
    }
    return converted.entries
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
