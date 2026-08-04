import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { friendlyRunSummary } from '../src/usability/result-summary.js'
import type { CodexTestAgentResult, CodexTestAgentState } from '../src/agent/types.js'
import type { AutonomousWorkflowJobState, WorkflowHumanInputRequest } from '../src/workflow/autonomy-types.js'

function state(overrides: Partial<AutonomousWorkflowJobState>): AutonomousWorkflowJobState {
  return {
    version: '1.0',
    jobId: 'fixture-job',
    requestSha256: 'a'.repeat(64),
    status: 'completed',
    stage: 'completed',
    round: 2,
    environmentRetries: 0,
    executionAttempts: 1,
    events: [],
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:01:00.000Z',
    ...overrides,
  }
}

describe('friendly autonomous result summary', () => {
  it('summarizes a passed job without exposing internal state fields', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-result-'))
    try {
      const path = resolve(directory, 'state.json')
      await writeFile(path, JSON.stringify(state({ outcome: 'passed', runtimeResultPath: resolve(directory, 'runtime.json') })))

      const result = await friendlyRunSummary(path)

      expect(result.title).toBe('测试通过')
      expect(result.lines.join(' ')).toContain('1 次正式执行')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('turns structured human-input questions into concise Chinese actions', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-blocked-'))
    try {
      const requestPath = resolve(directory, 'request.json')
      const statePath = resolve(directory, 'state.json')
      const request: WorkflowHumanInputRequest = {
        version: '1.0', kind: 'workflow-human-input-request', requestId: 'request', jobId: 'fixture-job',
        status: 'pending', createdAt: '2026-07-31T00:00:00.000Z', blockedBy: 'missing data',
        questions: [{
          id: 'test-data.private-input', kind: 'test_data', prompt: 'internal prompt', reasons: [], sourceRefs: [],
        }],
        responseInstructions: [],
      }
      await writeFile(requestPath, JSON.stringify(request))
      await writeFile(resolve(directory, 'run-events.jsonl'), '{}\n')
      await writeFile(statePath, JSON.stringify(state({
        status: 'blocked', stage: 'blocked', outcome: 'blocked', humanInputRequestPath: requestPath,
      })))

      const result = await friendlyRunSummary(statePath)

      expect(result.title).toBe('测试暂时无法继续')
      expect(result.lines).toContain('缺少账号、验证码来源或其他私有测试数据。')
      expect(result.lines.some((line) => line.includes('run-events.jsonl'))).toBe(true)
      expect(result.lines).not.toContain('internal prompt')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('summarizes a Codex-native product failure from the structured result', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-codex-result-'))
    try {
      const resultPath = resolve(directory, 'codex-agent.result.json')
      const statePath = resolve(directory, 'codex-agent.state.json')
      const result: CodexTestAgentResult = {
        version: '1.0', workflowId: 'catalog', sourceSha256: 'b'.repeat(64), outcome: 'product_failed',
        summary: 'The catalog did not match the expected result.', startedAt: '2026-08-01T00:00:00.000Z', finishedAt: '2026-08-01T00:01:00.000Z',
        cases: [{ caseId: 'filter', title: 'Filter', outcome: 'product_failed', summary: 'Wrong count', evidence: [{ kind: 'observation', description: 'Three rows remained.' }] }],
        mutations: [], environmentRequirements: [], blockers: [], productDefects: ['Filtering by Lighting returned three rows instead of two.'], nextActions: [],
      }
      const agentState: CodexTestAgentState = {
        version: '1.0', status: 'completed', stage: 'completed', workflowId: 'catalog', sourceSha256: 'b'.repeat(64),
        startedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:01:00.000Z', outcome: 'product_failed', resultPath,
      }
      await writeFile(resultPath, JSON.stringify(result))
      await writeFile(statePath, JSON.stringify(agentState))

      const summary = await friendlyRunSummary(statePath)

      expect(summary.outcome).toBe('product_failed')
      expect(summary.lines).toContain('Filtering by Lighting returned three rows instead of two.')
      expect(summary.lines).toContain('用例完成情况：通过 0，产品不符预期 1，暂时阻断 0。')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps confirmed product failures visible when the overall Codex run is blocked', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-codex-mixed-result-'))
    try {
      const resultPath = resolve(directory, 'codex-agent.result.json')
      const statePath = resolve(directory, 'codex-agent.state.json')
      const result: CodexTestAgentResult = {
        version: '1.0', workflowId: 'mixed', sourceSha256: 'c'.repeat(64), outcome: 'blocked',
        summary: 'The suite needs an environment prerequisite.', startedAt: '2026-08-01T00:00:00.000Z', finishedAt: '2026-08-01T00:01:00.000Z',
        cases: [
          { caseId: 'expected-mismatch', title: 'Expected mismatch', outcome: 'product_failed', summary: 'Expected value differs.', failureSource: 'product', failureKind: 'assertion', evidence: [{ kind: 'observation', description: 'Observed mismatch.' }] },
          { caseId: 'missing-data', title: 'Missing data', outcome: 'blocked', summary: 'Required test data is absent.', failureSource: 'environment', failureKind: 'data', evidence: [{ kind: 'observation', description: 'No matching data.' }] },
        ],
        mutations: [], environmentRequirements: [], blockers: ['Required test data is absent.'], productDefects: ['Expected value differs.'], nextActions: [],
      }
      const agentState: CodexTestAgentState = {
        version: '1.0', status: 'completed', stage: 'completed', workflowId: 'mixed', sourceSha256: 'c'.repeat(64),
        startedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:01:00.000Z', outcome: 'blocked', resultPath,
      }
      await writeFile(resultPath, JSON.stringify(result))
      await writeFile(statePath, JSON.stringify(agentState))

      const summary = await friendlyRunSummary(statePath)

      expect(summary.outcome).toBe('blocked')
      expect(summary.lines).toContain('用例完成情况：通过 0，产品不符预期 1，暂时阻断 1。')
      expect(summary.lines).toContain('产品或业务结果不符合预期：1 条。Expected value differs.')
      expect(summary.lines).toContain('测试环境、权限或测试数据不可用：1 条。Required test data is absent.')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
