import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
        cases: [{
          caseId: 'filter', title: 'Filter', outcome: 'product_failed', summary: 'Wrong count',
          failureSource: 'product', failureKind: 'assertion',
          evidence: [{ kind: 'observation', description: 'Three rows remained.' }],
        }],
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
      expect(summary.lines).toContain('失败位置：Filter')
      expect(summary.lines).toContain('原因类别：产品缺陷（业务断言未通过）')
      expect(summary.lines).toContain('直接原因：Filtering by Lighting returned three rows instead of two.')
      expect(summary.lines.some((line) => line.startsWith('建议操作：'))).toBe(true)
      expect(summary.lines).toContain('完成情况：0/1 个用例已验证通过。')
      expect(summary.lines).toContain('业务残留：Mutation Ledger 未记录待恢复写入（pending=0）。')
      expect(summary.lines).toContain('用例完成情况：通过 0，产品不符预期 1，暂时阻断 0。')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('shows an actionable environment block with completion and ledger state', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-codex-blocked-summary-'))
    try {
      const resultPath = resolve(directory, 'codex-agent.result.json')
      const statePath = resolve(directory, 'codex-agent.state.json')
      const result: CodexTestAgentResult = {
        version: '1.0', workflowId: 'approval', sourceSha256: 'c'.repeat(64), outcome: 'blocked',
        summary: '当前账号缺少审批权限。', startedAt: '2026-08-01T00:00:00.000Z', finishedAt: '2026-08-01T00:01:00.000Z',
        cases: [
          { caseId: 'create', title: '创建记录', outcome: 'passed', summary: '记录已创建。', evidence: [{ kind: 'observation', description: '记录存在。' }] },
          {
            caseId: 'approve', title: '提交审批', outcome: 'blocked', summary: '当前账号缺少审批权限。',
            failureSource: 'environment', failureKind: 'authentication',
            evidence: [{ kind: 'snapshot', description: '页面未显示审批操作。' }],
          },
        ],
        mutations: [{
          id: 'create-record', caseId: 'create', description: '创建测试记录', risk: 'write', status: 'pending', evidence: [],
        }],
        environmentRequirements: [{
          origin: 'https://admin.example.test', condition: '需要审批权限', caseIds: ['approve'], id: 'approval', kind: 'permission', evidence: ['approval action missing'],
          status: 'pending', requestedAt: '2026-08-01T00:00:30.000Z',
        }],
        blockers: ['当前账号缺少审批权限。', '密码: should-not-be-printed'], productDefects: [],
        nextActions: ['为已注册环境补充审批权限后继续上次测试。'],
      }
      const agentState: CodexTestAgentState = {
        version: '1.0', status: 'completed', stage: 'completed', workflowId: 'approval', sourceSha256: 'c'.repeat(64),
        startedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:01:00.000Z', outcome: 'blocked', resultPath,
      }
      await writeFile(resultPath, JSON.stringify(result))
      await writeFile(statePath, JSON.stringify(agentState))

      const summary = await friendlyRunSummary(statePath)

      expect(summary.lines).toContain('失败位置：提交审批')
      expect(summary.lines).toContain('原因类别：环境阻断（登录或认证条件不可用）')
      expect(summary.lines).toContain('直接原因：当前账号缺少审批权限。')
      expect(summary.lines.join(' ')).not.toContain('should-not-be-printed')
      expect(summary.lines).toContain('直接原因：密码: <redacted>')
      expect(summary.lines).toContain('需要补充的环境：https://admin.example.test：需要审批权限')
      expect(summary.lines).toContain('完成情况：1/2 个用例已验证通过。')
      expect(summary.lines).toContain('业务残留：1 项 Mutation 仍为 pending，继续前必须先核对或恢复。')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports infrastructure failures and preserves unknown mutation risk', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-codex-failed-summary-'))
    try {
      const statePath = resolve(directory, 'codex-agent.state.json')
      const privateDirectory = resolve(directory, '.agent-private')
      await mkdir(privateDirectory)
      await writeFile(resolve(privateDirectory, 'mutation-ledger.json'), JSON.stringify([{
        id: 'pending-write', caseId: 'create', description: '未完成写入', risk: 'write', status: 'pending',
        createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:30.000Z', evidence: [],
      }]))
      await writeFile(resolve(directory, 'codex-agent.events.jsonl'), '{}\n')
      await writeFile(statePath, JSON.stringify({
        version: '1.0', status: 'failed', stage: 'failed', workflowId: 'approval', sourceSha256: 'd'.repeat(64),
        startedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:01:00.000Z', error: 'browser process exited',
      } satisfies CodexTestAgentState))

      const summary = await friendlyRunSummary(statePath)

      expect(summary.outcome).toBe('failed')
      expect(summary.lines).toContain('原因类别：基础设施故障')
      expect(summary.lines).toContain('直接原因：browser process exited')
      expect(summary.lines).toContain('业务残留：1 项 Mutation 仍为 pending，继续前必须先核对或恢复。')
      expect(summary.lines.some((line) => line.includes('codex-agent.events.jsonl'))).toBe(true)
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
        version: '1.0', workflowId: 'mixed', sourceSha256: 'e'.repeat(64), outcome: 'blocked',
        summary: 'The suite needs an environment prerequisite.', startedAt: '2026-08-01T00:00:00.000Z', finishedAt: '2026-08-01T00:01:00.000Z',
        cases: [
          { caseId: 'expected-mismatch', title: 'Expected mismatch', outcome: 'product_failed', summary: 'Expected value differs.', failureSource: 'product', failureKind: 'assertion', evidence: [{ kind: 'observation', description: 'Observed mismatch.' }] },
          { caseId: 'missing-data', title: 'Missing data', outcome: 'blocked', summary: 'Required test data is absent.', failureSource: 'environment', failureKind: 'data', evidence: [{ kind: 'observation', description: 'No matching data.' }] },
        ],
        mutations: [], environmentRequirements: [], blockers: ['Required test data is absent.'], productDefects: ['Expected value differs.'], nextActions: [],
      }
      const agentState: CodexTestAgentState = {
        version: '1.0', status: 'completed', stage: 'completed', workflowId: 'mixed', sourceSha256: 'e'.repeat(64),
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
