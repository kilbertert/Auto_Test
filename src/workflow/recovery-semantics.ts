interface CleanupSemanticPhase {
  risk: string
  steps: Array<{ kind: string; actionNames?: string[] }>
  assertions: Array<{ kind: string; expected?: unknown }>
}

export function isIdempotentCleanupPhase(phase: CleanupSemanticPhase): boolean {
  if (phase.risk !== 'destructive') return false
  const capturesEntity = phase.steps.some((step) => step.kind === 'captureTableRow')
  const performsCleanup = phase.steps.some((step) =>
    step.kind === 'clickAlignedTableAction' &&
    step.actionNames?.some((name) => /删除|移除|停止|强停|结算|delete|remove|stop|settle/i.test(name)),
  )
  const assertsCleanState = phase.assertions.some((assertion) => assertion.kind === 'tableRowCount' && assertion.expected === 0)
  return capturesEntity && performsCleanup && assertsCleanState
}
