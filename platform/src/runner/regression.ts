/**
 * 回归执行编排:从 DB 选结构化用例,逐条 DeterministicCaseRunner 执行(无 LLM 在环),
 * 落 run / run_case 记录,进度经 onProgress 回推。断言/步骤结果由 deterministic 落表。
 */
import { sqlite } from '../db/client.js'
import { browserPool } from '../browser/pool.js'
import { runDeterministic, type DeterministicCase } from './deterministic.js'
import type { StructuredStep, StructuredAssertion } from '../interpreter/schemas.js'

export interface RegressionOptions {
  caseIds?: number[]
  limit?: number
}

export interface RegressionSummary {
  runId: string
  runDbId: number
  total: number
  passed: number
  failed: number
  skipped: number
}

interface CaseRow {
  id: number
  title: string | null
  module_path: string | null
  structured_steps: string | null
  structured_assertions: string | null
}

type ProgressFn = (msg: { type: string; text: string }) => void

/** 运行一次回归。runId 为外部逻辑 id(WS 通道);run 表用自增 id。 */
export async function runRegression(
  runId: string,
  opts: RegressionOptions = {},
  onProgress?: ProgressFn,
): Promise<RegressionSummary> {
  const now = new Date().toISOString()
  const runIns = sqlite
    .prepare('INSERT INTO run (name, status, config, started_at) VALUES (?,?,?,?)')
    .run('regression-' + runId.slice(0, 8), 'running', JSON.stringify(opts), now)
  const runDbId = Number(runIns.lastInsertRowid)

  let cases: CaseRow[]
  if (opts.caseIds && opts.caseIds.length) {
    const placeholders = opts.caseIds.map(() => '?').join(',')
    cases = sqlite
      .prepare(
        `SELECT id, title, module_path, structured_steps, structured_assertions FROM test_case WHERE id IN (${placeholders})`,
      )
      .all(...opts.caseIds) as CaseRow[]
  } else {
    const lim = opts.limit ?? 20
    cases = sqlite
      .prepare(
        "SELECT id, title, module_path, structured_steps, structured_assertions FROM test_case WHERE structured_steps IS NOT NULL AND interpret_status='done' LIMIT ?",
      )
      .all(lim) as CaseRow[]
  }

  onProgress?.({ type: 'run_start', text: `回归 ${cases.length} 条用例` })
  let passed = 0
  let failed = 0
  let skipped = 0

  const insertRunCase = sqlite.prepare(
    'INSERT INTO run_case (run_id, case_id, status, started_at, agent_used) VALUES (?,?,?,?,?)',
  )
  const updateRunCase = sqlite.prepare(
    'UPDATE run_case SET status=?, ended_at=?, error=? WHERE id=?',
  )

  for (const c of cases) {
    if (!c.structured_steps) {
      skipped++
      onProgress?.({ type: 'skip', text: `跳过 #${c.id} ${c.title ?? ''}(未结构化)` })
      continue
    }
    let steps: StructuredStep[]
    let asserts: StructuredAssertion[]
    try {
      steps = JSON.parse(c.structured_steps) as StructuredStep[]
      asserts = c.structured_assertions ? (JSON.parse(c.structured_assertions) as StructuredAssertion[]) : []
    } catch {
      skipped++
      onProgress?.({ type: 'skip', text: `跳过 #${c.id} 结构化数据损坏` })
      continue
    }
    const tc: DeterministicCase = {
      id: c.id,
      title: c.title ?? '',
      modulePath: c.module_path ?? undefined,
      structuredSteps: steps,
      structuredAssertions: asserts,
    }

    const rcIns = insertRunCase.run(runDbId, c.id, 'running', new Date().toISOString(), 'deterministic')
    const runCaseId = Number(rcIns.lastInsertRowid)

    onProgress?.({ type: 'case_start', text: `执行 #${c.id} ${tc.title}` })
    const session = await browserPool.acquire(runId + '-' + c.id)
    let verdict
    try {
      verdict = await runDeterministic(tc, session, runCaseId, onProgress)
    } finally {
      browserPool.release(session)
    }
    updateRunCase.run(verdict.status, new Date().toISOString(), verdict.reason ?? null, runCaseId)
    if (verdict.status === 'passed') passed++
    else failed++
    onProgress?.({
      type: 'case_complete',
      text: `#${c.id} ${verdict.status.toUpperCase()}${verdict.screenshotPath ? ' 截图:' + verdict.screenshotPath : ''}`,
    })
  }

  const summary: RegressionSummary = { runId, runDbId, total: cases.length, passed, failed, skipped }
  sqlite.prepare('UPDATE run SET status=?, ended_at=?, summary=? WHERE id=?').run(
    'done',
    new Date().toISOString(),
    JSON.stringify(summary),
    runDbId,
  )
  onProgress?.({ type: 'run_complete', text: `完成 passed=${passed} failed=${failed} skipped=${skipped}` })
  return summary
}
