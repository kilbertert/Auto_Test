import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type {
  CodexTestAgentResult,
  CodexTestAgentState,
  CodexTestEnvironmentRequirement,
} from '../agent/types.js'
import { friendlyRunSummaryFromState } from '../usability/result-summary.js'
import type { FriendlyRunSummary } from '../usability/result-summary.js'

export interface ObservationCaseRow {
  caseId: string
  title: string
  outcome: string
  failureSource: string | undefined
  failureKind: string | undefined
  summary: string
  evidenceCount: number
}

export interface ObservationEnvironmentBlocker {
  id: string
  kind: string
  origin: string | undefined
  condition: string
  caseIds: string[]
}

export interface ObservationRunDetail {
  runId: string
  entry: {
    status: CodexTestAgentState['status'] | 'invalid'
    stage: CodexTestAgentState['stage']
    outcome: string
    startedAt: string
    updatedAt: string
    finishedAt: string | undefined
  }
  progress: {
    epochCount: number | undefined
    activeEpochIndex: number | undefined
    activeEpochTotal: number | undefined
    activeEpochStage: string | undefined
    completedCaseCount: number
    runInterruptionSummary: string | undefined
    runInterruptionNextAction: string | undefined
  }
  cases: ObservationCaseRow[]
  environmentBlockers: ObservationEnvironmentBlocker[]
  summary: FriendlyRunSummary
  resultProblem: string | undefined
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function caseRows(result: CodexTestAgentResult | undefined): ObservationCaseRow[] {
  if (!result) return []
  return result.cases.map((item) => ({
    caseId: item.caseId,
    title: item.title,
    outcome: item.outcome,
    failureSource: item.failureSource,
    failureKind: item.failureKind,
    summary: item.summary,
    evidenceCount: item.evidence.length,
  }))
}

function environmentBlockers(result: CodexTestAgentResult | undefined): ObservationEnvironmentBlocker[] {
  if (!result) return []
  return result.environmentRequirements
    .filter((item: CodexTestEnvironmentRequirement) => item.status === 'pending')
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      origin: item.origin,
      condition: item.condition,
      caseIds: item.caseIds,
    }))
}

/**
 * Project one run directory into the observation detail payload. Reads only
 * the state file and the result file it references; anything missing or
 * corrupt degrades to a `resultProblem` note instead of failing the view.
 */
export async function runDetail(statePath: string): Promise<ObservationRunDetail | undefined> {
  const state = await readJsonFile<CodexTestAgentState>(statePath)
  if (!isRecord(state) || state.version !== '2.0') return undefined
  const runId = basename(dirname(statePath))
  const entry = {
    status: (typeof state.status === 'string' && ['running', 'completed', 'failed'].includes(state.status)
      ? state.status
      : 'invalid') as CodexTestAgentState['status'] | 'invalid',
    stage: (typeof state.stage === 'string' && ['preparing', 'executing', 'finalizing', 'completed', 'failed'].includes(state.stage)
      ? state.stage
      : 'preparing') as CodexTestAgentState['stage'],
    outcome: state.outcome ?? 'none',
    startedAt: typeof state.startedAt === 'string' ? state.startedAt : '',
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : '',
    finishedAt: typeof state.finishedAt === 'string' ? state.finishedAt : undefined,
  }
  const resultPath = state.resultPath ?? resolve(dirname(statePath), 'codex-agent.result.json')
  let result: CodexTestAgentResult | undefined
  let resultProblem: string | undefined
  if (state.resultPath) {
    result = await readJsonFile<CodexTestAgentResult>(state.resultPath)
    if (!result) resultProblem = '结果文件缺失或损坏；以下仅显示状态可用的部分。'
  } else {
    result = await readJsonFile<CodexTestAgentResult>(resultPath)
    if (result && (result.workflowId !== state.workflowId || result.sourceSha256 !== state.sourceSha256)) {
      result = undefined
      resultProblem = '结果文件与状态文件的运行标识不一致；已隐藏结果详情。'
    }
  }
  const summary = await friendlyRunSummaryFromState(statePath, state as CodexTestAgentState)
  return {
    runId,
    entry,
    progress: {
      epochCount: typeof state.epochCount === 'number' ? state.epochCount : undefined,
      activeEpochIndex: state.activeEpoch?.index,
      activeEpochTotal: state.activeEpoch?.total,
      activeEpochStage: state.activeEpoch?.stage,
      completedCaseCount: Array.isArray(state.completedCaseIds) ? state.completedCaseIds.length : 0,
      runInterruptionSummary: state.runInterruption?.summary,
      runInterruptionNextAction: state.runInterruption?.nextAction,
    },
    cases: caseRows(result),
    environmentBlockers: environmentBlockers(result),
    summary,
    resultProblem,
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
