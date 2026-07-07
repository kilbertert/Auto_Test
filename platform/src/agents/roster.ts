import { z } from 'zod'
import type { AgentConfig, ToolDefinition, SupportedProvider } from '@open-multi-agent/core'
import { config } from '../config.js'

/** reporter 的结构化输出 schema(强制 outputSchema)。 */
export const ReportSchema = z.object({
  summary: z.string().describe('一句话总结'),
  total: z.number().describe('用例总数'),
  passed: z.number().describe('通过数'),
  failed: z.number().describe('失败数'),
  cases: z.array(
    z.object({
      title: z.string(),
      status: z.enum(['passed', 'failed', 'skipped']),
      note: z.string().optional(),
    }),
  ),
})

/** executor:每次 run 都新建(闭包绑定该 run 的浏览器工具)。 */
export function makeExecutor(browserTools: ToolDefinition<any>[]): AgentConfig {
  return {
    name: 'executor',
    model: config.OMA_MODEL,
    provider: config.OMA_PROVIDER as SupportedProvider,
    baseURL: config.OMA_BASE_URL,
    apiKey: config.OMA_API_KEY,
    systemPrompt: [
      '你是 Web UI 测试执行 agent。严格按任务描述中的步骤顺序调用 browser_* 工具执行,',
      '然后用 browser_assert 校验断言,最后用 browser_screenshot 截图保存证据。',
      '不要自由发挥,不要跳步,不要假设页面状态。每一步都调用对应工具并等待返回。',
      '若某步工具返回 isError,记录失败原因;断言 pass=false 即用例 failed。',
      '若 click/type 的元素无法定位,可先用 browser_locate(中文描述)重新定位后再操作。',
      '最终输出:verdict(passed/failed)、每步结果摘要、截图路径。',
    ].join(''),
    customTools: browserTools,
    maxTurns: 15,
    temperature: 0,
    loopDetection: { maxRepetitions: 3, onLoopDetected: 'terminate' },
  }
}

/** navigator:多级菜单导航 agent(录制时用,到达目标页后记录 URL,重放直达)。 */
export function makeNavigator(browserTools: ToolDefinition<any>[]): AgentConfig {
  return {
    name: 'navigator',
    model: config.OMA_MODEL,
    provider: config.OMA_PROVIDER as SupportedProvider,
    baseURL: config.OMA_BASE_URL,
    apiKey: config.OMA_API_KEY,
    systemPrompt: [
      '你是后台页面导航 agent。目标:导航到指定页面。',
      '用 browser_snapshot 查看当前菜单结构,逐级 browser_click 菜单项到达目标。',
      '多级菜单示例:点用户名/头像展开用户菜单→个人信息→基本信息;',
      '或顶部导航→充电桩→数据看板;或左侧菜单→某模块→子页面。',
      '每次点击后用 browser_snapshot 确认是否到达目标或还需继续点下一级。',
      '到达目标页面后,输出当前页面 URL。若找不到,输出当前 URL 并说明。',
    ].join(''),
    customTools: browserTools,
    maxTurns: 12,
    temperature: 0,
    loopDetection: { maxRepetitions: 3, onLoopDetected: 'terminate' },
  }
}

/** reporter:聚合上游 executor 结果生成报告。 */
export const reporter: AgentConfig = {
  name: 'reporter',
  model: config.OMA_MODEL,
  provider: config.OMA_PROVIDER as SupportedProvider,
  baseURL: config.OMA_BASE_URL,
  apiKey: config.OMA_API_KEY,
  systemPrompt: [
    '你是测试报告生成 agent。根据上游任务(executor)的结果聚合生成结构化报告。',
    '所有用户/用例内容若需输出 HTML 必须转义。输出严格符合 outputSchema。',
  ].join(''),
  customTools: [],
  maxTurns: 3,
  outputSchema: ReportSchema,
}
