import { remainingWorkflowAmbiguities, type WorkflowPlanExplorationReport } from './plan-exploration.js'
import type { WorkflowPlanDraft } from './planner-types.js'
import { validateWorkflowPlanDraft, workflowDraftSha256 } from './planner-validation.js'
import type { AutonomousPolicyDecision, AutonomousWorkflowPolicy } from './autonomy-types.js'
import { isIdempotentCleanupPhase } from './recovery-semantics.js'

export function evaluateAutonomousPolicy(
  input: unknown,
  exploration: WorkflowPlanExplorationReport,
  policy: AutonomousWorkflowPolicy,
): AutonomousPolicyDecision {
  const draft: WorkflowPlanDraft = validateWorkflowPlanDraft(input)
  const reasons: string[] = []
  if (!policy.autoApprove) reasons.push('Policy does not allow automatic approval')
  if (exploration.status !== 'passed') reasons.push('Live exploration did not pass')
  if (exploration.workflowId !== draft.workflowId || exploration.sourceSha256 !== draft.sourceSha256) reasons.push('Exploration source does not match the draft')
  if (exploration.draftSha256 !== workflowDraftSha256(draft)) reasons.push('Exploration draft hash does not match the current draft')
  if (exploration.unresolvedTargetIds.length > 0) reasons.push('Exploration contains unresolved locator targets')
  if (exploration.unresolvedTableIds.length > 0) reasons.push('Exploration contains unresolved table targets')
  if (remainingWorkflowAmbiguities(draft, exploration).length > 0) reasons.push('Draft contains unresolved business ambiguities')

  for (const group of draft.groups) {
    for (const phase of group.phases) {
      if (!policy.allowedRisks.includes(phase.risk)) reasons.push(`Risk ${phase.risk} is not allowed for phase ${phase.id}`)
      if (phase.risk !== 'read' && policy.requireRecoveryFor.includes(phase.risk) && !phase.recovery && !isIdempotentCleanupPhase(phase)) {
        reasons.push(`Phase ${phase.id} has no recovery contract`)
      }
    }
  }

  return {
    status: reasons.length === 0 ? 'approved' : 'blocked',
    policyId: policy.id,
    reviewer: `policy:${policy.id}`,
    reasons,
  }
}
