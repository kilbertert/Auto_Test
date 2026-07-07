/**
 * 确定性重放器:按 resolvedSteps 顺序直接调用浏览器工具(零 AI)。
 * resolvedLocator 已在录制时(record.ts)预解析,运行时不调 browser_locate。
 * strict browser_assert(文本/可见/属性,非截图模糊判断)。失败截图。
 * 每步记录 locator_used,可回溯。
 */
import { makeBrowserTools, smokeContext } from '../browser/tools.js'
import type { BrowserSession } from '../browser/pool.js'
import type { ToolDefinition } from '@open-multi-agent/core'
import type { ResolvedStep, ResolvedAssertion } from '../interpreter/schemas.js'
import { sqlite } from '../db/client.js'
import { config } from '../config.js'

type AnyTool = ToolDefinition<any>
const LOGIN_URL = process.env.TEST_LOGIN_URL ?? config.TARGET_LOGIN_URL

export interface CaseVerdict {
  status: 'passed' | 'failed' | 'skipped'
  reason?: string
  screenshotPath?: string
}

export interface ReplayCase {
  id: number
  title: string
  resolvedSteps: ResolvedStep[]
  resolvedAssertions: ResolvedAssertion[]
}

type ProgressFn = (msg: { type: string; text: string }) => void

/** 确定性重放一条已录制用例。零 AI。runCaseId 用于落 run_step/assertion_result。 */
export async function runDeterministic(
  tc: ReplayCase,
  session: BrowserSession,
  runCaseId: number,
  onProgress?: ProgressFn,
): Promise<CaseVerdict> {
  const tools = makeBrowserTools(session)
  const byName = new Map<string, AnyTool>(tools.map((t) => [t.name, t]))
  const ctx = smokeContext()
  const { page } = session
  const verdict: CaseVerdict = { status: 'passed' }
  const insertStep = sqlite.prepare(
    'INSERT INTO run_step (run_case_id, step_id, status, actual, error, duration_ms, locator_used) VALUES (?,?,?,?,?,?,?)',
  )
  const insertAssert = sqlite.prepare(
    'INSERT INTO assertion_result (run_case_id, assertion_id, pass, actual, error) VALUES (?,NULL,?,?,?)',
  )

  // 起步:导航到已登录后台首页(CDP 共享 cookie → 已登录)
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})

  // ---- 步骤(零 AI:直接用 resolvedLocator)----
  for (let i = 0; i < tc.resolvedSteps.length; i++) {
    const rs = tc.resolvedSteps[i]
    const t0 = Date.now()
    let ok = true
    let error: string | null = null
    try {
      switch (rs.action) {
        case 'navigate_url':
          await byName.get('browser_navigate')!.execute({ url: rs.value ?? '' }, ctx)
          break
        case 'click':
          if (!rs.resolvedLocator) throw new Error('click 无 resolvedLocator(未录制)')
          await byName.get('browser_click')!.execute({ locator: rs.resolvedLocator }, ctx)
          break
        case 'type':
          if (!rs.resolvedLocator) throw new Error('type 无 resolvedLocator(未录制)')
          await byName.get('browser_type')!.execute({ locator: rs.resolvedLocator, text: rs.value ?? '' }, ctx)
          break
        case 'select':
          if (!rs.resolvedLocator) throw new Error('select 无 resolvedLocator(未录制)')
          await byName
            .get('browser_select_custom')!
            .execute({ trigger: rs.resolvedLocator, optionText: rs.value ?? '' }, ctx)
          break
        case 'clear':
          if (!rs.resolvedLocator) throw new Error('clear 无 resolvedLocator(未录制)')
          await byName.get('browser_type')!.execute({ locator: rs.resolvedLocator, text: '' }, ctx)
          break
        case 'wait':
          break
        default:
          break
      }
    } catch (e) {
      ok = false
      error = String((e as Error).message)
    }
    const durationMs = Date.now() - t0
    insertStep.run(
      runCaseId,
      i + 1,
      ok ? 'passed' : 'failed',
      '',
      error,
      durationMs,
      rs.resolvedLocator ? JSON.stringify(rs.resolvedLocator) : null,
    )
    onProgress?.({ type: 'step', text: `步骤${i + 1} ${rs.action} ${ok ? 'OK' : 'FAIL' + (error ? ' ' + error : '')}` })
    if (!ok) {
      verdict.status = 'failed'
      verdict.reason = `步骤${i + 1}(${rs.action})失败: ${error}`
      break
    }
  }

  // ---- 断言(零 AI:用 resolvedLocator,严格 browser_assert)----
  if (verdict.status === 'passed') {
    for (const ra of tc.resolvedAssertions) {
      let pass = false
      let actual: string | null = null
      try {
        const r = await byName
          .get('browser_assert')!
          .execute({ kind: ra.kind, locator: ra.resolvedLocator ?? undefined, expected: ra.expected }, ctx)
        const parsed = JSON.parse(r.data) as { pass: boolean; actual?: string }
        pass = parsed.pass
        actual = parsed.actual ?? null
      } catch (e) {
        actual = String((e as Error).message)
      }
      insertAssert.run(runCaseId, pass ? 1 : 0, actual, pass ? null : '断言失败')
      onProgress?.({ type: 'assert', text: `断言 ${ra.kind} ${pass ? 'PASS' : 'FAIL'} actual="${actual ?? ''}"` })
      if (!pass) {
        verdict.status = 'failed'
        verdict.reason = `断言失败: ${ra.kind} expected="${ra.expected}" actual="${actual ?? ''}"`
      }
    }
  }

  // ---- 截图(证据,不参与判定)----
  try {
    const shot = await byName.get('browser_screenshot')!.execute({ fullPage: true }, ctx)
    verdict.screenshotPath = (JSON.parse(shot.data) as { path: string }).path
  } catch {
    // 截图失败不影响判定
  }

  return verdict
}
