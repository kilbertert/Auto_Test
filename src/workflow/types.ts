import type { Diagnostic } from '../core/types.js'

export type WorkflowRisk = 'read' | 'write' | 'destructive'

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

export interface WorkflowPhaseDraft {
  id: string
  sourceCaseId?: string
  title: string
  sourceRow: number
  risk: WorkflowRisk
  summary?: string
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
  summary: {
    phases: number
    passed: number
    failed: number
    blocked: number
    assertions: number
    assertionsPassed: number
  }
}
