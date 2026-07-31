import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { LocatorIR } from '../core/types.js'
import { redactSensitiveContent, slugify } from '../input/text.js'
import { resolveWorkflowBindings } from './runtime-data.js'
import { executeWorkflow, type WorkflowExecutionOptions } from './runtime-engine.js'
import type {
  CaptureTableRowRequest,
  WorkflowExecutionResult,
  WorkflowExplorationPageSession,
  WorkflowLocatorInspection,
  WorkflowLocatorState,
  WorkflowPageEvidence,
  WorkflowPageSession,
  WorkflowRuntimeDriver,
  WorkflowRuntimeTarget,
  WorkflowTableSpec,
} from './runtime-types.js'
import type { WorkflowLocatorResolver } from './locator-resolver.js'
import type {
  WorkflowDraftLocatorTarget,
  WorkflowDraftStep,
  WorkflowPlanDraft,
} from './planner-types.js'
import { isDraftLocator, isDraftTable, projectDraftToExecutionPlan, validateWorkflowPlanDraft, workflowDraftSha256 } from './planner-validation.js'
import { WorkflowPreActionError } from './workflow-errors.js'
import { isIdempotentCleanupPhase } from './recovery-semantics.js'

type LocatorOperation = 'click' | 'fill' | 'press' | 'check' | 'ensureChecked' | 'select' | 'assertion' | 'refresh'

interface DraftTargetEntry {
  id: string
  operation: LocatorOperation
  target: WorkflowDraftLocatorTarget
  expectedCount?: number
  expectedState?: WorkflowLocatorState
}

interface DraftTableEntry {
  id: string
  table: WorkflowTableSpec
}

export interface WorkflowLocatorResolutionEvidence {
  targetId: string
  operation: LocatorOperation
  description: string
  sourceRefs: string[]
  locator: LocatorIR
  resolutionSource: 'plannerCandidate' | 'aiResolver'
  resolver: string
  pageUrl: string
  pageEvidenceSha256: string
  inspection: WorkflowLocatorInspection
  reasoning: string
}

export interface WorkflowPlanExplorationReport {
  version: '1.0'
  kind: 'workflow-plan-exploration'
  workflowId: string
  sourceSha256: string
  draftSha256: string
  startedAt: string
  finishedAt: string
  status: 'passed' | 'failed'
  runtimeResult: WorkflowExecutionResult
  locatorResolutions: WorkflowLocatorResolutionEvidence[]
  tableResolutions: Array<{
    targetId: string
    requested: WorkflowTableSpec
    resolved: WorkflowTableSpec
    pageUrl: string
    pageEvidenceSha256: string
  }>
  unresolvedTargetIds: string[]
  unresolvedTableIds: string[]
}

export interface ExploreWorkflowPlanOptions extends WorkflowExecutionOptions {
  resolver: WorkflowLocatorResolver
  evidenceDirectory: string
  seedReport?: WorkflowPlanExplorationReport
  allowCompatibleSeed?: boolean
  startFromTarget?: string
}

function targetEntry(
  id: string,
  operation: LocatorOperation,
  target: WorkflowDraftLocatorTarget,
  expectedCount?: number,
  expectedState?: WorkflowLocatorState,
): DraftTargetEntry {
  return {
    id,
    operation,
    target,
    ...(expectedCount !== undefined ? { expectedCount } : {}),
    ...(expectedState !== undefined ? { expectedState } : {}),
  }
}

function draftTargetEntries(draft: WorkflowPlanDraft): DraftTargetEntry[] {
  const entries: DraftTargetEntry[] = []
  for (const group of draft.groups) {
    for (const phase of group.phases) {
      for (const step of phase.steps) {
        if (step.kind === 'click' || step.kind === 'fill' || step.kind === 'press' || step.kind === 'check' || step.kind === 'ensureChecked' || step.kind === 'select') {
          entries.push(targetEntry(step.id, step.kind, step.target))
        }
        if (step.kind === 'solveCaptcha') {
          entries.push(targetEntry(`${step.id}:image`, 'assertion', step.imageTarget))
          entries.push(targetEntry(`${step.id}:input`, 'fill', step.inputTarget))
        }
        if (step.kind === 'captureTableRow' && step.refresh?.kind === 'click') {
          entries.push(targetEntry(`${step.id}:refresh`, 'refresh', step.refresh.target))
        }
      }
      for (const assertion of phase.assertions) {
        if (assertion.kind === 'locatorText' || assertion.kind === 'locatorState' || assertion.kind === 'locatorCount') {
          entries.push(targetEntry(
            assertion.id,
            'assertion',
            assertion.target,
            assertion.kind === 'locatorCount' ? assertion.expected : undefined,
            assertion.kind === 'locatorState' ? assertion.expected : undefined,
          ))
        }
      }
    }
  }
  return entries
}

function draftTableEntries(draft: WorkflowPlanDraft): DraftTableEntry[] {
  const entries: DraftTableEntry[] = []
  for (const group of draft.groups) {
    for (const phase of group.phases) {
      for (const step of phase.steps) {
        if (step.kind === 'captureTableRow') entries.push({ id: `${step.id}:table`, table: step.table })
        if (step.kind === 'clickAlignedTableAction') {
          entries.push({ id: `${step.id}:dataTable`, table: step.dataTable })
          entries.push({ id: `${step.id}:actionTable`, table: step.actionTable })
        }
      }
      for (const assertion of phase.assertions) {
        if (assertion.kind === 'tableRowCount') entries.push({ id: `${assertion.id}:table`, table: assertion.table })
      }
    }
  }
  return entries
}

function skippedOptionalCleanupTableIds(draft: WorkflowPlanDraft, result: WorkflowExecutionResult): Set<string> {
  const skipped = new Set<string>()
  const passedPhases = new Set(result.phases.filter((phase) => phase.status === 'passed').map((phase) => `${phase.groupId}:${phase.phaseId}`))
  const captured = new Set(result.entityCaptures.map((event) => `${event.groupId}:${event.phaseId}:${event.stepId}:${event.name}`))
  for (const group of draft.groups) {
    for (const phase of group.phases) {
      if (!passedPhases.has(`${group.id}:${phase.id}`) || !isIdempotentCleanupPhase(phase)) continue
      const missingEntities = new Set(phase.steps.flatMap((step) => (
        step.kind === 'captureTableRow' && !captured.has(`${group.id}:${phase.id}:${step.id}:${step.entityName}`)
          ? [step.entityName]
          : []
      )))
      for (const step of phase.steps) {
        if (step.kind !== 'clickAlignedTableAction' || !missingEntities.has(step.entityName)) continue
        skipped.add(`${step.id}:dataTable`)
        skipped.add(`${step.id}:actionTable`)
      }
    }
  }
  return skipped
}

function explorationSession(session: WorkflowPageSession): WorkflowExplorationPageSession {
  const candidate = session as Partial<WorkflowExplorationPageSession>
  if (typeof candidate.inspectLocator !== 'function' || typeof candidate.pageEvidence !== 'function') {
    throw new Error('Workflow driver does not expose locator exploration capabilities')
  }
  return session as WorkflowExplorationPageSession
}

function secretStrings(draft: WorkflowPlanDraft, environment: NodeJS.ProcessEnv | undefined): string[] {
  const values = resolveWorkflowBindings(draft.dataBindings, environment)
  const boundSecrets = draft.dataBindings
    .filter((binding) => binding.source === 'secret')
    .flatMap((binding) => {
      const value = values[binding.name]
      return Array.isArray(value) ? value : value === undefined ? [] : [String(value)]
    })
  const environmentSecrets = Object.entries(environment ?? process.env)
    .filter(([name, value]) => name.startsWith('AUTO_TEST_SECRET_') && Boolean(value))
    .flatMap(([, value]) => {
      const raw = value!
      if (!raw.trim().startsWith('[')) return [raw]
      try {
        const parsed = JSON.parse(raw) as unknown
        return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
          ? [raw, ...parsed]
          : [raw]
      } catch {
        return [raw]
      }
    })
  return [...new Set([...boundSecrets, ...environmentSecrets])]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length)
}

function sanitizeString(value: string, secrets: string[]): string {
  let result = value
  for (const secret of secrets) result = result.replaceAll(secret, '<redacted-secret>')
  return redactSensitiveContent(result)
}

function sanitizedEvidence(evidence: WorkflowPageEvidence, secrets: string[]): WorkflowPageEvidence {
  return {
    url: sanitizeString(evidence.url, secrets),
    title: sanitizeString(evidence.title, secrets),
    ariaSnapshot: sanitizeString(evidence.ariaSnapshot, secrets),
    ...(evidence.applicationErrors ? {
      applicationErrors: evidence.applicationErrors.map((message) => sanitizeString(message, secrets)),
    } : {}),
    ...(evidence.choiceCandidates ? {
      choiceCandidates: evidence.choiceCandidates.map((choice) => sanitizeString(choice, secrets)),
    } : {}),
    interactiveElements: evidence.interactiveElements.map((element) => ({
      tag: element.tag,
      role: sanitizeString(element.role, secrets),
      name: sanitizeString(element.name, secrets),
      text: sanitizeString(element.text, secrets),
      placeholder: sanitizeString(element.placeholder, secrets),
      testId: sanitizeString(element.testId, secrets),
      id: sanitizeString(element.id, secrets),
      href: sanitizeString(element.href, secrets),
      css: sanitizeString(element.css, secrets),
      visible: element.visible,
      enabled: element.enabled,
    })),
    tableCandidates: evidence.tableCandidates.map((candidate) => ({
      headerLabels: candidate.headerLabels.map((header) => sanitizeString(header, secrets)),
      region: candidate.region,
    })),
  }
}

function pageUrlForReport(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}${url.hash ? `#${url.hash.replace(/^#/, '').split('?')[0]}` : ''}`
  } catch {
    return '<invalid-url>'
  }
}

function acceptableInspection(
  inspection: WorkflowLocatorInspection,
  operation: LocatorOperation,
  expectedCount?: number,
  expectedState?: WorkflowLocatorState,
): boolean {
  if (expectedCount !== undefined) return inspection.count === expectedCount && (expectedCount === 0 || inspection.visible === true)
  if (expectedState === 'hidden') return inspection.count === 0 || inspection.visible === false
  if (inspection.count !== 1 || inspection.visible !== true) return false
  if (operation === 'fill') return inspection.enabled === true && inspection.editable === true
  if (operation === 'press') return inspection.enabled === true
  if (operation === 'click' || operation === 'check' || operation === 'ensureChecked' || operation === 'select' || operation === 'refresh') {
    return inspection.enabled === true && inspection.clickable !== false
  }
  return true
}

function stableForOperation(locator: LocatorIR, operation: LocatorOperation): boolean {
  if (operation !== 'ensureChecked') return true
  if (locator.strategy === 'css' || locator.strategy === 'xpath') {
    return !/(?:is-checked|is-active|:checked|\[aria-checked\s*=|\[checked\]|contains\([^)]*['"]is-checked)/i.test(locator.value)
  }
  return true
}

function expectedChoiceLabel(entry: DraftTargetEntry): string | undefined {
  if (!/(?:option|choice|下拉|选项)/i.test(entry.target.description)) return undefined
  const roleCandidate = entry.target.candidates.find((candidate) =>
    candidate.strategy === 'role' && (candidate.value === 'option' || candidate.value === 'listitem') && candidate.name,
  )
  if (roleCandidate?.name) return roleCandidate.name.trim()
  const textCandidate = entry.target.candidates.find((candidate) => candidate.strategy === 'text' && candidate.exact !== false)
  return textCandidate?.value.trim() || undefined
}

class ResolvingWorkflowPageSession implements WorkflowPageSession {
  constructor(
    private readonly base: WorkflowPageSession,
    private readonly entries: ReadonlyMap<string, DraftTargetEntry>,
    private readonly resolved: Map<string, LocatorIR>,
    private readonly evidence: WorkflowLocatorResolutionEvidence[],
    private readonly tableEntries: ReadonlyMap<string, DraftTableEntry>,
    private readonly resolvedTables: Map<string, WorkflowTableSpec>,
    private readonly tableEvidence: WorkflowPlanExplorationReport['tableResolutions'],
    private readonly resolver: WorkflowLocatorResolver,
    private readonly evidenceDirectory: string,
    private readonly secrets: string[],
  ) {}

  setDefaultTimeout(timeoutMs: number): void { this.base.setDefaultTimeout(timeoutMs) }
  url(): Promise<string> { return this.base.url() }
  navigate(url: string): Promise<void> { return this.base.navigate(url) }
  reload(): Promise<void> { return this.base.reload() }
  wait(timeoutMs: number): Promise<void> { return this.base.wait(timeoutMs) }

  private async applicationErrors(): Promise<string[]> {
    const session = explorationSession(this.base)
    if (typeof session.applicationErrors !== 'function') return []
    return (await session.applicationErrors())
      .map((message) => sanitizeString(message, this.secrets))
      .filter(Boolean)
  }

  private async persistApplicationErrorEvidence(targetId: string): Promise<void> {
    const page = sanitizedEvidence(await explorationSession(this.base).pageEvidence(), this.secrets)
    const pageJson = JSON.stringify(page)
    const pageHash = createHash('sha256').update(pageJson).digest('hex')
    await mkdir(this.evidenceDirectory, { recursive: true, mode: 0o750 })
    await writeFile(
      resolve(this.evidenceDirectory, `${slugify(targetId)}-application-error-${pageHash.slice(0, 12)}.json`),
      `${JSON.stringify(page, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o640 },
    )
  }

  private async runWithApplicationErrorCheck(targetId: string | undefined, action: () => Promise<void>): Promise<void> {
    if (!targetId) {
      await action()
      return
    }
    const before = new Set(await this.applicationErrors())
    await action()
    const after = await this.applicationErrors()
    const newlyVisible = after.filter((message) => !before.has(message))
    if (newlyVisible.length === 0) return
    await this.persistApplicationErrorEvidence(targetId)
    throw new Error(`Application error after step ${targetId}: ${newlyVisible.join('; ')}`)
  }

  private async resolveLocator(locator: LocatorIR, requestedOperation: LocatorOperation): Promise<LocatorIR> {
    const targetId = isDraftLocator(locator)
    if (!targetId) return locator
    const entry = this.entries.get(targetId)
    if (!entry) throw new Error(`Unknown draft locator target: ${targetId}`)
    const session = explorationSession(this.base)
    const cached = this.resolved.get(targetId)
    if (cached) {
      const inspection = await session.inspectLocator(cached)
      if (acceptableInspection(inspection, requestedOperation, entry.expectedCount, entry.expectedState)) return cached
    }

    for (const candidate of entry.target.candidates) {
      const inspection = await session.inspectLocator(candidate)
      if (!stableForOperation(candidate, requestedOperation) || !acceptableInspection(inspection, requestedOperation, entry.expectedCount, entry.expectedState)) continue
      const selected: LocatorIR = { ...candidate, source: 'playwrightCli' }
      const page = sanitizedEvidence(await session.pageEvidence(), this.secrets)
      const pageJson = JSON.stringify(page)
      const pageHash = createHash('sha256').update(pageJson).digest('hex')
      await mkdir(this.evidenceDirectory, { recursive: true, mode: 0o750 })
      await writeFile(resolve(this.evidenceDirectory, `${slugify(targetId)}-${pageHash.slice(0, 12)}.json`), `${JSON.stringify(page, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
      this.resolved.set(targetId, selected)
      this.evidence.push({
        targetId,
        operation: entry.operation,
        description: entry.target.description,
        sourceRefs: entry.target.sourceRefs,
        locator: selected,
        resolutionSource: 'plannerCandidate',
        resolver: 'playwright-validation',
        pageUrl: pageUrlForReport(await session.url()),
        pageEvidenceSha256: pageHash,
        inspection,
        reasoning: 'Planner candidate matched the expected live state for this operation.',
      })
      return selected
    }

    const page = sanitizedEvidence(await session.pageEvidence(), this.secrets)
    const pageJson = JSON.stringify(page)
    const pageHash = createHash('sha256').update(pageJson).digest('hex')
    await mkdir(this.evidenceDirectory, { recursive: true, mode: 0o750 })
    await writeFile(resolve(this.evidenceDirectory, `${slugify(targetId)}-${pageHash.slice(0, 12)}.json`), `${JSON.stringify(page, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
    if (entry.expectedState === 'hidden' && page.applicationErrors && page.applicationErrors.length > 0) {
      throw new Error(`Visible application error while expected hidden assertion ${targetId}: ${page.applicationErrors.join('; ')}`)
    }
    const expectedChoice = expectedChoiceLabel(entry)
    const availableChoices = page.choiceCandidates ?? []
    if (expectedChoice && availableChoices.length > 0 && !availableChoices.includes(expectedChoice)) {
      throw new Error(`Required option is unavailable in the current environment: expected ${JSON.stringify(expectedChoice)}; available options ${JSON.stringify(availableChoices)}`)
    }
    const rejections: Array<{ locator: LocatorIR; inspection: WorkflowLocatorInspection }> = []
    for (let attempt = 1; attempt <= 3; attempt++) {
      const suggestion = await this.resolver.resolve({
        targetId,
        operation: entry.operation,
        target: entry.target,
        page,
        workspaceDirectory: this.evidenceDirectory,
        attempt,
        rejections,
      })
      const inspection = await session.inspectLocator(suggestion.locator)
      if (!stableForOperation(suggestion.locator, requestedOperation) || !acceptableInspection(inspection, requestedOperation, entry.expectedCount, entry.expectedState)) {
        rejections.push({ locator: suggestion.locator, inspection })
        continue
      }
      const selected: LocatorIR = { ...suggestion.locator, source: 'playwrightCli' }
      this.resolved.set(targetId, selected)
      this.evidence.push({
        targetId,
        operation: entry.operation,
        description: entry.target.description,
        sourceRefs: entry.target.sourceRefs,
        locator: selected,
        resolutionSource: 'aiResolver',
        resolver: this.resolver.name,
        pageUrl: pageUrlForReport(await session.url()),
        pageEvidenceSha256: pageHash,
        inspection,
        reasoning: sanitizeString(suggestion.reasoning, this.secrets),
      })
      return selected
    }
    throw new Error(`AI locator for ${targetId} remained invalid after 3 attempts: ${JSON.stringify(rejections)}`)
  }

  private async resolveBeforeAction(locator: LocatorIR, operation: LocatorOperation): Promise<LocatorIR> {
    try {
      return await this.resolveLocator(locator, operation)
    } catch (error) {
      throw new WorkflowPreActionError(error)
    }
  }

  private async resolveTable(table: WorkflowTableSpec): Promise<WorkflowTableSpec> {
    const targetId = isDraftTable(table)
    if (!targetId) return table
    const cached = this.resolvedTables.get(targetId)
    if (cached) {
      try {
        await this.base.tableRows(cached)
        return cached
      } catch {
        this.resolvedTables.delete(targetId)
      }
    }
    const entry = this.tableEntries.get(targetId)
    if (!entry) throw new Error(`Unknown draft table target: ${targetId}`)
    try {
      await this.base.tableRows(entry.table)
      const page = sanitizedEvidence(await explorationSession(this.base).pageEvidence(), this.secrets)
      const pageJson = JSON.stringify(page)
      const pageHash = createHash('sha256').update(pageJson).digest('hex')
      this.resolvedTables.set(targetId, entry.table)
      this.tableEvidence.push({
        targetId,
        requested: entry.table,
        resolved: entry.table,
        pageUrl: pageUrlForReport(await this.base.url()),
        pageEvidenceSha256: pageHash,
      })
      return entry.table
    } catch {
      // The screenshot-derived labels may differ from the current locale.
    }
    const session = explorationSession(this.base)
    const page = sanitizedEvidence(await session.pageEvidence(), this.secrets)
    const requestedRegion = entry.table.region ?? 'main'
    const candidates = page.tableCandidates.filter((candidate) => candidate.region === requestedRegion)
    if (candidates.length === 0) throw new Error(`No live table candidate found for ${targetId} in region ${requestedRegion}`)
    const desired = entry.table.headerLabels.map((label) => label.toLocaleLowerCase())
    const scored = candidates.map((candidate) => ({
      candidate,
      score: candidate.headerLabels.reduce((sum, label) => sum + desired.filter((wanted) =>
        label.toLocaleLowerCase().includes(wanted) || wanted.includes(label.toLocaleLowerCase()),
      ).length, 0),
    })).sort((left, right) => right.score - left.score || (
      requestedRegion === 'fixedRight'
        ? left.candidate.headerLabels.length - right.candidate.headerLabels.length
        : right.candidate.headerLabels.length - left.candidate.headerLabels.length
    ))
    const best = scored[0]!
    const tied = scored.filter((item) => item.score === best.score && item.candidate.headerLabels.length === best.candidate.headerLabels.length)
    if (tied.length > 1 && new Set(tied.map((item) => JSON.stringify(item.candidate.headerLabels))).size > 1) {
      throw new Error(`Multiple live table candidates remain ambiguous for ${targetId}`)
    }
    const resolved: WorkflowTableSpec = {
      headerLabels: best.candidate.headerLabels,
      bodyOffset: entry.table.bodyOffset,
      region: best.candidate.region,
    }
    await this.base.tableRows(resolved)
    const pageJson = JSON.stringify(page)
    const pageHash = createHash('sha256').update(pageJson).digest('hex')
    this.resolvedTables.set(targetId, resolved)
    this.tableEvidence.push({
      targetId,
      requested: entry.table,
      resolved,
      pageUrl: pageUrlForReport(await session.url()),
      pageEvidenceSha256: pageHash,
    })
    return resolved
  }

  async click(locator: LocatorIR): Promise<void> {
    const targetId = isDraftLocator(locator)
    const resolved = await this.resolveBeforeAction(locator, 'click')
    await this.runWithApplicationErrorCheck(targetId, () => this.base.click(resolved))
  }
  async fill(locator: LocatorIR, value: string): Promise<void> { return this.base.fill(await this.resolveBeforeAction(locator, 'fill'), value) }
  async press(locator: LocatorIR, key: string): Promise<void> {
    const targetId = isDraftLocator(locator)
    const resolved = await this.resolveBeforeAction(locator, 'press')
    await this.runWithApplicationErrorCheck(targetId, () => this.base.press(resolved, key))
  }
  async check(locator: LocatorIR): Promise<void> {
    const targetId = isDraftLocator(locator)
    const resolved = await this.resolveBeforeAction(locator, 'check')
    await this.runWithApplicationErrorCheck(targetId, () => this.base.check(resolved))
  }
  async ensureChecked(locator: LocatorIR, expected: boolean): Promise<void> {
    const targetId = isDraftLocator(locator)
    const resolved = await this.resolveBeforeAction(locator, 'ensureChecked')
    await this.runWithApplicationErrorCheck(targetId, () => this.base.ensureChecked(resolved, expected))
  }
  async select(locator: LocatorIR, value: string): Promise<void> {
    const targetId = isDraftLocator(locator)
    const resolved = await this.resolveBeforeAction(locator, 'select')
    await this.runWithApplicationErrorCheck(targetId, () => this.base.select(resolved, value))
  }
  async solveCaptcha(imageLocator: LocatorIR, inputLocator: LocatorIR): Promise<void> {
    const imageTargetId = isDraftLocator(imageLocator)
    const inputTargetId = isDraftLocator(inputLocator)
    const resolvedImage = await this.resolveBeforeAction(imageLocator, 'assertion')
    const resolvedInput = await this.resolveBeforeAction(inputLocator, 'fill')
    await this.runWithApplicationErrorCheck(
      inputTargetId ?? imageTargetId,
      () => this.base.solveCaptcha(resolvedImage, resolvedInput),
    )
  }
  async locatorText(locator: LocatorIR): Promise<string> { return this.base.locatorText(await this.resolveLocator(locator, 'assertion')) }
  async locatorState(locator: LocatorIR, state: WorkflowLocatorState): Promise<boolean> {
    return this.base.locatorState(await this.resolveLocator(locator, 'assertion'), state)
  }
  async locatorCount(locator: LocatorIR): Promise<number> { return this.base.locatorCount(await this.resolveLocator(locator, 'assertion')) }
  async tableRows(table: WorkflowTableSpec): Promise<string[]> { return this.base.tableRows(await this.resolveTable(table)) }
  async entityRow(table: WorkflowTableSpec, entityId: string) { return this.base.entityRow(await this.resolveTable(table), entityId) }
  async captureTableRow(request: CaptureTableRowRequest) {
    const table = await this.resolveTable(request.table)
    if (request.refresh?.kind !== 'click') return this.base.captureTableRow({ ...request, table })
    const locator = await this.resolveLocator(request.refresh.locator, 'refresh')
    return this.base.captureTableRow({ ...request, table, refresh: { kind: 'click', locator } })
  }
  async clickAlignedTableAction(request: Parameters<WorkflowPageSession['clickAlignedTableAction']>[0]): Promise<void> {
    let dataTable: WorkflowTableSpec
    let actionTable: WorkflowTableSpec
    try {
      dataTable = await this.resolveTable(request.dataTable)
      actionTable = await this.resolveTable(request.actionTable)
    } catch (error) {
      throw new WorkflowPreActionError(error)
    }
    return this.base.clickAlignedTableAction({ ...request, dataTable, actionTable })
  }
}

class ResolvingWorkflowDriver implements WorkflowRuntimeDriver {
  private readonly sessions = new Map<string, WorkflowPageSession>()

  constructor(
    private readonly base: WorkflowRuntimeDriver,
    private readonly entries: ReadonlyMap<string, DraftTargetEntry>,
    private readonly resolved: Map<string, LocatorIR>,
    private readonly evidence: WorkflowLocatorResolutionEvidence[],
    private readonly tableEntries: ReadonlyMap<string, DraftTableEntry>,
    private readonly resolvedTables: Map<string, WorkflowTableSpec>,
    private readonly tableEvidence: WorkflowPlanExplorationReport['tableResolutions'],
    private readonly resolver: WorkflowLocatorResolver,
    private readonly evidenceDirectory: string,
    private readonly secrets: string[],
  ) {}

  async session(key: string, target: WorkflowRuntimeTarget): Promise<WorkflowPageSession> {
    const existing = this.sessions.get(key)
    if (existing) return existing
    const wrapped = new ResolvingWorkflowPageSession(
      await this.base.session(key, target),
      this.entries,
      this.resolved,
      this.evidence,
      this.tableEntries,
      this.resolvedTables,
      this.tableEvidence,
      this.resolver,
      this.evidenceDirectory,
      this.secrets,
    )
    this.sessions.set(key, wrapped)
    return wrapped
  }

  async closeSession(key: string): Promise<void> {
    this.sessions.delete(key)
    await this.base.closeSession(key)
  }

  async closeAll(): Promise<void> {
    this.sessions.clear()
    await this.base.closeAll()
  }
}

export async function exploreWorkflowPlan(
  input: unknown,
  driver: WorkflowRuntimeDriver,
  options: ExploreWorkflowPlanOptions,
): Promise<WorkflowPlanExplorationReport> {
  const draft = validateWorkflowPlanDraft(input)
  const draftSha256 = workflowDraftSha256(draft)
  const entries = draftTargetEntries(draft)
  const tableEntries = draftTableEntries(draft)
  const entryMap = new Map(entries.map((entry) => [entry.id, entry]))
  const tableEntryMap = new Map(tableEntries.map((entry) => [entry.id, entry]))
  if (options.seedReport) {
    if (options.seedReport.draftSha256 !== draftSha256 && !options.allowCompatibleSeed) throw new Error('Seed exploration draft hash does not match the current draft')
    if (options.seedReport.workflowId !== draft.workflowId || options.seedReport.sourceSha256 !== draft.sourceSha256) {
      throw new Error('Seed exploration source does not match the current draft')
    }
  }
  const compatibleLocator = (resolution: WorkflowLocatorResolutionEvidence) => {
    const current = entryMap.get(resolution.targetId)
    return Boolean(current && current.target.description === resolution.description && JSON.stringify(current.target.sourceRefs) === JSON.stringify(resolution.sourceRefs))
  }
  const compatibleTable = (resolution: WorkflowPlanExplorationReport['tableResolutions'][number]) => tableEntryMap.has(resolution.targetId)
  const locatorResolutions: WorkflowLocatorResolutionEvidence[] = (options.seedReport?.locatorResolutions ?? []).filter(compatibleLocator)
  const tableResolutions: WorkflowPlanExplorationReport['tableResolutions'] = (options.seedReport?.tableResolutions ?? []).filter(compatibleTable)
  const resolved = new Map(locatorResolutions.map((resolution) => [resolution.targetId, resolution.locator]))
  const resolvedTables = new Map(tableResolutions.map((resolution) => [resolution.targetId, resolution.resolved]))
  const startedAt = new Date().toISOString()
  let internalPlan = projectDraftToExecutionPlan(draft)
  internalPlan = {
    ...internalPlan,
    policy: {
      ...internalPlan.policy,
      phaseTimeoutMs: Math.max(internalPlan.policy.phaseTimeoutMs, 10 * 60_000),
    },
  }
  if (options.startFromTarget) {
    let groupIndex = -1
    let phaseIndex = -1
    for (const [candidateGroupIndex, group] of internalPlan.groups.entries()) {
      const candidatePhaseIndex = group.phases.findIndex((phase) => phase.steps[0]?.id === options.startFromTarget)
      if (candidatePhaseIndex >= 0) {
        groupIndex = candidateGroupIndex
        phaseIndex = candidatePhaseIndex
        break
      }
    }
    if (groupIndex < 0 || phaseIndex < 0) throw new Error('startFromTarget must reference the first step of a phase')
    internalPlan = {
      ...internalPlan,
      groups: internalPlan.groups.slice(groupIndex).map((group, index) => index === 0
        ? { ...group, phases: group.phases.slice(phaseIndex) }
        : group),
    }
  }
  const resolvingDriver = new ResolvingWorkflowDriver(
    driver,
    entryMap,
    resolved,
    locatorResolutions,
    tableEntryMap,
    resolvedTables,
    tableResolutions,
    options.resolver,
    options.evidenceDirectory,
    secretStrings(draft, options.environment),
  )
  const runtimeResult = await executeWorkflow(internalPlan, resolvingDriver, options)
  const unresolvedTargetIds = entries.map((entry) => entry.id).filter((id) => !resolved.has(id))
  const skippedTableIds = skippedOptionalCleanupTableIds(draft, runtimeResult)
  const unresolvedTableIds = tableEntries.map((entry) => entry.id).filter((id) => !resolvedTables.has(id) && !skippedTableIds.has(id))
  return {
    version: '1.0',
    kind: 'workflow-plan-exploration',
    workflowId: draft.workflowId,
    sourceSha256: draft.sourceSha256,
    draftSha256,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: runtimeResult.status === 'passed' && unresolvedTargetIds.length === 0 && unresolvedTableIds.length === 0 ? 'passed' : 'failed',
    runtimeResult,
    locatorResolutions,
    tableResolutions,
    unresolvedTargetIds,
    unresolvedTableIds,
  }
}

export function workflowExplorationSha256(report: WorkflowPlanExplorationReport): string {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex')
}

const liveResolvableAmbiguity = /locator|selector|page route|route transition|auth(?:entication)? preflight|login control|phone number format|country code|conditional cleanup|idempotent cleanup|captcha|验证码|号码格式|国家码|区号|本地号码|页面路由|认证前置|登录控件|条件分支.*(?:清理|删除|停止)|零匹配.*(?:继续|幂等)|已停止.*跳过停止/i
const readOnlyPresenceCoverageAmbiguity = /does not define which fields.*latest order row.*expected values.*verifies that at least one row exists.*without.*acting/i
const outOfScopeManifestAmbiguity = /references .*but the supplied workflow intake contains no corresponding manifest.*those cases cannot be added without their source manifests/i

export function remainingWorkflowAmbiguities(
  draft: WorkflowPlanDraft,
  report: WorkflowPlanExplorationReport,
): string[] {
  if (report.status !== 'passed' || report.runtimeResult.status !== 'passed') return draft.review.unresolvedAmbiguities
  const readOnlyWorkflow = draft.groups.every((group) => group.phases.every((phase) => phase.risk === 'read'))
  return draft.review.unresolvedAmbiguities.filter((ambiguity) => (
    !liveResolvableAmbiguity.test(ambiguity) &&
    !outOfScopeManifestAmbiguity.test(ambiguity) &&
    !(readOnlyWorkflow && readOnlyPresenceCoverageAmbiguity.test(ambiguity))
  ))
}

export function approveExploredWorkflowPlan(
  input: unknown,
  report: WorkflowPlanExplorationReport,
  reviewer: string,
  reviewedAt = new Date().toISOString(),
) {
  const draft = validateWorkflowPlanDraft(input)
  if (report.kind !== 'workflow-plan-exploration' || report.status !== 'passed') throw new Error('Only a passed exploration can be approved')
  if (report.workflowId !== draft.workflowId || report.sourceSha256 !== draft.sourceSha256) throw new Error('Exploration source does not match the draft')
  if (report.draftSha256 !== workflowDraftSha256(draft)) throw new Error('Exploration draft hash does not match the current draft')
  if (report.unresolvedTargetIds.length > 0) throw new Error('Exploration still contains unresolved locator targets')
  if (report.unresolvedTableIds.length > 0) throw new Error('Exploration still contains unresolved table targets')
  if (remainingWorkflowAmbiguities(draft, report).length > 0) throw new Error('Draft still contains unresolved business ambiguities')
  if (!reviewer.trim()) throw new Error('Reviewer is required')
  const locators = new Map(report.locatorResolutions.map((resolution) => [resolution.targetId, resolution.locator]))
  const tables = new Map(report.tableResolutions.map((resolution) => [resolution.targetId, resolution.resolved]))
  return projectDraftToExecutionPlan(draft, locators, {
    status: 'approved',
    reviewedBy: reviewer,
    reviewedAt,
    sourceRefs: [...new Set([...draft.review.sourceRefs, `exploration:${workflowExplorationSha256(report)}`])],
    unresolvedAmbiguities: [],
  }, tables)
}
