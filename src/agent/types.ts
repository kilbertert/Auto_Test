export type CodexTestOutcome = 'passed' | 'product_failed' | 'blocked'
export type CodexTestRisk = 'read' | 'write' | 'destructive'
export type CodexTestFailureSource = 'product' | 'agent_execution' | 'environment' | 'input' | 'infrastructure'
export type CodexTestFailureKind = 'assertion' | 'validation' | 'authentication' | 'environment' | 'data' | 'execution'
export type CodexTestRunInterruptionCode =
  | 'provider_capacity'
  | 'provider_rate_limited'
  | 'provider_authentication'
  | 'provider_unavailable'
  | 'agent_host'
  | 'browser'
  | 'mcp'
  | 'network'
  | 'filesystem'
  | 'unknown'
export type CodexTestRunInterruptionStage = 'preparation' | 'execution' | 'finalization' | 'delivery' | 'unknown'
export type CodexTestEnvironmentRequirementKind = 'origin' | 'permission' | 'authentication' | 'test_data' | 'physical'
export type CodexTestExecutionReceiptKind = 'interaction' | 'observation'

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
  environmentRequirementIds?: string[]
  executionReceiptIds?: string[]
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
  id: string
  caseIds: string[]
  kind: CodexTestEnvironmentRequirementKind
  origin?: string
  condition: string
  evidence: string[]
  status: 'pending' | 'satisfied' | 'superseded'
  requestedAt: string
}

export interface CodexTestExecutionReceipt {
  id: string
  caseId?: string
  tool: string
  kind: CodexTestExecutionReceiptKind
  status: 'completed'
  recordedAt: string
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
  version: '2.0'
  status: 'running' | 'completed' | 'failed'
  stage: 'preparing' | 'executing' | 'finalizing' | 'completed' | 'failed'
  workflowId: string
  sourceSha256: string
  /** AgentHost id used for this logical run; absent only in legacy v2 states. */
  agentHost?: string
  startedAt: string
  updatedAt: string
  finishedAt?: string
  threadId?: string
  threadGeneration: number
  /** Secret-free identity of the AgentHost/model binding used by threadId. */
  sessionBindingFingerprint?: string
  resultPath?: string
  resultWorkbookPath?: string
  outcome?: CodexTestOutcome
  error?: string
  /** Runner-owned operational event; never substitutes for a case verdict. */
  runInterruption?: {
    code: CodexTestRunInterruptionCode
    stage: CodexTestRunInterruptionStage
    summary: string
    nextAction: string
    occurredAt: string
  }
  completedCaseIds: string[]
  epochCount?: number
  activeEpoch?: {
    id: string
    index: number
    total: number
    caseIds: string[]
    stage: 'executing' | 'finalizing' | 'checkpointing'
    threadId?: string
  }
  checkpointPath?: string
  lastUsage?: {
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
  }
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
  environmentRequirementIds?: string[]
  executionReceiptIds?: string[]
  fieldGateIds?: string[]
  recordedAt: string
}

/** Host-neutral names for new integrations; Codex-prefixed names remain API-compatible aliases. */
export type AgentTestOutcome = CodexTestOutcome
export type AgentTestRisk = CodexTestRisk
export type AgentTestResult = CodexTestAgentResult
export type AgentTestState = CodexTestAgentState
export type AgentTestCaseResult = CodexTestCaseResult
export type AgentTestEvidence = CodexTestEvidence
export type AgentTestFailureSource = CodexTestFailureSource
export type AgentTestFailureKind = CodexTestFailureKind
export type AgentTestRunInterruptionCode = CodexTestRunInterruptionCode
export type AgentTestRunInterruptionStage = CodexTestRunInterruptionStage
export type AgentTestEnvironmentRequirement = CodexTestEnvironmentRequirement
export type AgentTestExecutionReceipt = CodexTestExecutionReceipt
export type AgentTestMutationLedgerEntry = CodexTestMutationLedgerEntry
export type AgentTestMutationResult = CodexTestMutationResult
export type AgentTestFieldCompositionGate = CodexTestFieldCompositionGate
export type AgentTestCaseDecision = CodexTestCaseDecision
