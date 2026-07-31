import type { DataBindingIR, Priority, RiskLevel, TestSuiteIR } from '../core/types.js'
import type { ClassifiedFailure, FailureCategory, RepairChange } from '../repair/types.js'
import type { LocatorCheckResult } from '../validation/locator-validator.js'

export type ReportCaseStatus = 'passed' | 'failed' | 'flaky' | 'skipped' | 'blocked' | 'not_run'

export interface PlaywrightStepEvidence {
  title: string
  durationMs: number
  error?: string
}

export interface PlaywrightAttachmentEvidence {
  name: string
  contentType: string
  path?: string
}

export interface PlaywrightExecutionEvidence {
  projectName: string
  status: 'passed' | 'failed' | 'flaky' | 'skipped'
  expectedStatus: string
  durationMs: number
  retryCount: number
  startTime?: string
  errors: string[]
  steps: PlaywrightStepEvidence[]
  attachments: PlaywrightAttachmentEvidence[]
}

export interface ParsedPlaywrightCase {
  caseId: string
  title: string
  file: string
  line: number
  executions: PlaywrightExecutionEvidence[]
}

export interface ReportTargetTrace {
  id: string
  targetType: 'step' | 'assertion' | 'cleanup'
  sourceText: string
  codeLine: number | null
  expression?: string
  action?: string
  assertion?: {
    kind: string
    operator: string
    expected: string | number | boolean
    oracleSource: string
    immutable: true
  }
  waitFor?: unknown
  valueRef?: string
  validations: LocatorCheckResult[]
  executionSteps: PlaywrightStepEvidence[]
}

export interface IntegratedCaseReport {
  caseId: string
  title: string
  modulePath: string[]
  priority: Priority
  risk: RiskLevel
  tags: string[]
  sourceRow: number | null
  status: ReportCaseStatus
  repaired: boolean
  reviewStatus: string
  dataBindings: Array<Omit<DataBindingIR, 'value'> & { value?: string | number | boolean }>
  code: {
    generatedFile: string
    testLine: number | null
  }
  steps: ReportTargetTrace[]
  assertions: ReportTargetTrace[]
  cleanupSteps: ReportTargetTrace[]
  executions: PlaywrightExecutionEvidence[]
  classifications: ClassifiedFailure[]
  repairs: RepairChange[]
}

export interface IntegratedRunReport {
  version: '1.0'
  generatedAt: string
  suiteId: string
  target: TestSuiteIR['target']
  source: TestSuiteIR['source']
  generatedSpec: {
    file: string
    sha256: string
  }
  integrity: {
    irSha256: string
    sourceMapMatchesIr: true
    assertionsImmutable: boolean
    repairBoundaryIntact: boolean
  }
  summary: {
    total: number
    passed: number
    failed: number
    flaky: number
    skipped: number
    blocked: number
    notRun: number
    repaired: number
    classifications: Record<FailureCategory, number>
  }
  cases: IntegratedCaseReport[]
}
