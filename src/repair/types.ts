import type { LocatorIR, TestSuiteIR, WaitConditionIR } from '../core/types.js'
import type {
  LocatorValidationReport,
  RuntimeFailureKind,
  ValidationTargetType,
} from '../validation/locator-validator.js'

export type FailureCategory = 'product_defect' | 'test_code' | 'environment' | 'data' | 'policy' | 'unknown'
export type ClassificationConfidence = 'high' | 'medium' | 'low'
export type RepairChangeKind = 'locator' | 'waitCondition'

export interface RepairEligibility {
  eligible: boolean
  allowedChanges: RepairChangeKind[]
  reason: string
}

export interface ClassifiedFailure {
  caseId: string
  title: string
  replay: number | null
  category: FailureCategory
  confidence: ClassificationConfidence
  failureKind: RuntimeFailureKind | 'policy_blocked'
  phase: 'setup' | ValidationTargetType
  targetId?: string
  sourceText?: string
  evidence: string[]
  repair: RepairEligibility
}

export interface FailureClassificationReport {
  version: '1.0'
  generatedAt: string
  suiteId: string
  failures: ClassifiedFailure[]
  summary: Record<FailureCategory, number> & { total: number; repairEligible: number }
}

export interface LocatorRepairChange {
  kind: 'locator'
  caseId: string
  targetId: string
  targetType: ValidationTargetType
  reason: string
  before: LocatorIR
  after: LocatorIR
  candidateGeneratedAt: string
}

export interface WaitRepairChange {
  kind: 'waitCondition'
  caseId: string
  targetId: string
  targetType: 'step' | 'cleanup'
  reason: string
  before: WaitConditionIR
  after: WaitConditionIR
}

export type RepairChange = LocatorRepairChange | WaitRepairChange

export interface RepairAttemptReport {
  attempt: number
  inputIrSha256: string
  outputIrSha256: string
  changes: RepairChange[]
  validation: LocatorValidationReport
  classification: FailureClassificationReport
  status: 'passed' | 'failed'
}

export interface BoundedRepairReport {
  version: '1.0'
  generatedAt: string
  suiteId: string
  maxAttempts: number
  baseline: {
    irSha256: string
    validation: LocatorValidationReport
    classification: FailureClassificationReport
  }
  attempts: RepairAttemptReport[]
  finalStatus: 'already_passed' | 'repaired' | 'unrepaired'
  finalIrSha256: string
}

export interface BoundedRepairResult {
  report: BoundedRepairReport
  finalSuite?: TestSuiteIR
}
