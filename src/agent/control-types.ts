import type { CodexTestEnvironmentRequirement, CodexTestRisk } from './types.js'

export interface CodexTestControlConfig {
  version: '1.0'
  workflowId: string
  sourceSha256: string
  allowedRisk: CodexTestRisk
  targetUrls: string[]
  allowedOrigins?: string[]
  caseIds: string[]
  caseRisks: Record<string, CodexTestRisk>
  evidenceDirectory: string
  planPath: string
  evidencePath: string
  caseResultsPath: string
  mutationLedgerPath: string
  environmentRequirementsPath?: string
  fieldCompositionPath?: string
  secretValuesPath?: string
  testDataAccess?: 'direct' | 'opaque'
}
