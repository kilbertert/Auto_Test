import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { compareAgentRuns, type AgentCompetitionOracle } from '../agent/competition.js'
import type { AgentTestOutcome } from '../agent/types.js'
import { canonicalEvalSuite, evalSuiteProblems } from './eval-suite.js'

export interface EvalSuiteCandidateResult {
  hostId: string
  outcome: AgentTestOutcome
  oracleMatchedCases?: number
  oracleMatchRate?: number
}

export interface EvalSuiteTaskResult {
  taskId: string
  oraclePath?: string
  requiresOracleMatch: boolean
  verdict: string
  contractStatus: string
  candidates: EvalSuiteCandidateResult[]
  /** True when this task requires a full oracle match and some candidate misses it. */
  gateFailed: boolean
}

export interface EvalSuiteRun {
  suiteProblems: string[]
  tasks: EvalSuiteTaskResult[]
  /** Task ids that were skipped because their oracle is not authored or wired yet. */
  skipped: string[]
  /** True when any required oracle gate failed. */
  failed: boolean
}

/**
 * Run the fixed eval suite's oracle-bound tasks against one baseline and its
 * candidate runs. This is a thin aggregator over `compareAgentRuns`, not a new
 * service: each task declares which committed/private oracle gates its
 * comparison. A task whose oracle file is missing is skipped, not failed —
 * oracles are business-specific ground truth authored locally (see
 * templates/eval-oracle.example.json), not checked in.
 */
export async function runEvalSuite(options: {
  baselineDirectory: string
  candidateDirectories: string[]
  /** Override a task's oracle path; tests inject a synthetic oracle here. */
  oracleOverrides?: Partial<Record<string, string>>
}): Promise<EvalSuiteRun> {
  const suite = canonicalEvalSuite()
  const suiteProblems = evalSuiteProblems(suite)
  if (suiteProblems.length > 0) return { suiteProblems, tasks: [], skipped: [], failed: true }

  const runDirectories = [options.baselineDirectory, ...options.candidateDirectories]
  const tasks: EvalSuiteTaskResult[] = []
  const skipped: string[] = []
  for (const task of suite.tasks) {
    if (task.inputContract.kind !== 'oracle') {
      skipped.push(task.id)
      continue
    }
    const oraclePath = options.oracleOverrides?.[task.id] ?? task.inputContract.path
    let oracle: AgentCompetitionOracle
    try {
      oracle = JSON.parse(await readFile(resolve(oraclePath), 'utf8')) as AgentCompetitionOracle
    } catch {
      skipped.push(task.id)
      continue
    }
    const report = await compareAgentRuns({ runDirectories, oracle })
    const candidates: EvalSuiteCandidateResult[] = report.candidates.map((candidate) => ({
      hostId: candidate.hostId,
      outcome: candidate.outcome,
      ...(candidate.oracleMatchedCases !== undefined ? { oracleMatchedCases: candidate.oracleMatchedCases } : {}),
      ...(candidate.oracleMatchRate !== undefined ? { oracleMatchRate: candidate.oracleMatchRate } : {}),
    }))
    const gateFailed = task.requiresOracleMatch && candidates.some((candidate) => candidate.oracleMatchRate !== 1)
    tasks.push({
      taskId: task.id,
      oraclePath,
      requiresOracleMatch: task.requiresOracleMatch,
      verdict: report.verdict,
      contractStatus: report.contractStatus,
      candidates,
      gateFailed,
    })
  }
  return { suiteProblems: [], tasks, skipped, failed: tasks.some((task) => task.gateFailed) }
}
