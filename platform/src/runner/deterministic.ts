/**
 * 确定性用例执行器:按 structured_steps 顺序直接调用浏览器工具(无 LLM 在环),
 * 用 browser_assert 校验断言。locator 为空或 alias 时用 browser_locate(AI)兜底。
 * 失败截图。结果写入 run_step / assertion_result。
 */
import { makeBrowserTools, smokeContext } from '../browser/tools.js'
import type { BrowserSession } from '../browser/pool.js'
import type { ToolDefinition } from '@open-multi-agent/core'
import type { StructuredStep, StructuredAssertion } from '../interpreter/schemas.js'
import type { Locator } from '../browser/locator.js'
import { sqlite } from '../db/client.js'

type AnyTool = ToolDefinition<any>

export interface CaseVerdict {
  status: 'passed' | 'failed' | 'skipped'
  reason?: string
  screenshotPath?: string
}

export interface DeterministicCase {
  id: number
  title: string
  modulePath?: string
  structuredSteps: StructuredStep[]
  structuredAssertions: StructuredAssertion[]
}

type ProgressFn = (msg: { type: string; text: string }) => void

/** 解析定位器:无 locator 或 alias → browser_locate(AI)兜底。 */
async function resolveStepLocator(
  byName: Map<string, AnyTool>,
  ctx: ReturnType<typeof smokeContext>,
  step: StructuredStep,
): Promise<Locator | null> {
  if (step.locator && step.locator.type !== 'alias') return step.locator
  const desc = step.targetDescription
  if (!desc) return step.locator
  const r = await byName.get('browser_locate')!.execute({ description: desc }, ctx)
  if (r.isError) throw new Error('locate 失败: ' + r.data)
  return (JSON.parse(r.data) as { locator: Locator }).locator
}

/** 确定性执行一条结构化用例。runCaseId 用于落 run_step/assertion_result。 */
export async function runDeterministic(
  tc: DeterministicCase,
  session: BrowserSession,
  runCaseId: number,
  onProgress?: ProgressFn,
): Promise<CaseVerdict> {
  const tools = makeBrowserTools(session)
  const byName = new Map<string, AnyTool>(tools.map(t => [t.name, t]))
  const ctx = smokeContext()
  const verdict: CaseVerdict = { status: 'passed' }
  const insertStep = sqlite.prepare(
    'INSERT INTO run_step (run_case_id, step_id, status, actual, error, duration_ms) VALUES (?,?,?,?,?,?)',
  )
  const insertAssert = sqlite.prepare(
    'INSERT INTO assertion_result (run_case_id, assertion_id, pass, actual, error) VALUES (?,NULL,?,?,?)',
  )

  // ---- 步骤 ----
  for (let i = 0; i < tc.structuredSteps.length; i++) {
    const step = tc.structuredSteps[i]
    const t0 = Date.now()
    let ok = true
    let error: string | null = null
    try {
      const loc = await resolveStepLocator(byName, ctx, step)
      switch (step.action) {
        case 'navigate':
          await byName.get('browser_navigate')!.execute({ url: step.value ?? '' }, ctx)
          break
        case 'click':
          if (!loc) throw new Error('click 缺 locator')
          await byName.get('browser_click')!.execute({ locator: loc }, ctx)
          break
        case 'type':
          if (!loc) throw new Error('type 缺 locator')
          await byName.get('browser_type')!.execute({ locator: loc, text: step.value ?? '' }, ctx)
          break
        case 'clear':
          if (!loc) throw new Error('clear 缺 locator')
          await byName.get('browser_type')!.execute({ locator: loc, text: '' }, ctx)
          break
        case 'check':
          if (!loc) throw new Error('check 缺 locator')
          await byName.get('browser_click')!.execute({ locator: loc }, ctx)
          break
        case 'select':
          if (!loc) throw new Error('select 缺 locator')
          await byName.get('browser_select')!.execute({ locator: loc, value: step.value ?? '' }, ctx)
          break
        case 'wait':
          break // P4 暂作 no-op
        default:
          onProgress?.({ type: 'step', text: `步骤 ${i + 1} 跳过未知 action: ${step.action}` })
      }
    } catch (e) {
      ok = false
      error = String((e as Error).message)
    }
    const durationMs = Date.now() - t0
    insertStep.run(runCaseId, i + 1, ok ? 'passed' : 'failed', '', error, durationMs)
    onProgress?.({
      type: 'step',
      text: `步骤 ${i + 1} ${step.action} ${ok ? 'OK' : 'FAIL' + (error ? ' ' + error : '')}`,
    })
    if (!ok) {
      verdict.status = 'failed'
      verdict.reason = `步骤 ${i + 1}(${step.action})失败: ${error}`
      break
    }
  }

  // ---- 断言(仅步骤全过) ----
  if (verdict.status === 'passed') {
    for (const a of tc.structuredAssertions) {
      let pass = false
      let actual: string | null = null
      try {
        let loc = a.locator
        if ((!loc || loc.type === 'alias') && a.target) {
          const r = await byName.get('browser_locate')!.execute({ description: a.target }, ctx)
          if (!r.isError) loc = (JSON.parse(r.data) as { locator: Locator }).locator
        }
        const r = await byName
          .get('browser_assert')!
          .execute({ kind: a.kind, locator: loc ?? undefined, expected: a.expected }, ctx)
        const parsed = JSON.parse(r.data) as { pass: boolean; actual?: string }
        pass = parsed.pass
        actual = parsed.actual ?? null
      } catch (e) {
        actual = String((e as Error).message)
      }
      insertAssert.run(runCaseId, pass ? 1 : 0, actual, pass ? null : '断言失败')
      onProgress?.({ type: 'assert', text: `断言 ${a.kind} ${pass ? 'PASS' : 'FAIL'}` })
      if (!pass) {
        verdict.status = 'failed'
        verdict.reason = `断言失败: ${a.kind} expected="${a.expected}" actual="${actual ?? ''}"`
      }
    }
  }

  // ---- 截图 ----
  try {
    const shot = await byName.get('browser_screenshot')!.execute({ fullPage: true }, ctx)
    verdict.screenshotPath = (JSON.parse(shot.data) as { path: string }).path
  } catch {
    // 截图失败不影响判定
  }

  return verdict
}
