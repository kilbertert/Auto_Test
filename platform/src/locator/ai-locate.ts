import { z } from 'zod'
import { OpenMultiAgent } from '@open-multi-agent/core'
import type { AgentConfig, SupportedProvider } from '@open-multi-agent/core'
import type { Page } from 'playwright'
import { LocatorSchema } from '../browser/locator.js'
import { config } from '../config.js'

/**
 * 元素定位层 — AI 语义定位兜底(§8.1 第 3 级 / §8.2)。
 * 给定页面 ARIA 快照 + 中文元素描述,由 LLM 返回最匹配的 Playwright 定位器。
 * 别名未命中时调用,成功后由 resolve-alias.ts 回写别名词典(自学习)。
 */

/** ARIA 快照截断上限(字符),防止超长快照撑爆上下文。 */
const SNAPSHOT_MAX_CHARS = 12000

/** locator-resolver agent 的结构化输出 schema。 */
export const LocateResultSchema = z.object({
  locator: LocatorSchema.describe('最匹配的 Playwright 定位器'),
  reasoning: z.string().describe('选择该定位器的理由(中文)'),
})

/** locator-resolver:单 agent,无工具,结构化输出。可用更强模型(OMA_LOCATOR_*)做定位。 */
export const locatorResolver: AgentConfig = {
  name: 'locator-resolver',
  model: config.OMA_LOCATOR_MODEL ?? config.OMA_MODEL,
  provider: (config.OMA_LOCATOR_PROVIDER ?? config.OMA_PROVIDER) as SupportedProvider,
  baseURL: config.OMA_LOCATOR_BASE_URL ?? config.OMA_BASE_URL,
  apiKey: config.OMA_LOCATOR_API_KEY ?? config.OMA_API_KEY,
  systemPrompt: [
    '你是 Web 元素定位专家。给定页面的 ARIA accessibility 快照与一条中文元素描述,',
    '返回最匹配该元素的 Playwright 定位器。\n',
    '定位器 type 优先级:role > text > css > xpath。ref 不可用(本阶段不实现)。',
    '优先使用 role + name(getByRole),其次 text(getByText),再次 css,xpath 最后。',
    '禁止仅返回裸标签名(如 "div")。role 的 value 填 ARIA role(如 button/link/textbox),',
    '可访问名填 name 字段。css 的 value 填选择器字符串。text 的 value 填可见文本。\n',
    '注意:下拉选项、菜单项、列表项等,选最具体的元素,不要选导航/页脚无关链接。',
    '若快照中无任何元素匹配描述,仍返回最接近的定位器并在 reasoning 说明不确定性。',
  ].join(''),
  customTools: [],
  maxTurns: 2,
  maxTokens: 3000, // 推理模型(如 MiMo)需足够空间思考+输出
  temperature: 0,
  outputSchema: LocateResultSchema,
}

let orchestrator: OpenMultiAgent | null = null

/** locator-resolver 专用编排器单例(用 OMA_LOCATOR_* 强模型,缺省回退 OMA_*)。 */
export function makeLocatorOrchestrator(): OpenMultiAgent {
  if (orchestrator) return orchestrator
  orchestrator = new OpenMultiAgent({
    defaultModel: config.OMA_LOCATOR_MODEL ?? config.OMA_MODEL,
    defaultProvider: (config.OMA_LOCATOR_PROVIDER ?? config.OMA_PROVIDER) as SupportedProvider,
    defaultBaseURL: config.OMA_LOCATOR_BASE_URL ?? config.OMA_BASE_URL,
    defaultApiKey: config.OMA_LOCATOR_API_KEY ?? config.OMA_API_KEY,
    maxConcurrency: 2,
    defaultToolPreset: 'readonly',
  })
  return orchestrator
}

/**
 * AI 语义定位:取页面 body 的 ARIA 快照,交 locator-resolver 推断定位器。
 * @returns locator 结构化定位器;confidence 基线 0.7,role+name 命中时 0.8;reasoning 推断理由。
 * @throws LLM 调用失败或结构化输出校验失败时抛错。
 */
export async function aiLocate(
  page: Page,
  description: string,
): Promise<{
  locator: z.infer<typeof LocatorSchema>
  confidence: number
  reasoning: string
}> {
  const snapshot = await page.locator('body').ariaSnapshot()
  const truncated =
    snapshot.length > SNAPSHOT_MAX_CHARS
      ? snapshot.slice(0, SNAPSHOT_MAX_CHARS) + '\n[...快照已截断]'
      : snapshot

  const prompt = [
    '请在以下页面 ARIA 快照中,定位满足描述的元素,返回 Playwright 定位器。',
    '',
    '【元素描述】',
    description,
    '',
    '【页面 ARIA 快照】',
    truncated,
  ].join('\n')

  const oma = makeLocatorOrchestrator()
  const result = await oma.runAgent(locatorResolver, prompt)

  if (!result.success) {
    throw new Error('aiLocate: locator-resolver 运行失败: ' + (result.error ? String(result.error) : result.output))
  }

  const parsed = LocateResultSchema.safeParse(result.structured)
  if (!parsed.success) {
    throw new Error(
      'aiLocate: 结构化输出校验失败: ' + JSON.stringify(parsed.error.flatten().fieldErrors),
    )
  }

  const { locator, reasoning } = parsed.data
  // role + name 是 Playwright 最稳的定位方式,略提信心;其余基线 0.7。
  const confidence = locator.type === 'role' && locator.name ? 0.8 : 0.7

  return { locator, confidence, reasoning }
}
