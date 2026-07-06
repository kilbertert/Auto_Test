// ---- 用例域 ----
export interface TestCaseSummary {
  id: number
  globalKey: string
  title: string
  modulePath: string
  priority: string
  author: string
  interpretStatus: InterpretStatus
  confidence?: number
}

export interface TestCase extends TestCaseSummary {
  rawSteps?: string
  rawExpected?: string
  structuredSteps?: string | null
  structuredAssertions?: string | null
  ambiguities?: string | null
  precondition?: string
  testData?: string
  testMethod?: string
  project?: string
}

export type InterpretStatus = 'pending' | 'done' | 'failed' | 'manual'

export interface StructuredStep {
  order?: number
  action: string
  targetDescription?: string
  locator?: unknown
  value?: string
  rawText?: string
  confidence?: number
}

export interface StructuredAssertion {
  kind: string
  target?: string
  expected?: string
  rawText?: string
  confidence?: number
}

// ---- 模块树 ----
export interface SubFunction {
  name: string
}

export interface ModuleFunction {
  name: string
  subfunctions: string[]
}

export interface ModuleNode {
  name: string
  functions: ModuleFunction[]
}

export interface CaseTree {
  modules: ModuleNode[]
}

// ---- 列表 / 详情响应 ----
export interface CaseListResponse {
  total: number
  cases: TestCaseSummary[]
}

// ---- 导入 / 解释 ----
export interface ImportResponse {
  cases: number
  projects: string[]
  modules: string[]
}

export interface InterpretResponse {
  done: number
  failed: number
  skipped: number
}

// ---- 执行 ----
export type RunMode = 'agent' | 'smoke' | 'regression' | 'explore'

export interface StartRunPayload {
  mode: RunMode
  caseIds?: number[]
  goal?: string
  url?: string
}

export interface StartRunResponse {
  runId: string
  mode: RunMode
}

export interface RunCase {
  id: number
  caseId: number
  status: RunCaseStatus
  error?: string | null
  caseTitle?: string
  screenshot?: string | null
}

export type RunCaseStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'error'

export interface RunSummary {
  total?: number
  passed?: number
  failed?: number
  skipped?: number
  duration?: number
}

export interface RunDetail {
  run: {
    id: string
    name?: string
    status: string
    summary?: RunSummary
    mode?: RunMode
  }
  runCases: RunCase[]
  summary: RunSummary
}

export interface RunRecord {
  id: string
  mode: RunMode
  status: string
  startedAt: number
  name?: string
}

// ---- WebSocket 消息 ----
export interface WsBaseMessage {
  type: string
  [key: string]: unknown
}

export interface WsProgressMessage extends WsBaseMessage {
  type: 'progress'
  event: {
    type: string
    agent?: string
    task?: string
    [k: string]: unknown
  }
}

export interface WsTraceMessage extends WsBaseMessage {
  type: 'trace'
  event: {
    type: string
    tool?: string
    model?: string
    input?: unknown
    output?: unknown
    durationMs?: number
    [k: string]: unknown
  }
}

export interface WsStreamMessage extends WsBaseMessage {
  type: 'stream'
  agent?: string
  event: {
    type: 'text' | 'reasoning'
    delta?: string
    [k: string]: unknown
  }
}

export interface WsSmokeStepMessage extends WsBaseMessage {
  type: 'smoke_step'
  text: string
}

export interface WsStepMessage extends WsBaseMessage {
  type: 'step'
  step?: StructuredStep
  index?: number
  total?: number
  status?: string
  text?: string
  [k: string]: unknown
}

export interface WsAssertMessage extends WsBaseMessage {
  type: 'assert'
  assertion?: StructuredAssertion
  passed?: boolean
  text?: string
  [k: string]: unknown
}

export interface WsCaseStartMessage extends WsBaseMessage {
  type: 'case_start'
  caseId?: number
  caseTitle?: string
  total?: number
  current?: number
}

export interface WsCaseCompleteMessage extends WsBaseMessage {
  type: 'case_complete'
  caseId?: number
  caseTitle?: string
  status?: RunCaseStatus
  error?: string | null
  screenshot?: string | null
  duration?: number
}

export interface WsRunStartMessage extends WsBaseMessage {
  type: 'run_start'
  runId?: string
  total?: number
  mode?: RunMode
}

export interface WsRunCompleteMessage extends WsBaseMessage {
  type: 'run_complete'
  runId?: string
  summary?: RunSummary
  error?: string | null
}

export interface WsTasksReadyMessage extends WsBaseMessage {
  type: 'tasks_ready'
  tasks: Array<{ title: string }>
}

export interface WsAgentLifecycleMessage extends WsBaseMessage {
  type: 'agent_lifecycle'
  agent?: string
  phase?: string
  [k: string]: unknown
}

export interface WsBudgetMessage extends WsBaseMessage {
  type: 'budget_exceeded'
  agent?: string
  budget?: number
  [k: string]: unknown
}

export type WsMessage =
  | WsProgressMessage
  | WsTraceMessage
  | WsStreamMessage
  | WsSmokeStepMessage
  | WsStepMessage
  | WsAssertMessage
  | WsCaseStartMessage
  | WsCaseCompleteMessage
  | WsRunStartMessage
  | WsRunCompleteMessage
  | WsTasksReadyMessage
  | WsAgentLifecycleMessage
  | WsBudgetMessage
  | WsBaseMessage
