/**
 * 确定性回归重放:从 DB 选 record_status='recorded' 的用例,读 resolved_steps,
 * 用 DeterministicCaseRunner 零 AI 重放。落 run/run_case/run_step/assertion_result。
 */
import { sqlite } from '../db/client.js'
import { browserPool } from '../browser/pool.js'
import { runDeterministic, type ReplayCase } from './deterministic.js'
import type { ResolvedStep, ResolvedAssertion } from '../interpreter/schemas.js'

export interface RegressionOptions {
  caseIds?: number[]
  limit?: number
  modulePath?: string
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
  resolved_steps: string | null
  resolved_assertions: string | null
}

type ProgressFn = (msg: { type: string; text: string }) => void

/** 运行一次确定性回归重放(零 AI)。runId 为外部逻辑 id(WS 通道)。 */
export async function runRegression(
  runId: string,
  opts: RegressionOptions = {},
  onProgress?: ProgressFn,
): Promise<RegressionSummary> {
  const now = new Date().toISOString()
  const runIns = sqlite
    .prepare('INSERT INTO run (name, status, config, started_at) VALUES (?,?,?,?)')
    .run('replay-' + runId.slice(0, 8), 'running', JSON.stringify(opts), now)
  const runDbId = Number(runIns.lastInsertRowid)

  let cases: CaseRow[]
  if (opts.caseIds && opts.caseIds.length) {
    const ph = opts.caseIds.map(() => '?').join(',')
    cases = sqlite
      .prepare(`SELECT id, title, module_path, resolved_steps, resolved_assertions FROM test_case WHERE id IN (${ph})`)
      .all(...opts.caseIds) as CaseRow[]
  } else {
    const lim = opts.limit ?? 20
    const where = ["record_status = 'recorded'", 'resolved_steps IS NOT NULL']
    const params: Array<string | number> = []
    if (opts.modulePath) {
      where.push('module_path LIKE ?')
      params.push(opts.modulePath + '%')
    }
    cases = sqlite
      .prepare(
        `SELECT id, title, module_path, resolved_steps, resolved_assertions FROM test_case WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`,
      )
      .all(...params, lim) as CaseRow[]
  }

  onProgress?.({ type: 'run_start', text: `重放 ${cases.length} 条已录制用例(零 AI)` })
  let passed = 0
  let failed = 0
  let skipped = 0

  const insertRunCase = sqlite.prepare(
    'INSERT INTO run_case (run_id, case_id, status, started_at, agent_used) VALUES (?,?,?,?,?)',
  )
  const updateRunCase = sqlite.prepare('UPDATE run_case SET status=?, ended_at=?, error=? WHERE id=?')

  for (const c of cases) {
    if (!c.resolved_steps) {
      skipped++
      onProgress?.({ type: 'skip', text: `跳过 #${c.id} (未录制)` })
      continue
    }
    let steps: ResolvedStep[]
    let asserts: ResolvedAssertion[]
    try {
      steps = JSON.parse(c.resolved_steps) as ResolvedStep[]
      asserts = c.resolved_assertions ? (JSON.parse(c.resolved_assertions) as ResolvedAssertion[]) : []
    } catch {
      skipped++
      onProgress?.({ type: 'skip', text: `跳过 #${c.id} resolved 数据损坏` })
      continue
    }
    const tc: ReplayCase = { id: c.id, title: c.title ?? '', resolvedSteps: steps, resolvedAssertions: asserts }

    const rcIns = insertRunCase.run(runDbId, c.id, 'running', new Date().toISOString(), 'deterministic-replay')
    const runCaseId = Number(rcIns.lastInsertRowid)

    onProgress?.({ type: 'case_start', text: `重放 #${c.id} ${tc.title}` })
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
