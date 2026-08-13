import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runEvalSuite } from '../src/eval/run-eval-suite.js'
import { compareAgentRuns } from '../src/agent/competition.js'

vi.mock('../src/agent/competition.js', () => ({
  compareAgentRuns: vi.fn(),
}))

function candidate(hostId: string, outcome: 'passed' | 'blocked', oracleMatchRate: number): Record<string, unknown> {
  return {
    runDirectory: `/${hostId}`, hostId, platform: 'x', arch: 'x', terminal: true, outcome,
    caseCounts: { passed: outcome === 'passed' ? 1 : 0, product_failed: 0, blocked: outcome === 'blocked' ? 1 : 0 },
    evidenceCount: 1, citedReceiptCount: 0, mutationCount: 0, pendingMutationCount: 0,
    oracleMatchedCases: oracleMatchRate === 1 ? 1 : 0, oracleMatchRate,
    failureSources: {}, failureKinds: {}, failureModes: {},
  }
}

function report(rates: number[]): unknown {
  return {
    version: '1.0', kind: 'agent-competition', generatedAt: '2026-08-13T00:00:00.000Z',
    workflowId: 'lta后台测试用例-3f28b443', sourceSha256: '3f28b44320c0facd568a58a8bbe1cda4058c18ce3b753b24e016f93b7673f85e',
    contractStatus: 'valid', contractProblems: [],
    verdict: rates.some((rate) => rate !== 1) ? 'oracle_winner' : 'equivalent', winnerHostId: 'baseline', caseDifferences: [],
    candidates: rates.map((rate, index) => candidate(index === 0 ? 'baseline' : 'candidate', rate === 1 ? 'passed' : 'blocked', rate)),
  }
}

describe('runEvalSuite', () => {
  beforeEach(() => vi.mocked(compareAgentRuns).mockReset())

  it('runs the oracle-bound task and fails the gate when a candidate misses the oracle', async () => {
    vi.mocked(compareAgentRuns).mockResolvedValue(report([1, 0]) as never)
    const run = await runEvalSuite({ baselineDirectory: '/baseline', candidateDirectories: ['/candidate'] })
    expect(run.suiteProblems).toEqual([])
    expect(run.tasks.map((task) => task.taskId)).toEqual(['readonly-canary'])
    expect(run.tasks[0]!.gateFailed).toBe(true)
    expect(run.failed).toBe(true)
  })

  it('passes when every candidate fully matches the oracle', async () => {
    vi.mocked(compareAgentRuns).mockResolvedValue(report([1, 1]) as never)
    const run = await runEvalSuite({ baselineDirectory: '/baseline', candidateDirectories: ['/candidate'] })
    expect(run.tasks[0]!.gateFailed).toBe(false)
    expect(run.failed).toBe(false)
  })
})
