import type { LocatorIR } from '../core/types.js'
import type { WorkflowRisk } from './types.js'

export type WorkflowRuntimeScalar = string | number | boolean
export type WorkflowRuntimeValue = WorkflowRuntimeScalar | string[]
export type WorkflowLocatorState = 'visible' | 'hidden' | 'enabled' | 'checked'

export interface WorkflowRuntimeBinding {
  name: string
  source: 'literal' | 'secret' | 'generated'
  valueType: 'scalar' | 'stringList'
  value?: WorkflowRuntimeScalar | string[]
  secretRef?: string
  generator?: 'uuid' | 'timestamp'
}

export interface WorkflowRuntimeTarget {
  id: string
  baseUrl: string
  allowedOrigins: string[]
  viewport?: { width: number; height: number }
}

export interface WorkflowValueOperand {
  literal?: string
  valueRef?: string
}

export interface WorkflowTableSpec {
  headerLabels: string[]
  bodyOffset: number
  region?: 'main' | 'fixedRight'
}

export type WorkflowRefreshAction =
  | { kind: 'reload' }
  | { kind: 'navigate'; url: WorkflowValueOperand }
  | { kind: 'click'; locator: LocatorIR }

export type WorkflowRuntimeStep =
  | { id: string; kind: 'navigate'; url?: WorkflowValueOperand }
  | { id: string; kind: 'click'; locator: LocatorIR }
  | { id: string; kind: 'fill'; locator: LocatorIR; value: WorkflowValueOperand }
  | { id: string; kind: 'press'; locator: LocatorIR; key: string }
  | { id: string; kind: 'check'; locator: LocatorIR }
  | { id: string; kind: 'ensureChecked'; locator: LocatorIR; expected: boolean }
  | { id: string; kind: 'select'; locator: LocatorIR; value: WorkflowValueOperand }
  | { id: string; kind: 'solveCaptcha'; imageLocator: LocatorIR; inputLocator: LocatorIR }
  | { id: string; kind: 'reload' }
  | { id: string; kind: 'wait'; timeoutMs: number }
  | {
      id: string
      kind: 'captureTableRow'
      entityName: string
      table: WorkflowTableSpec
      match: WorkflowValueOperand[]
      exclude?: WorkflowValueOperand[]
      idPattern: string
      timeoutMs: number
      pollIntervalMs: number
      refresh?: WorkflowRefreshAction
    }
  | {
      id: string
      kind: 'clickAlignedTableAction'
      entityName: string
      dataTable: WorkflowTableSpec
      actionTable: WorkflowTableSpec
      actionNames: string[]
    }

export type WorkflowRuntimeAssertion =
  | { id: string; kind: 'url'; operator: 'equals' | 'contains'; expected: WorkflowValueOperand }
  | { id: string; kind: 'locatorText'; locator: LocatorIR; operator: 'equals' | 'contains'; expected: WorkflowValueOperand }
  | { id: string; kind: 'locatorState'; locator: LocatorIR; expected: WorkflowLocatorState }
  | { id: string; kind: 'locatorCount'; locator: LocatorIR; expected: number }
  | { id: string; kind: 'entityText'; entityName: string; field?: string; operator: 'equals' | 'contains'; expected: WorkflowValueOperand }
  | {
      id: string
      kind: 'tableRowCount'
      table: WorkflowTableSpec
      match: WorkflowValueOperand[]
      exclude?: WorkflowValueOperand[]
      operator?: 'equals' | 'gt' | 'gte' | 'lt' | 'lte'
      expected: number
    }

export type WorkflowRecoveryContract =
  | {
      strategy: 'retry'
      maxAttempts: number
      sourceRefs: string[]
    }
  | {
      strategy: 'compensate'
      phaseIds: string[]
      maxAttempts: number
      sourceRefs: string[]
    }

export interface WorkflowRuntimePhase {
  id: string
  title: string
  targetId: string
  risk: WorkflowRisk
  contextMode: 'shared' | 'freshPhase' | 'freshPerIteration'
  steps: WorkflowRuntimeStep[]
  assertions: WorkflowRuntimeAssertion[]
  recovery?: WorkflowRecoveryContract
}

export interface WorkflowRuntimeGroup {
  id: string
  forEach?: {
    valuesRef: string
    itemName: string
  }
  phases: WorkflowRuntimePhase[]
}

export interface WorkflowExecutionPlan {
  version: '1.0'
  kind: 'workflow-execution-plan'
  workflowId: string
  sourceSha256: string
  targets: WorkflowRuntimeTarget[]
  dataBindings: WorkflowRuntimeBinding[]
  groups: WorkflowRuntimeGroup[]
  policy: {
    phaseTimeoutMs: number
    actionTimeoutMs?: number
    destructiveActions: 'blocked' | 'requireApproval'
  }
  review: {
    status: 'approved'
    reviewedBy: string
    reviewedAt: string
    sourceRefs: string[]
    unresolvedAmbiguities: []
  }
}

export interface WorkflowCapturedEntity {
  name: string
  id: string
  rowIndex: number
  rowSha256: string
  capturedAt: string
}

export interface WorkflowRuntimeCapturedEntity extends WorkflowCapturedEntity {
  rowText: string
  table: WorkflowTableSpec
}

export interface WorkflowEntityRow {
  rowText: string
  cells: string[]
}

export interface WorkflowStepEvent {
  groupId: string
  phaseId: string
  iteration: number | null
  stepId: string
  attempt: number
  status: 'passed' | 'failed'
  durationMs: number
  error?: string
}

export interface WorkflowAssertionEvent {
  groupId: string
  phaseId: string
  iteration: number | null
  assertionId: string
  attempt: number
  status: 'passed' | 'failed'
  error?: string
}

export interface WorkflowPhaseEvent {
  groupId: string
  phaseId: string
  iteration: number | null
  attempt: number
  title: string
  targetId: string
  contextMode: WorkflowRuntimePhase['contextMode']
  status: 'passed' | 'failed' | 'partial'
  durationMs: number
  error?: string
}

export interface WorkflowMutationEvent {
  mutationId: string
  groupId: string
  phaseId: string
  iteration: number | null
  attempt: number
  risk: Exclude<WorkflowRisk, 'read'>
  status: 'started' | 'committed' | 'failed' | 'interrupted' | 'retry_ready' | 'compensation_started' | 'compensated' | 'compensation_failed'
  recoveryPhaseIds?: string[]
  recordedAt: string
  error?: string
}

export interface WorkflowRecoveryPhaseEvent {
  mutationId: string
  groupId: string
  sourcePhaseId: string
  recoveryPhaseId: string
  iteration: number | null
  attempt: number
  status: 'passed' | 'failed' | 'not_needed'
  durationMs: number
  error?: string
}

export interface WorkflowEntityEvent extends WorkflowCapturedEntity {
  groupId: string
  phaseId: string
  iteration: number | null
  stepId: string
}

export interface WorkflowExecutionResult {
  version: '1.0'
  workflowId: string
  sourceSha256: string
  planSha256: string
  runId: string
  startedAt: string
  finishedAt: string
  status: 'passed' | 'failed' | 'partial'
  phases: WorkflowPhaseEvent[]
  steps: WorkflowStepEvent[]
  assertions: WorkflowAssertionEvent[]
  entityCaptures: WorkflowEntityEvent[]
  mutations: WorkflowMutationEvent[]
  recoveries: WorkflowRecoveryPhaseEvent[]
  entities: Record<string, WorkflowCapturedEntity>
  error?: string
}

export interface CaptureTableRowRequest {
  table: WorkflowTableSpec
  match: string[]
  exclude?: string[]
  idPattern: string
  timeoutMs: number
  pollIntervalMs: number
  refresh?: { kind: 'reload' } | { kind: 'navigate'; url: string } | { kind: 'click'; locator: LocatorIR }
}

export interface ClickAlignedTableActionRequest {
  dataTable: WorkflowTableSpec
  actionTable: WorkflowTableSpec
  entityId: string
  actionNames: string[]
}

export interface WorkflowPageSession {
  setDefaultTimeout(timeoutMs: number): void
  url(): Promise<string>
  navigate(url: string): Promise<void>
  click(locator: LocatorIR): Promise<void>
  fill(locator: LocatorIR, value: string): Promise<void>
  press(locator: LocatorIR, key: string): Promise<void>
  check(locator: LocatorIR): Promise<void>
  ensureChecked(locator: LocatorIR, expected: boolean): Promise<void>
  select(locator: LocatorIR, value: string): Promise<void>
  solveCaptcha(imageLocator: LocatorIR, inputLocator: LocatorIR): Promise<void>
  reload(): Promise<void>
  wait(timeoutMs: number): Promise<void>
  captureTableRow(request: CaptureTableRowRequest): Promise<Omit<WorkflowRuntimeCapturedEntity, 'name'>>
  clickAlignedTableAction(request: ClickAlignedTableActionRequest): Promise<void>
  tableRows(table: WorkflowTableSpec): Promise<string[]>
  entityRow(table: WorkflowTableSpec, entityId: string): Promise<WorkflowEntityRow>
  locatorText(locator: LocatorIR): Promise<string>
  locatorState(locator: LocatorIR, state: WorkflowLocatorState): Promise<boolean>
  locatorCount(locator: LocatorIR): Promise<number>
}

export interface WorkflowLocatorInspection {
  count: number
  visible: boolean | null
  enabled: boolean | null
  editable: boolean | null
  clickable?: boolean | null
}

export interface WorkflowInteractiveElementEvidence {
  tag: string
  role: string
  name: string
  text: string
  placeholder: string
  testId: string
  id: string
  href: string
  css: string
  visible: boolean
  enabled: boolean
}

export interface WorkflowPageEvidence {
  url: string
  title: string
  ariaSnapshot: string
  applicationErrors?: string[]
  choiceCandidates?: string[]
  interactiveElements: WorkflowInteractiveElementEvidence[]
  tableCandidates: Array<{
    headerLabels: string[]
    region: 'main' | 'fixedRight'
  }>
}

export interface WorkflowExplorationPageSession extends WorkflowPageSession {
  inspectLocator(locator: LocatorIR): Promise<WorkflowLocatorInspection>
  pageEvidence(): Promise<WorkflowPageEvidence>
  applicationErrors?(): Promise<string[]>
}

export interface WorkflowRuntimeDriver {
  session(key: string, target: WorkflowRuntimeTarget): Promise<WorkflowPageSession>
  closeSession(key: string): Promise<void>
  closeAll(): Promise<void>
}
