import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type {
  CodexTestAgentResult,
  CodexTestAgentState,
  CodexTestCaseResult,
  CodexTestFailureKind,
  CodexTestFailureSource,
  CodexTestMutationLedgerEntry,
  CodexTestMutationResult,
} from '../agent/types.js'
import { redactSensitiveText } from '../input/text.js'
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

const failureSourceLabels: Record<CodexTestFailureSource, string> = {
  product: '产品缺陷',
  agent_execution: '代理执行失败',
  input: '输入资料问题',
  environment: '环境阻断',
  infrastructure: '基础设施故障',
}

const failureKindLabels: Record<CodexTestFailureKind, string> = {
  assertion: '业务断言未通过',
  validation: '输入或页面校验未通过',
  authentication: '登录或认证条件不可用',
  environment: '测试环境条件不可用',
  data: '测试数据缺失或不完整',
  execution: '操作或验证未完成',
}

function cleanLine(value: string): string {
  return redactSensitiveText(value).replace(/\s+/g, ' ').trim()
}

function uniqueLines(values: Iterable<string>): string[] {
  return [...new Set([...values].map(cleanLine).filter(Boolean))]
}

function labeledLines(label: string, values: Iterable<string>, limit = 3): string[] {
  const lines = uniqueLines(values)
  const displayed = lines.slice(0, limit).map((line) => `${label}：${line}`)
  if (lines.length > limit) displayed.push(`${label}：另有 ${lines.length - limit} 条，请查看详细结果。`)
  return displayed
}

function failedCases(result: CodexTestAgentResult): CodexTestCaseResult[] {
  return result.cases.filter((item) => item.outcome !== 'passed')
}

function resultFailureSources(result: CodexTestAgentResult): CodexTestFailureSource[] {
  const sources = failedCases(result).flatMap((item) => item.failureSource ? [item.failureSource] : [])
  if (sources.length === 0 && result.outcome === 'product_failed') sources.push('product')
  if (sources.length === 0 && result.environmentRequirements.some((item) => item.status === 'pending')) sources.push('environment')
  return [...new Set(sources)]
}

function failureCategory(result: CodexTestAgentResult): string {
  const failures = failedCases(result)
  const sources = resultFailureSources(result)
  const sourceLabel = sources.length > 0
    ? sources.map((source) => failureSourceLabels[source]).join('、')
    : '未分类阻断'
  const kinds = [...new Set(failures.flatMap((item) => item.failureKind ? [item.failureKind] : []))]
  if (sources.length === 1 && kinds.length > 0) {
    return `${sourceLabel}（${kinds.map((kind) => failureKindLabels[kind]).join('、')}）`
  }
  return sourceLabel
}

function failureLocation(result: CodexTestAgentResult): string {
  const failures = failedCases(result)
  if (failures.length === 0) {
    return result.environmentRequirements.some((item) => item.status === 'pending') ? '环境准备' : '测试执行'
  }
  if (failures.some((item) => item.failureSource === 'infrastructure')) return 'Auto-Test 执行基础设施'
  const preExecution = failures.every((item) => item.evidence.some((evidence) =>
    evidence.description.includes('Pre-execution validation'),
  ))
  if (preExecution && failures.every((item) => item.failureSource === 'input')) return '测试材料解析'
  if (preExecution && failures.every((item) => item.failureSource === 'environment')) return '环境准备'
  const delivery = failures.every((item) => item.evidence.some((evidence) =>
    evidence.description.includes('Structured delivery validation'),
  ))
  if (delivery) return '结构化结果交付'
  const titles = uniqueLines(failures.map((item) => item.title))
  return titles.length <= 3 ? titles.join('、') : `${titles.slice(0, 3).join('、')}等 ${titles.length} 个用例`
}

function mutationStatusLine(mutations: Array<Pick<CodexTestMutationResult | CodexTestMutationLedgerEntry, 'status'>>): string {
  const pending = mutations.filter((item) => item.status === 'pending').length
  if (pending > 0) return `业务残留：${pending} 项 Mutation 仍为 pending，继续前必须先核对或恢复。`
  if (mutations.length > 0) return '业务残留：无未核销写入，Mutation Ledger pending=0。'
  return '业务残留：Mutation Ledger 未记录待恢复写入（pending=0）。'
}

function defaultNextAction(result: CodexTestAgentResult): string {
  const sources = resultFailureSources(result)
  if (sources.includes('infrastructure')) return '恢复执行依赖后，使用原结果目录继续上次测试。'
  if (sources.includes('environment')) return '补充所需登录、权限、测试数据或物理条件后，使用原结果目录继续。'
  if (sources.includes('input')) return '修正 Excel/sidecar 输入包后开始一次新测试。'
  if (sources.includes('agent_execution')) return '使用原结果目录继续同一 Codex 线程，不要重复已验证的业务写入。'
  if (sources.includes('product')) return '修复产品问题或确认预期结果后，使用相同输入重新验收。'
  return '查看详细结果和运行诊断后处理。'
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as T
}

async function diagnosticLine(statePath: string, fileName = 'run-events.jsonl'): Promise<string | undefined> {
  const path = resolve(dirname(statePath), fileName)
  return access(path).then(() => `运行诊断：${path}`, () => undefined)
}

async function codexAgentSummary(statePath: string, state: CodexTestAgentState): Promise<FriendlyRunSummary> {
  const result = state.resultPath
    ? await readJson<CodexTestAgentResult>(state.resultPath).catch(() => undefined)
    : undefined
  const diagnostics = await diagnosticLine(statePath, 'codex-agent.events.jsonl')
  if (result?.outcome === 'passed') {
    return {
      title: '测试通过',
      outcome: 'passed',
      lines: [
        `完成情况：${result.cases.length}/${result.cases.length} 个用例已验证通过。`,
        mutationStatusLine(result.mutations),
        `详细结果和证据索引：${state.resultPath}`,
      ],
    }
  }
  if (result?.outcome === 'product_failed') {
    return {
      title: '发现产品或业务结果不符合预期',
      outcome: 'product_failed',
      lines: [
        `失败位置：${failureLocation(result)}`,
        `原因类别：${failureCategory(result)}`,
        ...labeledLines('直接原因', result.productDefects.length > 0 ? result.productDefects : [result.summary]),
        ...labeledLines('建议操作', result.nextActions.length > 0 ? result.nextActions : [defaultNextAction(result)]),
        `完成情况：${result.cases.filter((item) => item.outcome === 'passed').length}/${result.cases.length} 个用例已验证通过。`,
        mutationStatusLine(result.mutations),
        `详细结果和证据索引：${state.resultPath}`,
        ...(diagnostics ? [diagnostics] : []),
      ],
    }
  }
  if (result?.outcome === 'blocked') {
    return {
      title: '测试暂时无法继续',
      outcome: 'blocked',
      lines: [
        `失败位置：${failureLocation(result)}`,
        `原因类别：${failureCategory(result)}`,
        ...labeledLines('直接原因', result.blockers.length > 0 ? result.blockers : [result.summary]),
        ...labeledLines('需要补充的环境', result.environmentRequirements
          .filter((item) => item.status === 'pending')
          .map((item) => `${item.origin}：${item.reason}`)),
        ...labeledLines('同时发现的产品问题', result.productDefects),
        ...labeledLines('建议操作', result.nextActions.length > 0 ? result.nextActions : [defaultNextAction(result)]),
        `完成情况：${result.cases.filter((item) => item.outcome === 'passed').length}/${result.cases.length} 个用例已验证通过。`,
        mutationStatusLine(result.mutations),
        `详细结果和证据索引：${state.resultPath}`,
        ...(diagnostics ? [diagnostics] : []),
      ],
    }
  }
  if (state.status === 'running') {
    return {
      title: '测试仍在运行',
      outcome: 'running',
      lines: [`当前阶段：${state.stage}${state.threadId ? `，Codex 线程：${state.threadId}` : ''}。`],
    }
  }
  const ledgerPath = resolve(dirname(statePath), '.agent-private', 'mutation-ledger.json')
  const ledger = await readJson<CodexTestMutationLedgerEntry[]>(ledgerPath).catch(() => undefined)
  return {
    title: '测试执行异常结束',
    outcome: 'failed',
    lines: [
      '失败位置：Auto-Test 执行基础设施',
      '原因类别：基础设施故障',
      `直接原因：${cleanLine(state.error ?? 'Codex 测试代理没有生成有效结果。')}`,
      '建议操作：修复运行依赖后优先使用原结果目录恢复，不要盲目开始新测试。',
      ledger ? mutationStatusLine(ledger) : '业务残留：无法从当前结果确认，请先查看运行诊断。',
      ...(diagnostics ? [diagnostics] : []),
    ],
  }
}

export async function friendlyRunSummary(statePath: string): Promise<FriendlyRunSummary> {
  const input = await readJson<AutonomousWorkflowJobState | CodexTestAgentState>(statePath)
  if ('workflowId' in input && !('jobId' in input)) return codexAgentSummary(statePath, input)
  const state = input
  const diagnostics = await diagnosticLine(statePath)
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
        ...(diagnostics ? [diagnostics] : []),
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
    if (diagnostics) lines.push(diagnostics)
    return { title: '测试暂时无法继续', outcome: 'blocked', lines: [...new Set(lines)] }
  }
  if (state.status === 'running') {
    return { title: '测试仍在运行', outcome: 'running', lines: [`当前阶段：${state.stage}，已完成 ${state.round} 轮修订。`] }
  }
  return {
    title: '测试执行异常结束',
    outcome: 'failed',
    lines: [state.error ?? '请查看控制台输出和本次运行目录。', ...(diagnostics ? [diagnostics] : [])],
  }
}
