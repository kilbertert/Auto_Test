import type { LocatorIR } from '../core/types.js'
import type {
  WorkflowRuntimeBinding,
  WorkflowRuntimeGroup,
  WorkflowLocatorState,
  WorkflowRecoveryContract,
  WorkflowRuntimeTarget,
  WorkflowTableSpec,
  WorkflowValueOperand,
} from './runtime-types.js'

export interface WorkflowDraftLocatorTarget {
  description: string
  candidates: LocatorIR[]
  sourceRefs: string[]
}

export type WorkflowDraftRefreshAction =
  | { kind: 'reload' }
  | { kind: 'navigate'; url: WorkflowValueOperand }
  | { kind: 'click'; target: WorkflowDraftLocatorTarget }

export type WorkflowDraftStep =
  | { id: string; kind: 'navigate'; url?: WorkflowValueOperand; sourceRefs: string[] }
  | { id: string; kind: 'click'; target: WorkflowDraftLocatorTarget; sourceRefs: string[] }
  | { id: string; kind: 'fill'; target: WorkflowDraftLocatorTarget; value: WorkflowValueOperand; sourceRefs: string[] }
  | { id: string; kind: 'press'; target: WorkflowDraftLocatorTarget; key: string; sourceRefs: string[] }
  | { id: string; kind: 'check'; target: WorkflowDraftLocatorTarget; sourceRefs: string[] }
  | { id: string; kind: 'ensureChecked'; target: WorkflowDraftLocatorTarget; expected: boolean; sourceRefs: string[] }
  | { id: string; kind: 'select'; target: WorkflowDraftLocatorTarget; value: WorkflowValueOperand; sourceRefs: string[] }
  | {
      id: string
      kind: 'solveCaptcha'
      imageTarget: WorkflowDraftLocatorTarget
      inputTarget: WorkflowDraftLocatorTarget
      sourceRefs: string[]
    }
  | { id: string; kind: 'reload'; sourceRefs: string[] }
  | { id: string; kind: 'wait'; timeoutMs: number; sourceRefs: string[] }
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
      refresh?: WorkflowDraftRefreshAction
      sourceRefs: string[]
    }
  | {
      id: string
      kind: 'clickAlignedTableAction'
      entityName: string
      dataTable: WorkflowTableSpec
      actionTable: WorkflowTableSpec
      actionNames: string[]
      sourceRefs: string[]
    }

export type WorkflowDraftAssertion =
  | { id: string; kind: 'url'; operator: 'equals' | 'contains'; expected: WorkflowValueOperand; sourceRefs: string[] }
  | {
      id: string
      kind: 'locatorText'
      target: WorkflowDraftLocatorTarget
      operator: 'equals' | 'contains'
      expected: WorkflowValueOperand
      sourceRefs: string[]
    }
  | {
      id: string
      kind: 'locatorState'
      target: WorkflowDraftLocatorTarget
      expected: WorkflowLocatorState
      sourceRefs: string[]
    }
  | { id: string; kind: 'locatorCount'; target: WorkflowDraftLocatorTarget; expected: number; sourceRefs: string[] }
  | {
      id: string
      kind: 'entityText'
      entityName: string
      field?: string
      operator: 'equals' | 'contains'
      expected: WorkflowValueOperand
      sourceRefs: string[]
    }
  | {
      id: string
      kind: 'tableRowCount'
      table: WorkflowTableSpec
      match: WorkflowValueOperand[]
      exclude?: WorkflowValueOperand[]
      operator?: 'equals' | 'gt' | 'gte' | 'lt' | 'lte'
      expected: number
      sourceRefs: string[]
    }

export interface WorkflowDraftPhase {
  id: string
  title: string
  targetId: string
  risk: 'read' | 'write' | 'destructive'
  contextMode: 'shared' | 'freshPhase' | 'freshPerIteration'
  steps: WorkflowDraftStep[]
  assertions: WorkflowDraftAssertion[]
  recovery?: WorkflowRecoveryContract
  sourceRefs: string[]
}

export interface WorkflowDraftGroup extends Omit<WorkflowRuntimeGroup, 'phases'> {
  phases: WorkflowDraftPhase[]
}

export interface WorkflowPlanDraftBody {
  version: '1.0'
  kind: 'workflow-plan-draft'
  workflowId: string
  sourceSha256: string
  targets: WorkflowRuntimeTarget[]
  dataBindings: WorkflowRuntimeBinding[]
  groups: WorkflowDraftGroup[]
  policy: {
    phaseTimeoutMs: number
    actionTimeoutMs?: number
    destructiveActions: 'blocked' | 'requireApproval'
  }
  review: {
    status: 'draft'
    sourceRefs: string[]
    unresolvedAmbiguities: string[]
  }
}

export interface WorkflowPlanDraft extends WorkflowPlanDraftBody {
  planner: {
    provider: string
    model: string | null
    generatedAt: string
    inputSha256: string
    imageSha256s: string[]
    summary: string[]
  }
}

export interface WorkflowPlannerRequest {
  manifest: unknown
  brief: string
  imagePaths: string[]
  imageSha256s: string[]
  inputSha256: string
  workspaceDirectory: string
}

export interface WorkflowPlannerModelResponse {
  planJson: string
  summary: string[]
}

export interface WorkflowPlannerProvider {
  readonly name: string
  readonly model: string | null
  generate(request: WorkflowPlannerRequest): Promise<WorkflowPlannerModelResponse>
  repair?(request: WorkflowPlannerRequest, previous: WorkflowPlannerModelResponse, validationError: string): Promise<WorkflowPlannerModelResponse>
  planRecovery?(request: WorkflowPlannerRequest, draftJson: string): Promise<WorkflowPlannerModelResponse>
}
