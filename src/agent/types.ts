export type CodexTestOutcome = 'passed' | 'product_failed' | 'blocked'
export type CodexTestRisk = 'read' | 'write' | 'destructive'

export interface CodexTestEvidence {
  kind: 'snapshot' | 'screenshot' | 'console' | 'network' | 'observation' | 'mutation'
  path?: string
  description: string
}

export interface CodexTestCaseResult {
  caseId: string
  title: string
  outcome: CodexTestOutcome
  summary: string
  evidence: CodexTestEvidence[]
}

export interface CodexTestMutationResult {
  id: string
  caseId: string
  description: string
  risk: Exclude<CodexTestRisk, 'read'>
  status: 'pending' | 'compensated' | 'accepted'
  evidence: string[]
}

export interface CodexTestEnvironmentRequirement {
  origin: string
  reason: string
  evidence: string[]
  status: 'pending' | 'satisfied'
  requestedAt: string
}

export interface CodexTestAgentResult {
  version: '1.0'
  workflowId: string
  sourceSha256: string
  outcome: CodexTestOutcome
  summary: string
  startedAt: string
  finishedAt: string
  cases: CodexTestCaseResult[]
  mutations: CodexTestMutationResult[]
  environmentRequirements: CodexTestEnvironmentRequirement[]
  blockers: string[]
  productDefects: string[]
  nextActions: string[]
}

export interface CodexTestAgentState {
  version: '1.0'
  status: 'running' | 'completed' | 'failed'
  stage: 'preparing' | 'executing' | 'finalizing' | 'completed' | 'failed'
  workflowId: string
  sourceSha256: string
  startedAt: string
  updatedAt: string
  threadId?: string
  resultPath?: string
  outcome?: CodexTestOutcome
  error?: string
}

export interface CodexTestMutationLedgerEntry {
  id: string
  caseId: string
  description: string
  risk: Exclude<CodexTestRisk, 'read'>
  status: 'pending' | 'compensated' | 'accepted'
  createdAt: string
  updatedAt: string
  evidence: string[]
}

export interface CodexTestCaseDecision {
  caseId: string
  outcome: CodexTestOutcome
  summary: string
  blockers: string[]
  productDefects: string[]
  recordedAt: string
}
