/**
 * P6 AI 探索 agent 名册(§13.4 / §13.6)。
 *
 * 与 P0 roster(executor/reporter)解耦:此处定义探索专用 agent ——
 * page-explorer(页面结构探索)、case-generator(基于 snapshot 生成结构化用例)、
 * debugger(失败自愈定位)。三者均需浏览器工具,由调用方(explore.ts)经
 * makeBrowserTools(session) 注入,参考 roster.ts makeExecutor 模式。
 *
 * LLM 配置(model/provider/baseURL/apiKey)统一从 config 读取。
 */
import type { AgentConfig, ToolDefinition, SupportedProvider } from '@open-multi-agent/core'
import { z } from 'zod'
import { config } from '../config.js'
import { CaseInterpretationSchema, LocatorSchema } from '../interpreter/schemas.js'

/** debugger 的结构化裁定 schema(§13.3):根因 + 修复建议 + 修复后定位器。 */
export const DebugVerdictSchema = z.object({
  rootCause: z.string().describe('失败根因分析'),
  suggestedFix: z.string().describe('修复建议(可包含步骤调整/等待/数据修正)'),
  revisedLocator: LocatorSchema.nullable().describe('修复后的定位器;无法修复时为 null'),
})

/**
 * 按工具名从全集里挑选子集(最小授权:每个 agent 只拿到它需要的工具)。
 * 指定名称未命中时被忽略;若全部未命中则回退为全集,保证 agent 仍有可用工具。
 */
function pickTools(all: ToolDefinition<any>[], names: string[]): ToolDefinition<any>[] {
  const byName = new Map(all.map(t => [t.name, t]))
  const picked = names
    .map(n => byName.get(n))
    .filter((t): t is ToolDefinition<any> => Boolean(t))
  return picked.length ? picked : all
}

/**
 * page-explorer(§13.4):访问页面,用 browser_snapshot 产出可交互元素清单与测试切入点,
 * 为 case-generator 提供页面结构。只授予只读/探索类工具。
 */
export function makePageExplorer(browserTools: ToolDefinition<any>[]): AgentConfig {
  return {
    name: 'page-explorer',
    model: config.OMA_MODEL,
    provider: config.OMA_PROVIDER as SupportedProvider,
    baseURL: config.OMA_BASE_URL,
    apiKey: config.OMA_API_KEY,
    systemPrompt: [
      '你是 Web UI 页面探索 agent。访问目标页面,调用 browser_snapshot 获取 ARIA 可访问性树,',
      '识别页面上所有可交互元素(输入框/按钮/链接/下拉等)及其语义,产出结构化的元素清单与测试切入点。',
      '为下游 case-generator 提供页面结构:列出关键元素的 role/name 与可操作动作,标注值得覆盖的边界与异常入口。',
      '不要执行实际业务操作,仅探索与描述。必要时可用 browser_locate 验证元素可定位性。',
    ].join(''),
    customTools: pickTools(browserTools, [
      'browser_navigate',
      'browser_snapshot',
      'browser_screenshot',
      'browser_locate',
    ]),
    maxTurns: 6,
    temperature: 0,
  }
}

/**
 * case-generator(§13.6):基于页面 snapshot 与测试目标,生成覆盖正常/边界/异常的
 * 结构化用例(steps + assertions)。复用 CaseInterpretationSchema 作为 outputSchema,
 * 产出可直接入库的结构化结果。只授予只读类工具(snapshot/locate)辅助理解页面。
 */
export function makeCaseGenerator(browserTools: ToolDefinition<any>[]): AgentConfig {
  return {
    name: 'case-generator',
    model: config.OMA_MODEL,
    provider: config.OMA_PROVIDER as SupportedProvider,
    baseURL: config.OMA_BASE_URL,
    apiKey: config.OMA_API_KEY,
    systemPrompt: [
      '你是 Web UI 测试用例生成 agent。基于 page-explorer 提供的页面 snapshot 与给定测试目标,',
      '生成覆盖正常路径、边界值、异常校验的结构化测试用例。',
      '每条用例含 steps(顺序执行的浏览器动作)与 assertions(可校验断言)。',
      'targetDescription 保留中文语义别名(如"用户名输入框"),locator 可为 null(执行时走 AI 兜底定位)。',
      '严格符合 outputSchema 输出;ambiguities 记录需人工确认的歧义点。不要自由发挥动作枚举。',
    ].join(''),
    customTools: pickTools(browserTools, ['browser_snapshot', 'browser_locate']),
    outputSchema: CaseInterpretationSchema,
    maxTurns: 8,
    temperature: 0,
  }
}

/**
 * debugger(§13.3):分析执行失败,读 snapshot/截图,给修复 locator 与建议;
 * 可 browser_locate 重试定位。outputSchema 为 DebugVerdictSchema。
 * agent name 为 'debugger'(不与 P0 roster 的 executor/reporter 冲突)。
 */
export function makeCaseDebugger(browserTools: ToolDefinition<any>[]): AgentConfig {
  return {
    name: 'debugger',
    model: config.OMA_MODEL,
    provider: config.OMA_PROVIDER as SupportedProvider,
    baseURL: config.OMA_BASE_URL,
    apiKey: config.OMA_API_KEY,
    systemPrompt: [
      '你是 Web UI 测试失败分析 agent。读取失败步骤的 snapshot 与截图,分析根因:',
      '元素未加载/定位器失效/数据错误/时序问题等。可调用 browser_locate 重新尝试语义定位。',
      '给出修复后的 locator(revisedLocator)与可执行建议(suggestedFix);若无法自动修复则 revisedLocator 为 null。',
      '严格符合 outputSchema 输出。不要重跑整条用例,只做诊断与定位修复。',
    ].join(''),
    customTools: pickTools(browserTools, [
      'browser_snapshot',
      'browser_screenshot',
      'browser_locate',
    ]),
    outputSchema: DebugVerdictSchema,
    maxTurns: 6,
    temperature: 0,
  }
}

/** 别名导出(符合名册命名约定;`debugger` 为保留字,故 debugger 别名为 debuggerAgent)。 */
export const pageExplorer = makePageExplorer
export const caseGenerator = makeCaseGenerator
export const debuggerAgent = makeCaseDebugger
