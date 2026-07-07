/**
 * 录制(AI 一次性):对模块 interpret N 条 + recordCase 预解析 locator,写 resolved_steps。
 * 之后 npm run real-regression 即可零 AI 确定性重放。
 *
 * 用法:npm run record <modulePath> [N]   例:npm run record 数据看板 3
 * 前置:Edge 已 --remote-debugging-port=9222 启动并登录后台;.env 设 BROWSER_CDP_URL=http://127.0.0.1:9222
 */
import { browserPool } from '../browser/pool.js'
import { config } from '../config.js'
import { runMigrate } from '../db/migrate.js'
import { interpretBatch } from '../interpreter/interpret.js'
import { recordCase } from '../runner/record.js'
import { sqlite } from '../db/client.js'
import type { StructuredStep, StructuredAssertion } from '../interpreter/schemas.js'

const modulePath = process.argv[2]
const N = parseInt(process.argv[3] ?? '5', 10)

interface Row {
  id: number
  title: string | null
  module_path: string | null
  structured_steps: string | null
  structured_assertions: string | null
}

async function main(): Promise<void> {
  if (!modulePath) {
    console.error('用法: npm run record <modulePath> [N]')
    console.error('例: npm run record 数据看板 3')
    process.exit(1)
  }
  if (!config.hasLlm) {
    console.error('需要 OMA_API_KEY(录制用 AI 预解析 locator)')
    process.exit(1)
  }
  runMigrate()
  console.log(`[record] 模块:${modulePath}  N=${N}  CDP:${process.env.BROWSER_CDP_URL ?? '(未设,开新浏览器)'}`)
  const cnt = sqlite
    .prepare('SELECT COUNT(*) n FROM test_case WHERE module_path LIKE ?')
    .get(modulePath + '%') as { n: number }
  console.log(`  该模块用例总数:${cnt.n}`)

  // 1. 结构化解释 N 条 pending(该模块)
  console.log('[1] 结构化解释(interpret)...')
  const interp = await interpretBatch(
    { limit: N, wherePending: true, modulePath },
    (d, t, c) => console.log(`  [interpret ${d}/${t}] ${c.title} ${c.ok ? 'OK' : 'FAIL'}`),
  )
  console.log('  interpret:', interp)

  // 2. 取未录制的 interpreted 用例
  const rows = sqlite
    .prepare(
      `SELECT id, title, module_path, structured_steps, structured_assertions
       FROM test_case WHERE structured_steps IS NOT NULL AND interpret_status='done'
       AND (record_status IS NULL OR record_status != 'recorded') AND module_path LIKE ?
       ORDER BY id LIMIT ?`,
    )
    .all(modulePath + '%', N) as Row[]
  console.log(`[2] 待录制:${rows.length}`)

  if (rows.length === 0) {
    console.log('[record] 无待录制用例(可能已全部录制),结束。')
    return
  }

  // 3. AI 录制(每步 AI 预解析 locator + 执行验证)
  await browserPool.init()
  let recorded = 0
  let failed = 0
  for (const r of rows) {
    const steps = JSON.parse(r.structured_steps!) as StructuredStep[]
    const asserts = r.structured_assertions ? (JSON.parse(r.structured_assertions) as StructuredAssertion[]) : []
    console.log(`\n[3] 录制 #${r.id} 「${r.title}」  (${r.module_path})`)
    const session = await browserPool.acquire('record-' + r.id)
    try {
      const res = await recordCase(
        { id: r.id, title: r.title ?? '', modulePath: r.module_path ?? undefined, structuredSteps: steps, structuredAssertions: asserts },
        session,
        (m) => console.log('  ', m.type, m.text),
      )
      console.log(`  -> ${res.status} (${res.stepsResolved} 步 / ${res.assertionsResolved} 断言)`)
      if (res.status === 'recorded') recorded++
      else failed++
    } catch (e) {
      console.log(`  -> 异常:${String((e as Error).message).slice(0, 200)}`)
      sqlite
        .prepare("UPDATE test_case SET record_status='failed', updated_at=? WHERE id=?")
        .run(new Date().toISOString(), r.id)
      failed++
    } finally {
      browserPool.release(session)
    }
  }

  console.log(`\n[record] 完成: recorded=${recorded} failed=${failed}`)
  console.log('下一步:npm run real-regression ' + modulePath + ' ' + N + '(零 AI 确定性重放)')
  await browserPool.close()
}

void main().catch((e) => {
  console.error('[record] 失败:', e)
  process.exit(1)
})
