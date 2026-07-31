import type { WorkflowPlanExplorationReport } from './plan-exploration.js'
import type { WorkflowPlanDraft } from './planner-types.js'
import type { WorkflowExecutionPlan, WorkflowExecutionResult } from './runtime-types.js'
import type { WorkflowRisk } from './types.js'

export type AutonomousWorkflowOutcome = 'passed' | 'product_failed' | 'blocked'

export type AutonomousWorkflowStage =
  | 'planning'
  | 'exploring'
  | 'refining'
  | 'policy_gate'
  | 'executing'
  | 'completed'
  | 'blocked'
  | 'failed'

export type WorkflowFailureCategory = 'test_code' | 'product_defect' | 'environment' | 'data' | 'policy' | 'unknown'

export interface WorkflowFailureDiagnosis {
  category: WorkflowFailureCategory
  action: 'refine' | 'retry' | 'block'
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

export interface AutonomousWorkflowPolicy {
  id: string
  autoApprove: boolean
  allowedRisks: WorkflowRisk[]
  requireRecoveryFor: Array<Exclude<WorkflowRisk, 'read'>>
  maxRefinements: number
  maxEnvironmentRetries: number
}

export interface AutonomousPolicyDecision {
  status: 'approved' | 'blocked'
  policyId: string
  reviewer: string
  reasons: string[]
}

export type WorkflowHumanInputKind = 'authorization' | 'business_rule' | 'test_data'

export interface WorkflowHumanInputQuestion {
  id: string
  kind: WorkflowHumanInputKind
  prompt: string
  reasons: string[]
  sourceRefs: string[]
}

export interface WorkflowHumanInputRequest {
  version: '1.0'
  kind: 'workflow-human-input-request'
  requestId: string
  jobId: string
  workflowId?: string
  sourceSha256?: string
  status: 'pending'
  createdAt: string
  blockedBy: string
  questions: WorkflowHumanInputQuestion[]
  responseInstructions: string[]
}

export interface MutationRecoveryAssessment {
  attempted: boolean
  safeToRetry: boolean
  outstandingMutationIds: string[]
  failedMutationIds: string[]
}

export interface AutonomousJobEvent {
  sequence: number
  at: string
  stage: AutonomousWorkflowStage
  message: string
}

export interface AutonomousWorkflowJobState {
  version: '1.0'
  jobId: string
  requestSha256: string
  status: 'running' | 'completed' | 'blocked' | 'failed'
  stage: AutonomousWorkflowStage
  round: number
  refinementBudgetCeiling?: number
  environmentRetries: number
  executionAttempts: number
  activeExecutionAttempt?: number
  currentDraftPath?: string
  currentExplorationPath?: string
  executionPlanPath?: string
  runtimeResultPath?: string
  humanInputRequestPath?: string
  workflowId?: string
  sourceSha256?: string
  outcome?: AutonomousWorkflowOutcome
  diagnosis?: WorkflowFailureDiagnosis
  policyDecision?: AutonomousPolicyDecision
  error?: string
  events: AutonomousJobEvent[]
  createdAt: string
  updatedAt: string
}

export interface AutonomousWorkflowOperations {
  plan(): Promise<WorkflowPlanDraft>
  explore(
    draft: WorkflowPlanDraft,
    round: number,
    previous?: WorkflowPlanExplorationReport,
  ): Promise<WorkflowPlanExplorationReport>
  refine(
    draft: WorkflowPlanDraft,
    exploration: WorkflowPlanExplorationReport,
    round: number,
  ): Promise<WorkflowPlanDraft>
  execute(plan: WorkflowExecutionPlan, attempt: number): Promise<WorkflowExecutionResult>
}

export interface AutonomousWorkflowRunResult {
  state: AutonomousWorkflowJobState
  draft?: WorkflowPlanDraft
  exploration?: WorkflowPlanExplorationReport
  plan?: WorkflowExecutionPlan
  runtime?: WorkflowExecutionResult
}
