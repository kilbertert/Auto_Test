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
  locator: '定位或导航未完成',
  mutation: '写入或清理未完成',
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

function terminalCauseCases(result: CodexTestAgentResult): CodexTestCaseResult[] {
  const failures = failedCases(result)
  const matchingOutcome = failures.filter((item) => item.outcome === result.outcome)
  const scoped = matchingOutcome.length > 0 ? matchingOutcome : failures
  const nonInfrastructure = scoped.filter((item) => item.failureSource !== 'infrastructure')
  return nonInfrastructure.length > 0 ? nonInfrastructure : scoped
}

function resultFailureSources(result: CodexTestAgentResult): CodexTestFailureSource[] {
  const sources = terminalCauseCases(result).flatMap((item) => item.failureSource ? [item.failureSource] : [])
  if (sources.length === 0 && result.outcome === 'product_failed') sources.push('product')
  if (sources.length === 0 && result.environmentRequirements.some((item) => item.status === 'pending')) sources.push('environment')
  return [...new Set(sources)]
}

function failureCategory(result: CodexTestAgentResult): string {
  const failures = terminalCauseCases(result)
  const sources = [...new Set(failures.flatMap((item) => item.failureSource ? [item.failureSource] : []))]
  if (sources.length === 0 && result.outcome === 'product_failed') sources.push('product')
  if (sources.length === 0 && result.environmentRequirements.some((item) => item.status === 'pending')) sources.push('environment')
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
  const failures = terminalCauseCases(result)
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
  if (sources.includes('agent_execution')) return '使用原结果目录继续同一 AgentHost 线程，不要重复已验证的业务写入。'
  if (sources.includes('product')) return '修复产品问题或确认预期结果后，使用相同输入重新验收。'
  return '查看详细结果和运行诊断后处理。'
}

function blockedDirectReasons(result: CodexTestAgentResult): string[] {
  const failures = terminalCauseCases(result)
  return failures.length > 0
    ? failures.map((item) => item.summary)
    : result.blockers.length > 0 ? result.blockers : [result.summary]
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as T
}

async function diagnosticLine(statePath: string, fileName = 'codex-agent.events.jsonl'): Promise<string | undefined> {
  const path = resolve(dirname(statePath), fileName)
  return access(path).then(() => `运行诊断：${path}`, () => undefined)
}

function agentRunDetails(result: CodexTestAgentResult, state?: CodexTestAgentState): string[] {
  const counts = result.cases.reduce<Record<'passed' | 'product_failed' | 'blocked', number>>((all, item) => {
    all[item.outcome] += 1
    return all
  }, { passed: 0, product_failed: 0, blocked: 0 })
  const lines = [
    `执行宿主：${state?.agentHost ?? 'codex（兼容旧状态）'}`,
    `用例完成情况：通过 ${counts.passed}，产品不符预期 ${counts.product_failed}，暂时阻断 ${counts.blocked}。`,
  ]
  const nonPassed = result.cases.filter((item) => item.outcome !== 'passed')
  const groups = new Map<string, typeof nonPassed>()
  for (const item of nonPassed) {
    const source = item.failureSource ?? (item.outcome === 'product_failed' ? 'product' : 'unclassified')
    const existing = groups.get(source) ?? []
    existing.push(item)
    groups.set(source, existing)
  }
  for (const [source, cases] of groups) {
    const label = source === 'unclassified'
      ? '交付结果缺少失败来源分类'
      : ({
          product: '产品或业务结果不符合预期',
          input: '测试材料需要补充',
          environment: '测试环境、权限或测试数据不可用',
          infrastructure: '执行基础设施不可用',
          agent_execution: 'AgentHost 执行或交付未完成',
        } satisfies Record<CodexTestFailureSource, string>)[source as CodexTestFailureSource]
    lines.push(`${label}：${cases.length} 条。${cleanLine(cases[0]?.summary ?? '')}`)
  }
  return lines
}

function runInterruptionLines(state?: CodexTestAgentState): string[] {
  if (!state?.runInterruption) return []
  const stage = ({
    preparation: '准备阶段',
    execution: '业务执行阶段',
    finalization: '结果收尾阶段',
    delivery: '交付阶段',
    unknown: '未知阶段',
  } as const)[state.runInterruption.stage]
  return [
    `运行中断事件 [${state.runInterruption.code}]：${stage}；${cleanLine(state.runInterruption.summary)}`,
    `中断恢复：${cleanLine(state.runInterruption.nextAction)}`,
  ]
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
        ...agentRunDetails(result, state),
        `失败位置：${failureLocation(result)}`,
        `原因类别：${failureCategory(result)}`,
        ...labeledLines('直接原因', result.productDefects.length > 0 ? result.productDefects : [result.summary]),
        ...runInterruptionLines(state),
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
        ...agentRunDetails(result, state),
        `失败位置：${failureLocation(result)}`,
        `原因类别：${failureCategory(result)}`,
        ...labeledLines('直接原因', blockedDirectReasons(result)),
        ...labeledLines('需要补充的环境', result.environmentRequirements
          .filter((item) => item.status === 'pending')
          .map((item) => `${item.origin ?? item.kind}：${item.condition}`)),
        ...runInterruptionLines(state),
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
      lines: [`当前阶段：${state.stage}${state.agentHost ? `，宿主：${state.agentHost}` : ''}${state.threadId ? `，线程：${state.threadId}` : ''}。`],
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
      `直接原因：${cleanLine(state.error ?? 'AgentHost 没有生成有效结果。')}`,
      '建议操作：修复运行依赖后优先使用原结果目录恢复，不要盲目开始新测试。',
      ledger ? mutationStatusLine(ledger) : '业务残留：无法从当前结果确认，请先查看运行诊断。',
      ...(diagnostics ? [diagnostics] : []),
    ],
  }
}

export async function friendlyRunSummary(statePath: string): Promise<FriendlyRunSummary> {
  const state = await readJson<CodexTestAgentState>(statePath)
  if (state.version !== '2.0' || typeof state.workflowId !== 'string' || typeof state.sourceSha256 !== 'string') {
    throw new Error('结果摘要只支持当前 AgentHost 状态文件（version 2.0）')
  }
  return codexAgentSummary(statePath, state)
}

/** Same-source projection for non-CLI consumers (observation plane): summary from an already-read state. */
export async function friendlyRunSummaryFromState(statePath: string, state: CodexTestAgentState): Promise<FriendlyRunSummary> {
  return codexAgentSummary(statePath, state)
}
