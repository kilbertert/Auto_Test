import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { runAgentComparisonCli } from '../src/cli/compare-agent-runs.js'

vi.mock('../src/agent/competition.js', () => ({
  compareAgentRuns: vi.fn(async () => ({
    version: '1.0', kind: 'agent-competition', generatedAt: '2026-08-13T00:00:00.000Z',
    workflowId: 'probe', sourceSha256: 'a'.repeat(64), contractStatus: 'valid', contractProblems: [],
    verdict: 'oracle_winner', winnerHostId: 'baseline', caseDifferences: [],
    oracle: { version: '1.0', workflowId: 'probe', sourceSha256: 'a'.repeat(64), cases: [{ caseId: 'must-fail', outcome: 'blocked' }] },
    candidates: [
      { runDirectory: '/baseline', hostId: 'baseline', platform: 'test', arch: 'test', terminal: true, outcome: 'blocked', caseCounts: { passed: 0, product_failed: 0, blocked: 1 }, evidenceCount: 1, citedReceiptCount: 0, mutationCount: 0, pendingMutationCount: 0, oracleMatchedCases: 1, oracleMatchRate: 1, failureSources: { environment: 1 }, failureKinds: { environment: 1 } },
      { runDirectory: '/candidate', hostId: 'candidate', platform: 'test', arch: 'test', terminal: true, outcome: 'passed', caseCounts: { passed: 1, product_failed: 0, blocked: 0 }, evidenceCount: 1, citedReceiptCount: 0, mutationCount: 0, pendingMutationCount: 0, oracleMatchedCases: 0, oracleMatchRate: 0, failureSources: {}, failureKinds: {}, baselineDelta: { evidenceCount: 0, citedReceiptCount: 0, mutationCount: 0, oracleMatchedCases: -1 } },
    ],
  })),
  writeAgentCompetitionReport: vi.fn(async () => undefined),
}))

describe('agent comparison CLI eval gate', () => {
  it('fails when a probe expected to fail does not match the oracle', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await runAgentComparisonCli(['--run', '/baseline', '--run', '/candidate', '--oracle', resolve('package.json'), '--require-oracle-match'])).toBe(1)
  })

  it('requires an oracle for the strict eval gate', async () => {
    await expect(runAgentComparisonCli(['--run', '/baseline', '--run', '/candidate', '--require-oracle-match']))
      .rejects.toThrow(/必须同时提供 --oracle/)
  })
})
