import type { CodexTestRisk } from './types.js'
import type { AgentFanoutPolicy } from './fanout-policy.js'

export interface AgentTestControlConfig {
  version: '1.0'
  workflowId: string
  sourceSha256: string
  allowedRisk: CodexTestRisk
  targetUrls: string[]
  allowedOrigins?: string[]
  caseIds: string[]
  activeCaseIds?: string[]
  /** Legacy metadata retained for resume compatibility; mutation authorization never trusts inferred case risk. */
  caseRisks?: Record<string, CodexTestRisk>
  evidenceDirectory: string
  planPath: string
  evidencePath: string
  /**
   * The one journal key the Control MCP server needs: the Mutation Ledger path
   * names the run root the RunArtifactStore derives every other journal path
   * from. The journal artifact paths are deliberately not persisted here, so no
   * stale value can redirect where a run writes its own record.
   */
  mutationLedgerPath: string
  secretValuesPath?: string
  testDataAccess?: 'direct' | 'opaque'
  /** Core-owned bounded fan-out limit; absent only in legacy control configs. */
  fanoutPolicy?: AgentFanoutPolicy
}

/** Historical Codex-prefixed name remains source-compatible. */
export type CodexTestControlConfig = AgentTestControlConfig
