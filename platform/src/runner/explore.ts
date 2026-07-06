/**
 * P6 AI 探索执行编排(§5.3 runTeam + §13.7 探索 team)。
 *
 * 与 P0 orchestrate.ts 的 runTasks(显式 DAG)不同,这里用 runTeam:传入测试目标,
 * 由 coordinator 自动分解为"探索页面 → 生成用例 → 执行用例 → 校验 → 报告"任务 DAG。
 * 三套进度回调(onProgress/onTrace/onAgentStream)转发到 WS,与 P0 模式一致。
 *
 * team 名册:page-explorer / case-generator / executor(P0) / debugger / reporter(P0)。
 * executor 失败可 delegate_to_agent('debugger') 自愈(§8.3)。
 */
import { OpenMultiAgent } from '@open-multi-agent/core'
import type {
  OrchestratorEvent,
  TraceEvent,
  StreamEvent,
  SupportedProvider,
  CoordinatorConfig,
} from '@open-multi-agent/core'
import { browserPool } from '../browser/pool.js'
import { makeBrowserTools } from '../browser/tools.js'
import { makeExecutor, reporter } from '../agents/roster.js'
import { makePageExplorer, makeCaseGenerator, makeCaseDebugger } from '../agents/explore-roster.js'
import { config } from '../config.js'
import { broadcast } from '../ws-bus.js'

/** coordinator 指令:测试分解导向,附加在默认分解 prompt 之后(§5.3 instructions)。 */
const exploreCoordinatorSystemPrompt = [
  '你是 Web UI 测试探索协调器。给定一个测试目标与目标页面 URL,把它分解为可执行的任务 DAG。',
  '分解模式:探索页面结构 → 生成结构化用例 → 执行用例 → 校验断言 → 汇总报告。',
  'assignee 必须从名册选择:page-explorer(探索页面可交互元素)、case-generator(基于 snapshot 生成 steps+assertions)、',
  'executor(按生成的步骤执行浏览器动作与断言)、debugger(执行失败时自愈定位)、reporter(聚合全部结果生成报告)。',
  'dependsOn 用任务 title 字符串引用上游任务。任务宁少勿多,避免冗余分解。',
  'page-explorer 与 case-generator 的产出供下游 executor 复用;executor 失败可 delegate_to_agent("debugger")。',
  '最后必须有一个 reporter 任务,依赖全部执行类任务,聚合结果输出报告。',
].join('')

/**
 * 运行一次 AI 探索。coordinator 把 goal 分解为任务 DAG 并调度 team 执行。
 * 进度经 broadcast 转发到 WS(runId 频道);可选 onProgress 回调同步接收(供脚本/测试用)。
 *
 * @param runId  外部逻辑 id,兼作 WS 频道与浏览器会话标识
 * @param goal   测试目标(自然语言)
 * @param url    目标页面 URL(执行前先导航,确保 snapshot 有上下文)
 * @param onProgress 可选进度回调,与 WS 广播同时触发
 */
export async function runExplore(
  runId: string,
  goal: string,
  url: string,
  onProgress?: (msg: unknown) => void,
): Promise<void> {
  /** 同时广播到 WS 与可选回调。回调内不抛(与 onTrace 同步语义一致)。 */
  const emit = (msg: unknown): void => {
    broadcast(runId, msg)
    try {
      onProgress?.(msg)
    } catch {
      /* 回调异常不影响编排 */
    }
  }

  emit({ type: 'run_start', runId, mode: 'explore', goal, url })

  const session = await browserPool.acquire(runId)
  const browserTools = makeBrowserTools(session)

  const agents = [
    makePageExplorer(browserTools),
    makeCaseGenerator(browserTools),
    makeExecutor(browserTools),
    makeCaseDebugger(browserTools),
    reporter,
  ]

  const orchestrator = new OpenMultiAgent({
    defaultModel: config.OMA_MODEL,
    defaultProvider: config.OMA_PROVIDER as SupportedProvider,
    defaultBaseURL: config.OMA_BASE_URL,
    defaultApiKey: config.OMA_API_KEY,
    maxConcurrency: 2,
    defaultToolPreset: 'readonly',
    onProgress: (e: OrchestratorEvent) => emit({ type: 'progress', event: e }),
    onTrace: (e: TraceEvent) => emit({ type: 'trace', event: e }),
    onAgentStream: (agent: string, e: StreamEvent) => emit({ type: 'stream', agent, event: e }),
  })

  const team = orchestrator.createTeam('explore-' + runId.slice(0, 8), {
    name: 'explore-team',
    agents,
    sharedMemory: true,
  })

  const coordinator: CoordinatorConfig = {
    model: config.OMA_MODEL,
    provider: config.OMA_PROVIDER as SupportedProvider,
    baseURL: config.OMA_BASE_URL,
    apiKey: config.OMA_API_KEY,
    instructions: exploreCoordinatorSystemPrompt,
    maxTurns: 3,
  }

  try {
    // 先导航到目标页面,确保后续 snapshot/操作有真实页面上下文
    await session.page.goto(url, { waitUntil: 'domcontentloaded' })
    emit({ type: 'progress', event: { type: 'message', data: { url, navigated: true } } })

    const result = await orchestrator.runTeam(
      team,
      goal + ' (目标页面: ' + url + ')',
      { coordinator },
    )

    // TeamRunResult 无 output 字段;从 reporter agent 结果取输出,回退到状态摘要
    const reporterResult = result.agentResults.get('reporter')
    const output = reporterResult?.output ?? (result.success ? '探索完成' : '探索未完全成功')
    emit({ type: 'run_complete', runId, output, success: result.success })
  } catch (e) {
    emit({ type: 'run_complete', runId, error: String(e) })
    throw e
  } finally {
    browserPool.release(session)
  }
}
