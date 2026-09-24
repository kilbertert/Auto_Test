import type { Diagnostic } from '../core/types.js'

export type WorkflowRisk = 'read' | 'write' | 'destructive'

/**
 * Allowed failure-mode taxonomy for a case outcome. Mirrors the eval taxonomy
 * so an outcome contract, a result classification, and an eval report all
 * speak the same eight buckets without a second classifier.
 */
export type WorkflowFailureMode =
  | 'input'
  | 'authentication'
  | 'environment'
  | 'locator_navigation'
  | 'business_assertion'
  | 'mutation_cleanup'
  | 'agent_execution'
  | 'infrastructure'

export type WorkflowCapability =
  | 'embeddedImageUnderstanding'
  | 'multiOrigin'
  | 'freshBrowserContextPerIteration'
  | 'runtimeEntityCapture'
  | 'otpOrCaptcha'
  | 'externalPhysicalState'
  | 'destructiveApproval'
  | 'scheduledWait'

export interface WorkflowSecretBinding {
  name: string
  secretRef: string
  purpose: string
  sourceCell: string
}

export interface WorkflowResource {
  sourceCell: string
  text: string
  urls: string[]
}

export interface WorkflowStepDraft {
  id: string
  sourceText: string
  confidence: number
}

export interface WorkflowOutcomeContract {
  /** The actions the case must perform, derived from the same source row as steps. */
  action?: string[]
  /** Must-be-observed business postconditions. */
  observable: string[]
  /** Required evidence: 'interaction' is an execution-receipt kind; 'observation' is a case-evidence kind. */
  evidence: Array<'interaction' | 'observation'>
  cleanup: string[]
  /**
   * Failure modes this case is allowed to be classified into. When non-empty,
   * a non-passed result whose derived mode is outside this set is a taxonomy
   * violation, not merely an unexpected outcome.
   */
  failureModes?: WorkflowFailureMode[]
}

export interface WorkflowMaterialIndexEntry {
  caseId: string
  title: string
  sourceRow: number
  risk: WorkflowRisk
  imageCount: number
}

export interface WorkflowPhaseDraft {
  id: string
  sourceCaseId?: string
  title: string
  sourceRow: number
  risk: WorkflowRisk
  summary?: string
  outcome?: WorkflowOutcomeContract
  steps: WorkflowStepDraft[]
  resources: WorkflowResource[]
  secretBindings: WorkflowSecretBinding[]
  imageIds: string[]
  review: {
    status: 'draft'
    ambiguities: string[]
  }
}

export interface WorkflowEmbeddedImage {
  id: string
  sheetName: string
  sourceCell: string
  sourceRow: number
  fileName: string
  mediaType: string
  bytes: number
  sha256: string
  reviewStatus: 'required'
}

export interface WorkflowSupplementalImage {
  id: string
  sourceKind: 'supplemental'
  fileName: string
  mediaType: string
  bytes: number
  sha256: string
  reviewStatus: 'required'
}

export interface WorkflowIntakeManifest {
  version: '1.0'
  kind: 'workflow-intake'
  workflowId: string
  source: {
    format: 'xlsx'
    fileName: string
    sheetName: string
    sha256: string
  }
  /** All URLs extracted from the workbook plus explicit run URLs, retained as Agent material context. */
  targetUrls: string[]
  /** URLs explicitly supplied with the run command; the only pre-execution environment targets. */
  declaredTargetUrls?: string[]
  requiredCapabilities: WorkflowCapability[]
  phases: WorkflowPhaseDraft[]
  materialIndex?: WorkflowMaterialIndexEntry[]
  embeddedImages: WorkflowEmbeddedImage[]
  supplementalImages: WorkflowSupplementalImage[]
  review: {
    status: 'draft'
    reasons: string[]
  }
}

export interface WorkflowIntakeReport {
  sourceFile: string
  summary: {
    sheetName: string | null
    phases: number
    images: number
    secretBindings: number
    errors: number
    warnings: number
  }
  diagnostics: Diagnostic[]
}

export interface ExtractedWorkflowAsset {
  metadata: WorkflowEmbeddedImage | WorkflowSupplementalImage
  content: Buffer
}

export interface WorkflowIntakeResult {
  manifest: WorkflowIntakeManifest
  report: WorkflowIntakeReport
  assets: ExtractedWorkflowAsset[]
  secretMaterial: Record<string, string | string[]>
}

export type WorkflowEvidenceStatus = 'passed' | 'failed' | 'blocked'

export interface WorkflowAcceptanceAssertion {
  description: string
  passed: boolean
  evidence: string
}

export interface WorkflowAcceptancePhaseEvidence {
  phaseId: string
  title: string
  sourceRefs: string[]
  status: WorkflowEvidenceStatus
  assertions: WorkflowAcceptanceAssertion[]
  observations: string[]
  entities?: Record<string, string>
}

export interface WorkflowAcceptanceEvidence {
  version: '1.0'
  workflowId: string
  sourceSha256: string
  mode: 'canary' | 'full'
  /**
   * The AgentHost Run this acceptance covers. When present, the acceptance
   * report submits that run's settled Result to the one Result settlement seam —
   * the same settlement the Runner performs when it finalizes — so the report
   * quotes the Runner's contract problem list instead of adjudicating contract
   * problems itself. `src/workflow` must not depend on `src/agent`
   * (architecture.yml), so the acceptance CLI stays the Adapter that reads
   * these artifacts and asks the seam; only the verdict reaches the report.
   */
  runDirectory?: string
  startedAt: string
  finishedAt: string
  accountRef: string
  businessCanaryStatus: WorkflowEvidenceStatus
  productAcceptanceStatus: WorkflowEvidenceStatus
  phases: WorkflowAcceptancePhaseEvidence[]
  finalState: {
    activeChargingOrders: number
    activeOccupancyOrders: number
    freshContextReturnedToLogin: boolean
    simulatorConnected: boolean
    notes: string[]
  }
  productGaps: string[]
}

export interface WorkflowAcceptanceReport {
  version: '1.0'
  generatedAt: string
  workflow: {
    workflowId: string
    source: WorkflowIntakeManifest['source']
    targetUrls: string[]
    requiredCapabilities: WorkflowCapability[]
    phaseCount: number
    imageCount: number
  }
  acceptance: WorkflowAcceptanceEvidence
  /**
   * The one Result settlement seam's canonical contract problem list for the
   * run this acceptance covers — the same list the Runner's final settlement
   * produces for it. Empty when the acceptance names no run, and empty when
   * that run settled clean; never a verdict this report reached on its own.
   */
  contractProblems: string[]
  summary: {
    phases: number
    passed: number
    failed: number
    blocked: number
    assertions: number
    assertionsPassed: number
  }
}
