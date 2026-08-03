export type CodexTestOutcome = 'passed' | 'product_failed' | 'blocked'
export type CodexTestRisk = 'read' | 'write' | 'destructive'
export type CodexTestFailureSource = 'product' | 'agent_execution' | 'environment' | 'input' | 'infrastructure'
export type CodexTestFailureKind = 'assertion' | 'validation' | 'authentication' | 'environment' | 'data' | 'execution'

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
  failureSource?: CodexTestFailureSource
  failureKind?: CodexTestFailureKind
  fieldGateIds?: string[]
  evidence: CodexTestEvidence[]
}

export type CodexTestFieldComponentRole = 'selector' | 'input' | 'display' | 'hidden'
export type CodexTestFieldComponentSource = 'static' | 'secret' | 'derived' | 'unknown'
export type CodexTestFieldRepresentation = 'full' | 'component' | 'suffix' | 'none' | 'unknown'
export type CodexTestFieldContribution = 'segment' | 'context' | 'none'

export interface CodexTestFieldComponent {
  id: string
  role: CodexTestFieldComponentRole
  label: string
  source: CodexTestFieldComponentSource
  observedValue?: string | undefined
  representation: CodexTestFieldRepresentation
  contribution: CodexTestFieldContribution
}

export interface CodexTestFieldRenderedComponent {
  componentId: string
  valueKind: 'static' | 'secret' | 'derived' | 'empty'
  valueLength?: number | undefined
  literalValue?: string | undefined
  secretAlias?: string | undefined
}

export interface CodexTestFieldCompositionGate {
  id: string
  caseId: string
  fieldId: string
  logicalValueRef: string
  purpose: string
  components: CodexTestFieldComponent[]
  rendered: CodexTestFieldRenderedComponent[]
  evidence: string[]
  status: 'passed' | 'blocked'
  reasons: string[]
  checkedAt: string
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
  finishedAt?: string
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
  failureSource?: CodexTestFailureSource
  failureKind?: CodexTestFailureKind
  fieldGateIds?: string[]
  recordedAt: string
}
