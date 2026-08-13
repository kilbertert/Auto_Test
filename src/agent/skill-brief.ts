import type { WorkflowCapability, WorkflowIntakeManifest, WorkflowRisk } from '../workflow/types.js'

/**
 * Experiential, scenario-selected guidance that is loaded on demand instead of
 * living in the permanent prompt. Security and result protocol (Mutation
 * Ledger, authentication-as-test-state, outcome contract, delivery contract)
 * intentionally stay in Core; these briefs only carry how-to knowledge for a
 * concrete environment or scenario.
 */

export interface AgentSkillBrief {
  id: string
  title: string
  /** Signals that select this brief. A brief with no triggers is never auto-loaded. */
  triggers: {
    capabilities?: WorkflowCapability[]
    risks?: WorkflowRisk[]
  }
  /** Experiential guidance only; no credentials, no protocol. */
  body: string
}

export const BUILT_IN_SKILL_BRIEFS: readonly AgentSkillBrief[] = [
  {
    id: 'embedded-image-interpretation',
    title: '内嵌/补充图片解读',
    triggers: { capabilities: ['embeddedImageUnderstanding'] },
    body: '当测试材料包含内嵌或补充图片时，先用视觉能力读出图片中的界面状态、字段位置和预期布局，再回到实时页面核对。图片是来源证据，不是可直接复用的定位器；以实时页面结构和可访问语义为准。',
  },
  {
    id: 'table-entity-identification',
    title: '表格实体识别',
    triggers: { capabilities: ['runtimeEntityCapture'] },
    body: '当用例要求关联“最新/匹配”的订单或记录时，先在本轮运行中捕获或选择明确的实体 ID，再按 ID 定位表格行；不要默认操作列表第一行或最近一行。用列头而不是行号来识别列。',
  },
  {
    id: 'async-wait-patterns',
    title: '异步等待规则',
    triggers: { capabilities: ['scheduledWait'] },
    body: '等待页面状态时，优先等待可观察的完成信号（加载指示消失、目标元素出现、网络请求完成），而不是固定秒数。随机时间窗必须在执行前收敛为明确范围或策略。',
  },
  {
    id: 'multi-origin-session',
    title: '跨域会话',
    triggers: { capabilities: ['multiOrigin'] },
    body: '跨域导航时，先确认每个域的登录与权限状态，再按来源步骤建立或复用会话；不要把单域已登录状态假设到其他域。',
  },
  {
    id: 'fresh-context-per-iteration',
    title: '多轮/多账户隔离',
    triggers: { capabilities: ['freshBrowserContextPerIteration'] },
    body: '循环或多账户执行时，每轮使用干净的上下文并重新建立该轮前置条件，避免上一轮缓存或会话污染下一轮。',
  },
]

export function selectSkillBriefs(manifest: WorkflowIntakeManifest): AgentSkillBrief[] {
  const capabilities = new Set(manifest.requiredCapabilities ?? [])
  const risks = new Set((manifest.phases ?? []).map((phase) => phase.risk).filter((risk): risk is WorkflowRisk => Boolean(risk)))
  return BUILT_IN_SKILL_BRIEFS.filter((brief) => {
    const capabilityMatch = !brief.triggers.capabilities || brief.triggers.capabilities.some((capability) => capabilities.has(capability))
    const riskMatch = !brief.triggers.risks || brief.triggers.risks.some((risk) => risks.has(risk))
    return capabilityMatch && riskMatch
  })
}

export function skillBriefContext(briefs: readonly AgentSkillBrief[]): string {
  if (briefs.length === 0) return '（没有匹配当前场景的经验提示）'
  return briefs.map((brief) => `${brief.title}：${brief.body}`).join('\n')
}
