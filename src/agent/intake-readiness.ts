import type { WorkflowIntakeManifest } from '../workflow/types.js'

export interface AgentIntakeReadiness {
  executable: boolean
  problems: string[]
}

const sha256Pattern = /^[a-f0-9]{64}$/i

/**
 * Intake diagnostics describe source quality. Only the immutable execution
 * contract can prevent an AgentHost run from starting.
 */
export function assessAgentIntakeReadiness(manifest: WorkflowIntakeManifest): AgentIntakeReadiness {
  const problems: string[] = []
  if (!sha256Pattern.test(manifest.source.sha256)) problems.push('原始测试材料缺少有效 SHA-256 身份')
  if (manifest.targetUrls.length === 0) problems.push('测试材料没有可访问的目标 URL')
  if (manifest.phases.length === 0) problems.push('测试材料没有可追踪的测试 case')

  const ids = new Set<string>()
  for (const phase of manifest.phases) {
    if (!phase.id.trim()) problems.push(`来源第 ${phase.sourceRow} 行没有稳定 case ID`)
    if (ids.has(phase.id)) problems.push(`case ID ${phase.id} 在 Manifest 中重复`)
    ids.add(phase.id)
    if (!Number.isInteger(phase.sourceRow) || phase.sourceRow < 1) {
      problems.push(`case ${phase.id} 缺少有效来源行定位`)
    }
  }

  return { executable: problems.length === 0, problems }
}
