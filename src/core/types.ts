export type Priority = 'P0' | 'P1' | 'P2' | 'P3'
export type RiskLevel = 'read' | 'write' | 'destructive'
export type ReviewStatus = 'draft' | 'approved' | 'rejected'

export type StepAction =
  | 'navigate'
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'press'
  | 'upload'
  | 'wait_for'
  | 'manual'

export type LocatorStrategy =
  | 'role'
  | 'testId'
  | 'label'
  | 'placeholder'
  | 'text'
  | 'css'
  | 'xpath'

export interface LocatorIR {
  strategy: LocatorStrategy
  value: string
  name?: string
  exact?: boolean
  source: 'manual' | 'playwrightCli' | 'aiSuggested'
}

export interface WaitConditionIR {
  kind: 'visible' | 'hidden' | 'attached' | 'detached' | 'url' | 'response'
  expected?: string
  timeoutMs?: number
}

export interface DataBindingIR {
  name: string
  source: 'literal' | 'secret' | 'generated'
  value?: string | number | boolean
  secretRef?: string
  generator?: string
}

export interface StepIR {
  id: string
  action: StepAction
  targetDescription: string
  locator?: LocatorIR
  valueRef?: string
  literalValue?: string | number | boolean
  waitFor?: WaitConditionIR
  sourceText: string
  confidence: number
}

export interface AssertionIR {
  id: string
  kind: 'visible' | 'hidden' | 'text' | 'url' | 'title' | 'value' | 'count' | 'enabled' | 'checked'
  targetDescription?: string
  locator?: LocatorIR
  operator: 'equals' | 'contains' | 'matches' | 'gt' | 'gte' | 'lt' | 'lte'
  expected: string | number | boolean
  sourceText: string
  oracleSource: 'tester' | 'approvedManualEdit'
  immutable: true
  confidence: number
}

export interface TestCaseIR {
  id: string
  title: string
  modulePath?: string[]
  priority: Priority
  risk: RiskLevel
  authProfile?: string
  tags?: string[]
  dependencies?: string[]
  preconditions?: string[]
  dataBindings?: DataBindingIR[]
  steps: StepIR[]
  assertions: AssertionIR[]
  cleanupSteps?: StepIR[]
  review: {
    status: ReviewStatus
    ambiguities: string[]
    confidence: number
    reviewedBy?: string
    reviewedAt?: string
  }
  sourceRow?: number
}

export interface TestSuiteIR {
  version: '1.0'
  suiteId: string
  source: {
    format: 'xlsx'
    fileName: string
    sheetName?: string
    sha256: string
  }
  target: {
    baseUrl: string
    allowedOrigins: string[]
    authProfile?: string
  }
  policy: {
    caseTimeoutMs: number
    retries: number
    repair: {
      maxAttempts: number
      allowedChanges: Array<'locator' | 'waitCondition'>
      assertionMutation: 'forbidden'
    }
    destructiveActions: 'blocked' | 'requireApproval'
  }
  cases: TestCaseIR[]
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export interface Diagnostic {
  severity: DiagnosticSeverity
  code: string
  message: string
  sheet?: string
  row?: number
  column?: string
  caseId?: string
  path?: string
}

export interface ImportSummary {
  sheetName: string | null
  headerRow: number | null
  totalDataRows: number
  importedCases: number
  skippedRows: number
  errors: number
  warnings: number
}

export interface ImportReport {
  sourceFile: string
  headerMap: Record<string, { column: number; header: string }>
  unknownHeaders: string[]
  summary: ImportSummary
  diagnostics: Diagnostic[]
}

export interface ImportResult {
  suite: TestSuiteIR
  report: ImportReport
  schemaValid: boolean
}
