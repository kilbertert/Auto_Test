/**
 * 后端 DB 查询端点:用例树/列表/详情、导入、解释、运行列表/详情。
 * 供 Vue UI 消费。handlers 接收 ServerResponse,直接写 JSON。
 */
import type { ServerResponse } from 'node:http'
import { sqlite } from '../db/client.js'
import { importXlsx } from '../importer/import.js'
import { interpretBatch } from '../interpreter/interpret.js'
import { broadcast } from '../ws-bus.js'

function json(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/** GET /api/v1/tree → { modules: [{ name, functions: [{ name, subfunctions: [string] }] }] } */
export function getTree(res: ServerResponse): void {
  const rows = sqlite
    .prepare('SELECT id, parent_id, level, name FROM module_tree ORDER BY id')
    .all() as Array<{ id: number; parent_id: number | null; level: string; name: string }>
  const modules = rows
    .filter((r) => r.level === 'module')
    .map((m) => ({
      name: m.name,
      functions: rows
        .filter((r) => r.parent_id === m.id && r.level === 'function')
        .map((f) => ({
          name: f.name,
          subfunctions: rows.filter((r) => r.parent_id === f.id && r.level === 'subfunction').map((s) => s.name),
        })),
    }))
  json(res, 200, { modules })
}

interface CaseListRow {
  id: number
  global_key: string
  module_path: string | null
  title: string | null
  priority: string | null
  author: string | null
  interpret_status: string | null
  confidence: number | null
}

/** GET /api/v1/cases?project=&q=&limit=&offset= */
export function getCases(res: ServerResponse, q: Record<string, string | undefined>): void {
  const limit = Math.min(parseInt(q.limit ?? '50', 10) || 50, 500)
  const offset = parseInt(q.offset ?? '0', 10) || 0
  const where: string[] = ['1=1']
  const params: Array<string | number> = []
  if (q.project) {
    where.push('module_path LIKE ?')
    params.push(q.project + '%')
  }
  if (q.q) {
    where.push('(title LIKE ? OR module_path LIKE ?)')
    params.push('%' + q.q + '%', '%' + q.q + '%')
  }
  const whereSql = where.join(' AND ')
  const total = (sqlite.prepare(`SELECT COUNT(*) n FROM test_case WHERE ${whereSql}`).get(...params) as { n: number }).n
  const cases = sqlite
    .prepare(
      `SELECT id, global_key, module_path, title, priority, author, interpret_status, confidence
       FROM test_case WHERE ${whereSql} ORDER BY id LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as CaseListRow[]
  json(res, 200, {
    total,
    cases: cases.map((c) => ({
      id: c.id,
      globalKey: c.global_key,
      modulePath: c.module_path,
      title: c.title,
      priority: c.priority,
      author: c.author,
      interpretStatus: c.interpret_status,
      confidence: c.confidence,
    })),
  })
}

/** GET /api/v1/cases/:id */
export function getCase(res: ServerResponse, idStr: string): void {
  const id = parseInt(idStr, 10)
  if (!id) return json(res, 400, { error: '无效 id' })
  const c = sqlite
    .prepare(
      'SELECT id, global_key, module_path, title, priority, test_method, precondition, test_data, raw_steps, raw_expected, author, structured_steps, structured_assertions, interpret_status, confidence, ambiguities FROM test_case WHERE id = ?',
    )
    .get(id) as
    | {
        id: number
        global_key: string
        module_path: string | null
        title: string | null
        priority: string | null
        test_method: string | null
        precondition: string | null
        test_data: string | null
        raw_steps: string | null
        raw_expected: string | null
        author: string | null
        structured_steps: string | null
        structured_assertions: string | null
        interpret_status: string | null
        confidence: number | null
        ambiguities: string | null
      }
    | undefined
  if (!c) return json(res, 404, { error: '未找到' })
  json(res, 200, {
    case: {
      id: c.id,
      globalKey: c.global_key,
      modulePath: c.module_path,
      title: c.title,
      priority: c.priority,
      testMethod: c.test_method,
      precondition: c.precondition,
      testData: c.test_data,
      rawSteps: c.raw_steps,
      rawExpected: c.raw_expected,
      author: c.author,
      structuredSteps: c.structured_steps,
      structuredAssertions: c.structured_assertions,
      interpretStatus: c.interpret_status,
      confidence: c.confidence,
      ambiguities: c.ambiguities,
    },
  })
}

/** POST /api/v1/import { filePath? } → { cases, projects, modules } */
export async function importHandler(
  res: ServerResponse,
  body: { filePath?: string },
): Promise<void> {
  const filePath = body.filePath ?? '/home/ranlei/Auto-Test/测试用例.xlsx'
  try {
    const result = await importXlsx(filePath, true)
    json(res, 200, result)
  } catch (e) {
    json(res, 500, { error: String((e as Error).message) })
  }
}

/** POST /api/v1/interpret { limit?, caseIds? } → 异步,返回 runId,进度经 WS 推送 */
export function interpretHandler(
  res: ServerResponse,
  body: { limit?: number; caseIds?: number[] },
): void {
  const runId = 'interpret-' + Math.random().toString(36).slice(2, 10)
  json(res, 200, { runId, accepted: true })
  void interpretBatch(
    { limit: body.limit, wherePending: true },
    (done, total, cur) => broadcast(runId, { type: 'interpret_progress', done, total, cur }),
  )
    .then((r) => broadcast(runId, { type: 'interpret_complete', ...r }))
    .catch((e) => broadcast(runId, { type: 'interpret_complete', error: String(e) }))
}

interface RunListRow {
  id: number
  name: string | null
  status: string | null
  started_at: string | null
  ended_at: string | null
  summary: string | null
}

/** GET /api/v1/runs (近期列表) */
export function getRuns(res: ServerResponse): void {
  const rows = sqlite
    .prepare('SELECT id, name, status, started_at, ended_at, summary FROM run ORDER BY id DESC LIMIT 20')
    .all() as RunListRow[]
  json(res, 200, { runs: rows })
}

/** GET /api/v1/runs/:id → { run, runCases } */
export function getRun(res: ServerResponse, idStr: string): void {
  const id = parseInt(idStr, 10)
  if (!id) return json(res, 400, { error: '无效 id' })
  const run = sqlite.prepare('SELECT id, name, status, started_at, ended_at, summary FROM run WHERE id = ?').get(id) as
    | RunListRow
    | undefined
  if (!run) return json(res, 404, { error: '未找到' })
  const runCases = sqlite
    .prepare('SELECT id, case_id, status, started_at, ended_at, error, agent_used FROM run_case WHERE run_id = ?')
    .all(id) as Array<{
    id: number
    case_id: number
    status: string | null
    started_at: string | null
    ended_at: string | null
    error: string | null
    agent_used: string | null
  }>
  json(res, 200, { run, runCases })
}
