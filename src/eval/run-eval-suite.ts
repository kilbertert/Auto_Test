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
  /** True when any required oracle gate failed. */
  failed: boolean
}

/**
 * Run the fixed eval suite's oracle-bound tasks against one baseline and its
 * candidate runs. This is a thin aggregator over `compareAgentRuns`, not a new
 * service: each task just declares which committed oracle gates its comparison.
 * Tasks whose input contract is not yet wired to a runnable oracle are skipped.
 */
export async function runEvalSuite(options: {
  baselineDirectory: string
  candidateDirectories: string[]
}): Promise<EvalSuiteRun> {
  const suite = canonicalEvalSuite()
  const suiteProblems = evalSuiteProblems(suite)
  if (suiteProblems.length > 0) return { suiteProblems, tasks: [], failed: true }

  const runDirectories = [options.baselineDirectory, ...options.candidateDirectories]
  const tasks: EvalSuiteTaskResult[] = []
  for (const task of suite.tasks) {
    if (task.inputContract.kind !== 'oracle') continue
    const oracle = JSON.parse(await readFile(resolve(task.inputContract.path), 'utf8')) as AgentCompetitionOracle
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
      oraclePath: task.inputContract.path,
      requiresOracleMatch: task.requiresOracleMatch,
      verdict: report.verdict,
      contractStatus: report.contractStatus,
      candidates,
      gateFailed,
    })
  }
  return { suiteProblems: [], tasks, failed: tasks.some((task) => task.gateFailed) }
}
