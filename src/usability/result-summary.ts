import { readFile } from 'node:fs/promises'
import type { AutonomousWorkflowJobState, WorkflowHumanInputRequest } from '../workflow/autonomy-types.js'

const questionLabels: Record<string, string> = {
  'authorization.recovery-cleanup': '需要明确本次测试创建的数据是否允许停止、删除或回滚。',
  'authorization.environment-access': '测试账号、租户或环境权限当前不可用，需要管理员恢复或换用有权限的账号。',
  'business-rule.identifier-conflict': '固定编号已存在时的处理规则不明确：复用、报错，还是删除后重建。',
  'test-data.private-input': '缺少账号、验证码来源或其他私有测试数据。',
  'test-data.environment-option': '目标环境缺少用例要求的选项或设备类型。',
}

const questionKindLabels: Record<WorkflowHumanInputRequest['questions'][number]['kind'], string> = {
  authorization: '需要补充本次测试允许执行的操作范围或环境权限。',
  business_rule: '需要测试工程师补充当前业务场景的处理规则。',
  test_data: '需要补充本次测试使用的私有测试数据或环境选项。',
}

export interface FriendlyRunSummary {
  title: string
  outcome: 'passed' | 'product_failed' | 'blocked' | 'running' | 'failed'
  lines: string[]
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as T
}

export async function friendlyRunSummary(statePath: string): Promise<FriendlyRunSummary> {
  const state = await readJson<AutonomousWorkflowJobState>(statePath)
  if (state.outcome === 'passed') {
    return {
      title: '测试通过',
      outcome: 'passed',
      lines: [
        `已完成 ${state.executionAttempts} 次正式执行。`,
        state.runtimeResultPath ? `详细执行证据：${state.runtimeResultPath}` : '执行证据已保存在本次输出目录。',
      ],
    }
  }
  if (state.outcome === 'product_failed') {
    return {
      title: '发现产品或业务结果不符合预期',
      outcome: 'product_failed',
      lines: [
        state.diagnosis?.reason ?? state.error ?? '页面操作完成，但业务断言没有通过。',
        state.runtimeResultPath ? `详细执行证据：${state.runtimeResultPath}` : '请查看本次输出目录中的 Runtime 结果。',
      ],
    }
  }
  if (state.outcome === 'blocked' || state.status === 'blocked') {
    const lines: string[] = []
    if (state.humanInputRequestPath) {
      const request = await readJson<WorkflowHumanInputRequest>(state.humanInputRequestPath)
      for (const question of request.questions) lines.push(questionLabels[question.id] ?? questionKindLabels[question.kind])
    }
    if (lines.length === 0) lines.push(state.diagnosis?.reason ?? state.error ?? '框架需要补充信息后才能继续。')
    return { title: '测试暂时无法继续', outcome: 'blocked', lines: [...new Set(lines)] }
  }
  if (state.status === 'running') {
    return { title: '测试仍在运行', outcome: 'running', lines: [`当前阶段：${state.stage}，已完成 ${state.round} 轮修订。`] }
  }
  return {
    title: '测试执行异常结束',
    outcome: 'failed',
    lines: [state.error ?? '请查看控制台输出和本次运行目录。'],
  }
}
