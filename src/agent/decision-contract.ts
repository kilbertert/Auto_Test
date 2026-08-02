import type { CodexTestCaseDecision, CodexTestFieldCompositionGate } from './types.js'

export function decisionFieldContractProblem(
  decision: CodexTestCaseDecision,
  fieldGates: CodexTestFieldCompositionGate[],
): string | undefined {
  if (decision.outcome === 'passed') {
    if (decision.failureSource || decision.failureKind) return 'passed decision contains a failure classification'
    const ids = decision.fieldGateIds ?? []
    const gates = ids.map((id) => fieldGates.find((gate) => gate.id === id))
    if (gates.some((gate) => !gate || gate.caseId !== decision.caseId || gate.status !== 'passed')) return 'passed decision references an invalid or blocked composite-field gate'
    return undefined
  }
  if (!decision.failureSource || !decision.failureKind) return 'failure decision has no failure source and kind classification'
  if (decision.outcome === 'product_failed' && decision.failureSource !== 'product') return 'product failure is not classified as product-sourced'
  if (decision.outcome === 'blocked' && decision.failureSource === 'product') return 'blocked decision is incorrectly classified as product-sourced'
  if (decision.failureKind !== 'validation') return undefined
  const ids = decision.fieldGateIds ?? []
  const gates = ids.map((id) => fieldGates.find((gate) => gate.id === id))
  if (ids.length === 0 || gates.some((gate) => !gate || gate.caseId !== decision.caseId)) return 'validation decision lacks matching composite-field gates'
  if (decision.failureSource === 'product' && gates.some((gate) => gate?.status !== 'passed')) return 'product validation failure lacks a passed composite-field gate'
  if (decision.failureSource === 'agent_execution' && gates.every((gate) => gate?.status !== 'blocked')) return 'agent validation failure lacks a blocked composite-field gate'
  return undefined
}
