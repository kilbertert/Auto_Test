/**
 * AI 录制器(一次性,AI 仅在此模块):对一条用例逐 step 用 AI 预解析 locator +
 * 规范化 action + 确定性执行验证,产出 resolvedSteps/resolvedAssertions 写入 DB。
 * 重放时 DeterministicCaseRunner 直接用 resolvedLocator,不再调 AI。
 *
 * 借鉴 AutoGenesis "Record once with AI, replay deterministically":
 * AI 在录制阶段决定 locator(并自学习回写别名词典),执行阶段零 AI。
 */
import type { Page } from 'playwright'
import type { BrowserSession } from '../browser/pool.js'
import { makeBrowserTools, smokeContext } from '../browser/tools.js'
import type { ToolDefinition } from '@open-multi-agent/core'
import { resolveAliasOrAi } from '../locator/resolve-alias.js'
import type { StructuredStep, StructuredAssertion, ResolvedStep, ResolvedAssertion } from '../interpreter/schemas.js'
import type { Locator } from '../browser/locator.js'
import { sqlite } from '../db/client.js'
import { config } from '../config.js'

type AnyTool = ToolDefinition<any>
type ProgressFn = (msg: { type: string; text: string }) => void

const LOGIN_URL = process.env.TEST_LOGIN_URL ?? config.TARGET_LOGIN_URL

export interface RecordableCase {
  id: number
  title: string
  modulePath?: string
  structuredSteps: StructuredStep[]
  structuredAssertions: StructuredAssertion[]
}

export interface RecordResult {
  status: 'recorded' | 'failed'
  reason?: string
  stepsResolved: number
  assertionsResolved: number
}

/** 规范化 action:SPA "进入X页面"(navigate 非 URL)→ click 菜单。 */
function normalizeAction(step: StructuredStep): ResolvedStep['action'] {
  const v = (step.value ?? '').trim()
  if (step.action === 'navigate') return /^https?:\/\//i.test(v) ? 'navigate_url' : 'click'
  if (step.action === 'check') return 'click'
  if (step.action === 'clear') return 'clear'
  if (step.action === 'wait') return 'wait'
  if (step.action === 'select') return 'select'
  if (step.action === 'type') return 'type'
  return 'click' // other/unknown → 尝试 click
}

function needsLocator(action: ResolvedStep['action']): boolean {
  return action === 'click' || action === 'type' || action === 'select' || action === 'clear'
}

/** 确定性执行一步(验证 locator 可用)。返回是否成功。 */
async function executeAction(
  byName: Map<string, AnyTool>,
  ctx: ReturnType<typeof smokeContext>,
  action: ResolvedStep['action'],
  loc: Locator | null,
  value: string | undefined,
): Promise<boolean> {
  try {
    switch (action) {
      case 'navigate_url':
        await byName.get('browser_navigate')!.execute({ url: value ?? '' }, ctx)
        return true
      case 'click':
        if (!loc) return false
        await byName.get('browser_click')!.execute({ locator: loc }, ctx)
        return true
      case 'type':
        if (!loc) return false
        await byName.get('browser_type')!.execute({ locator: loc, text: value ?? '' }, ctx)
        return true
      case 'select':
        if (!loc) return false
        await byName.get('browser_select')!.execute({ locator: loc, value: value ?? '' }, ctx)
        return true
      case 'clear':
        if (!loc) return false
        await byName.get('browser_type')!.execute({ locator: loc, text: '' }, ctx)
        return true
      case 'wait':
        return true
    }
  } catch {
    return false
  }
  return false
}

/** 页面稳定等待(导航/点击后,SPA 路由切换)。 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
}

/** 录制时验证断言是否通过(用当前 locator + expected)。 */
async function verifyAssert(
  byName: Map<string, AnyTool>,
  ctx: ReturnType<typeof smokeContext>,
  kind: string,
  loc: Locator,
  expected: string | undefined,
): Promise<boolean> {
  try {
    const r = await byName.get('browser_assert')!.execute({ kind, locator: loc, expected: expected ?? '' }, ctx)
    if (r.isError) return false
    return (JSON.parse(r.data) as { pass: boolean }).pass
  } catch {
    return false
  }
}

/** AI 解析 locator:别名词典优先(命中免 AI),未命中走 AI + 自学习回写。 */
async function resolveLocator(page: Page, description: string): Promise<Locator | null> {
  if (!description) return null
  try {
    const { locator } = await resolveAliasOrAi(page, description, page.url())
    return locator
  } catch {
    return null
  }
}

/**
 * 录制一条用例:AI 预解析所有 locator + 执行验证 + 落库 resolved_steps。
 * AI 仅在 resolveLocator 内(每步一次);executeAction 确定性。
 */
export async function recordCase(
  tc: RecordableCase,
  session: BrowserSession,
  onProgress?: ProgressFn,
): Promise<RecordResult> {
  const tools = makeBrowserTools(session)
  const byName = new Map<string, AnyTool>(tools.map((t) => [t.name, t]))
  const ctx = smokeContext()
  const { page } = session

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await settle(page)
  onProgress?.({ type: 'record', text: `开始录制「${tc.title}」(起步:${LOGIN_URL})` })

  const resolvedSteps: ResolvedStep[] = []
  let stepsResolved = 0

  for (let i = 0; i < tc.structuredSteps.length; i++) {
    const step = tc.structuredSteps[i]
    const action = normalizeAction(step)
    // 显式 locator(css/role/...)直接用;alias/null 走 AI
    let resolvedLocator: Locator | null =
      step.locator && step.locator.type !== 'alias' ? step.locator : null

    if (needsLocator(action)) {
      if (!resolvedLocator) {
        resolvedLocator = await resolveLocator(page, step.targetDescription) // AI
      }
      if (resolvedLocator) {
        const ok = await executeAction(byName, ctx, action, resolvedLocator, step.value)
        if (!ok) {
          onProgress?.({ type: 'record', text: `步骤${i + 1} 执行失败,重试定位…` })
          resolvedLocator = await resolveLocator(page, step.targetDescription) // AI 重试
          if (resolvedLocator) await executeAction(byName, ctx, action, resolvedLocator, step.value)
        }
        await settle(page)
      } else {
        onProgress?.({ type: 'record', text: `步骤${i + 1} 无法定位: ${step.targetDescription}` })
      }
    } else if (action === 'navigate_url') {
      await executeAction(byName, ctx, 'navigate_url', null, step.value)
      await settle(page)
    }

    resolvedSteps.push({
      action,
      resolvedLocator,
      value: step.value,
      targetDescription: step.targetDescription,
      rawText: step.rawText,
    })
    if (resolvedLocator || action === 'navigate_url' || action === 'wait') stepsResolved++
    onProgress?.({
      type: 'record',
      text: `步骤${i + 1} ${action} ${resolvedLocator ? JSON.stringify(resolvedLocator) : '(无 locator)'}`,
    })
  }

  // 断言:解析 locator + 录制时验证(失败则重试定位),确保重放可复现
  const resolvedAssertions: ResolvedAssertion[] = []
  let assertionsResolved = 0
  for (const a of tc.structuredAssertions) {
    const needsLoc = a.kind !== 'url' && a.kind !== 'title'
    let loc: Locator | null = a.locator && a.locator.type !== 'alias' ? a.locator : null
    if (needsLoc && !loc) {
      loc = await resolveLocator(page, a.target ?? a.expected) // AI
    }
    if (needsLoc && loc) {
      const pass = await verifyAssert(byName, ctx, a.kind, loc, a.expected)
      if (!pass) {
        onProgress?.({ type: 'record', text: `断言 ${a.kind} 录制未通过,重试定位…` })
        const loc2 = await resolveLocator(page, a.target ?? a.expected) // AI 重试
        if (loc2) loc = loc2
      }
    }
    resolvedAssertions.push({
      kind: a.kind,
      resolvedLocator: loc,
      expected: a.expected,
      target: a.target,
      rawText: a.rawText,
    })
    if (loc || !needsLoc) assertionsResolved++
  }

  const now = new Date().toISOString()
  sqlite
    .prepare(
      `UPDATE test_case SET resolved_steps = ?, resolved_assertions = ?, record_status = 'recorded', updated_at = ? WHERE id = ?`,
    )
    .run(JSON.stringify(resolvedSteps), JSON.stringify(resolvedAssertions), now, tc.id)

  onProgress?.({
    type: 'record',
    text: `录制完成: ${stepsResolved}/${tc.structuredSteps.length} 步, ${assertionsResolved}/${tc.structuredAssertions.length} 断言`,
  })
  return { status: 'recorded', stepsResolved, assertionsResolved }
}
