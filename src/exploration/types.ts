import type { Diagnostic, LocatorIR } from '../core/types.js'

export interface ExplorationSessionManifest {
  version: '1.0'
  session: string
  suiteId: string
  caseId: string
  irPath: string
  baseUrl: string
  allowedOrigins: string[]
  workspaceDir: string
  headed: boolean
  createdAt: string
  closedAt?: string
}

export interface LocatorInspection {
  count: number
  visible: boolean | null
  enabled: boolean | null
  editable: boolean | null
  url: string
}

export interface LocatorCandidateReport {
  version: '1.0'
  generatedAt: string
  suiteId: string
  caseId: string
  targetId: string
  targetType: 'step' | 'assertion' | 'cleanup'
  sourceText: string
  snapshotRef: string
  generatedExpression: string
  locator: LocatorIR
  current: LocatorInspection
  afterReload: LocatorInspection
  stableAfterReload: boolean
  diagnostics: Diagnostic[]
}
