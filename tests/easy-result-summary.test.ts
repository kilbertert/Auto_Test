import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { friendlyRunSummary } from '../src/usability/result-summary.js'
import type { CodexTestAgentResult, CodexTestAgentState } from '../src/agent/types.js'

describe('friendly AgentHost result summary', () => {
  it('summarizes a passed AgentHost run from the structured result', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-result-'))
    try {
      const resultPath = resolve(directory, 'codex-agent.result.json')
      const statePath = resolve(directory, 'codex-agent.state.json')
      const result: CodexTestAgentResult = {
        version: '1.0', workflowId: 'catalog', sourceSha256: 'b'.repeat(64), outcome: 'passed',
        summary: 'The catalog behaved as expected.', startedAt: '2026-08-01T00:00:00.000Z', finishedAt: '2026-08-01T00:01:00.000Z',
        cases: [{
          caseId: 'filter', title: 'Filter', outcome: 'passed', summary: 'Count matched.',
          evidence: [{ kind: 'observation', description: 'Two rows remained.' }],
        }],
        mutations: [], environmentRequirements: [], blockers: [], productDefects: [], nextActions: [],
      }
      const agentState: CodexTestAgentState = {
        version: '2.0', status: 'completed', stage: 'completed', workflowId: 'catalog', sourceSha256: 'b'.repeat(64),
        startedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:01:00.000Z', threadGeneration: 0,
        completedCaseIds: ['filter'], outcome: 'passed', resultPath,
      }
      await writeFile(resultPath, JSON.stringify(result))
      await writeFile(statePath, JSON.stringify(agentState))

      const summary = await friendlyRunSummary(statePath)

      expect(summary.outcome).toBe('passed')
      expect(summary.lines).toContain('完成情况：1/1 个用例已验证通过。')
      expect(summary.lines).toContain('业务残留：Mutation Ledger 未记录待恢复写入（pending=0）。')
      expect(summary.lines).toContain(`详细结果和证据索引：${resultPath}`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects legacy autonomous workflow state files', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-blocked-'))
    try {
      const statePath = resolve(directory, 'state.json')
      await writeFile(statePath, JSON.stringify({
        version: '1.0',
        jobId: 'fixture-job',
        requestSha256: 'a'.repeat(64),
        status: 'blocked',
        stage: 'blocked',
        outcome: 'blocked',
        round: 2,
        environmentRetries: 0,
        executionAttempts: 1,
        events: [],
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:01:00.000Z',
      }))

      await expect(friendlyRunSummary(statePath)).rejects.toThrow(/只支持当前 AgentHost 状态文件/)
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
        version: '2.0', status: 'completed', stage: 'completed', workflowId: 'catalog', sourceSha256: 'b'.repeat(64),
        startedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:01:00.000Z', threadGeneration: 0, completedCaseIds: [], outcome: 'product_failed', resultPath,
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
        version: '2.0', status: 'completed', stage: 'completed', workflowId: 'approval', sourceSha256: 'c'.repeat(64),
        startedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:01:00.000Z', threadGeneration: 0, completedCaseIds: [], outcome: 'blocked', resultPath,
      }
      await writeFile(resultPath, JSON.stringify(result))
      await writeFile(statePath, JSON.stringify(agentState))

      const summary = await friendlyRunSummary(statePath)

      expect(summary.lines).toContain('失败位置：提交审批')
      expect(summary.lines).toContain('原因类别：环境阻断（登录或认证条件不可用）')
      expect(summary.lines).toContain('直接原因：当前账号缺少审批权限。')
      expect(summary.lines.join(' ')).not.toContain('should-not-be-printed')
      expect(summary.lines).not.toContain('直接原因：密码: <redacted>')
      expect(summary.lines).toContain('需要补充的环境：https://admin.example.test：需要审批权限')
      expect(summary.lines).toContain('完成情况：1/2 个用例已验证通过。')
      expect(summary.lines).toContain('业务残留：1 项 Mutation 仍为 pending，继续前必须先核对或恢复。')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('shows a case cause and a provider interruption as separate facts', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-causal-summary-'))
    try {
      const resultPath = resolve(directory, 'codex-agent.result.json')
      const statePath = resolve(directory, 'codex-agent.state.json')
      const condition = '需要可控制外部测试设备的连接状态。'
      const result: CodexTestAgentResult = {
        version: '1.0', workflowId: 'device-state', sourceSha256: 'f'.repeat(64), outcome: 'blocked',
        summary: '测试存在尚未满足的环境前置条件。', startedAt: '2026-08-12T00:00:00.000Z', finishedAt: '2026-08-12T00:01:00.000Z',
        cases: [{
          caseId: 'connector-state', title: '设置连接状态', outcome: 'blocked', summary: condition,
          failureSource: 'environment', failureKind: 'environment', environmentRequirementIds: ['physical-control'],
          evidence: [{ kind: 'observation', path: 'evidence/device-state.png', description: '页面没有状态控制入口。' }],
        }],
        mutations: [],
        environmentRequirements: [{
          id: 'physical-control', caseIds: ['connector-state'], kind: 'physical', origin: 'https://app.example.test',
          condition, evidence: ['evidence/device-state.png'], status: 'pending', requestedAt: '2026-08-12T00:00:30.000Z',
        }],
        blockers: [condition], productDefects: [],
        nextActions: [`补充环境前置条件：${condition}，然后使用原结果目录继续上次测试。`],
      }
      const agentState: CodexTestAgentState = {
        version: '2.0', status: 'completed', stage: 'completed', workflowId: 'device-state', sourceSha256: 'f'.repeat(64),
        startedAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:01:00.000Z', threadGeneration: 1,
        completedCaseIds: [], outcome: 'blocked', resultPath,
        runInterruption: {
          code: 'provider_rate_limited', stage: 'finalization', summary: '模型服务额度不足或调用频率受限。',
          nextAction: '恢复或切换可用的模型 API 额度后，使用原结果目录继续上次测试。', occurredAt: '2026-08-12T00:00:55.000Z',
        },
      }
      await writeFile(resolve(directory, 'codex-agent.events.jsonl'), '{}\n')
      await writeFile(resultPath, JSON.stringify(result))
      await writeFile(statePath, JSON.stringify(agentState))

      const summary = await friendlyRunSummary(statePath)

      expect(summary.lines).toContain(`直接原因：${condition}`)
      expect(summary.lines).toContain('运行中断事件 [provider_rate_limited]：结果收尾阶段；模型服务额度不足或调用频率受限。')
      expect(summary.lines).toContain(`建议操作：补充环境前置条件：${condition}，然后使用原结果目录继续上次测试。`)
      expect(summary.lines).not.toContain('直接原因：模型服务额度不足或调用频率受限。')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not let unfinished infrastructure cases hide a confirmed environment cause', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-mixed-causal-summary-'))
    try {
      const resultPath = resolve(directory, 'codex-agent.result.json')
      const statePath = resolve(directory, 'codex-agent.state.json')
      const result: CodexTestAgentResult = {
        version: '1.0', workflowId: 'mixed-cause', sourceSha256: '1'.repeat(64), outcome: 'blocked', summary: '部分用例未完成。',
        startedAt: '2026-08-12T00:00:00.000Z', finishedAt: '2026-08-12T00:01:00.000Z',
        cases: [
          {
            caseId: 'environment-case', title: '设备状态', outcome: 'blocked', summary: '缺少可控测试设备。',
            failureSource: 'environment', failureKind: 'environment', environmentRequirementIds: ['device-control'],
            evidence: [{ kind: 'observation', description: '页面没有状态控制。' }],
          },
          {
            caseId: 'unfinished-case', title: '后续筛选', outcome: 'blocked', summary: '模型服务额度不足或调用频率受限。',
            failureSource: 'infrastructure', failureKind: 'execution', evidence: [{ kind: 'observation', description: 'Provider interruption.' }],
          },
        ],
        mutations: [], environmentRequirements: [], blockers: ['缺少可控测试设备。', '模型服务额度不足或调用频率受限。'],
        productDefects: [], nextActions: [],
      }
      const agentState: CodexTestAgentState = {
        version: '2.0', status: 'completed', stage: 'completed', workflowId: 'mixed-cause', sourceSha256: '1'.repeat(64),
        startedAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:01:00.000Z', threadGeneration: 1,
        completedCaseIds: [], outcome: 'blocked', resultPath,
      }
      await writeFile(resultPath, JSON.stringify(result))
      await writeFile(statePath, JSON.stringify(agentState))

      const summary = await friendlyRunSummary(statePath)

      expect(summary.lines).toContain('失败位置：设备状态')
      expect(summary.lines).toContain('原因类别：环境阻断（测试环境条件不可用）')
      expect(summary.lines).toContain('直接原因：缺少可控测试设备。')
      expect(summary.lines).not.toContain('直接原因：模型服务额度不足或调用频率受限。')
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
        version: '2.0', status: 'failed', stage: 'failed', workflowId: 'approval', sourceSha256: 'd'.repeat(64),
        startedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:01:00.000Z', threadGeneration: 0, completedCaseIds: [], error: 'browser process exited',
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
        version: '2.0', status: 'completed', stage: 'completed', workflowId: 'mixed', sourceSha256: 'e'.repeat(64),
        startedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:01:00.000Z', threadGeneration: 0, completedCaseIds: [], outcome: 'blocked', resultPath,
      }
      await writeFile(resultPath, JSON.stringify(result))
      await writeFile(statePath, JSON.stringify(agentState))

      const summary = await friendlyRunSummary(statePath)

      expect(summary.outcome).toBe('blocked')
      expect(summary.lines).toContain('用例完成情况：通过 0，产品不符预期 1，暂时阻断 1。')
      expect(summary.lines).toContain('产品或业务结果不符合预期：1 条。Expected value differs.')
      expect(summary.lines).toContain('测试环境、权限或测试数据不可用：1 条。Required test data is absent.')
      expect(summary.lines).toContain('直接原因：Required test data is absent.')
      expect(summary.lines).not.toContain('直接原因：Expected value differs.')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
