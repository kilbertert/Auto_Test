/**
 * 录制(AI 一次性):interpret + recordCase 预解析 locator,写 resolved_steps。
 *
 * 用法:
 *   npm run record -- <modulePath> [N] [--force]        按模块录制
 *   npm run record -- --cases=18,19,20 [--force]        按用例 ID 录制
 * 前置:Edge 已 --remote-debugging-port=9222 登录后台;.env 设 BROWSER_CDP_URL=http://127.0.0.1:9222
 */
import { browserPool } from '../browser/pool.js'
import { config } from '../config.js'
import { runMigrate } from '../db/migrate.js'
import { interpretBatch, interpretCase, saveInterpretation } from '../interpreter/interpret.js'
import { recordCase } from '../runner/record.js'
import { sqlite } from '../db/client.js'
import type { StructuredStep, StructuredAssertion } from '../interpreter/schemas.js'

interface Row {
  id: number
  title: string | null
  module_path: string | null
  structured_steps: string | null
  structured_assertions: string | null
  raw_steps: string | null
  raw_expected: string | null
}

// 解析参数:--cases=18,19,20 或 <modulePath> [N];--force 重新录制
const casesArg = process.argv.find((a) => a.startsWith('--cases='))
const caseIds = casesArg
  ? casesArg
      .slice('--cases='.length)
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter(Boolean)
  : null
const modulePath = !caseIds && process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined
const N = parseInt(process.argv[3] ?? '5', 10)
const force = process.argv.includes('--force')

async function main(): Promise<void> {
  if (!caseIds && !modulePath) {
    console.error('用法:')
    console.error('  npm run record -- <modulePath> [N] [--force]   按模块')
    console.error('  npm run record -- --cases=18,19,20 [--force]  按用例 ID')
    console.error('例: npm run record -- 基础功能 5')
    console.error('    npm run record -- --cases=18,19,20,22')
    process.exit(1)
  }
  if (!config.hasLlm) {
    console.error('需要 OMA_API_KEY(录制用 AI 预解析 locator)')
    process.exit(1)
  }
  runMigrate()
  console.log(
    `[record] ${caseIds ? '用例 ID:' + caseIds.join(',') : '模块:' + modulePath}  N=${N}  CDP:${process.env.BROWSER_CDP_URL ?? '(未设,开新浏览器)'}${force ? '  [--force]' : ''}`,
  )

  let rows: Row[]
  if (caseIds) {
    // --cases 模式:选指定 ID,解释 pending 的
    rows = sqlite
      .prepare(`SELECT id, title, module_path, structured_steps, structured_assertions, raw_steps, raw_expected FROM test_case WHERE id IN (${caseIds.map(() => '?').join(',')}) ORDER BY id`)
      .all(...caseIds) as Row[]
    console.log(`[1] 解释 pending 用例(${rows.length} 条)...`)
    for (const r of rows) {
      if (!r.structured_steps) {
        const interp = await interpretCase(r.raw_steps ?? '', r.raw_expected ?? '', {
          modulePath: r.module_path ?? undefined,
          title: r.title ?? undefined,
        })
        saveInterpretation(r.id, interp)
        r.structured_steps = JSON.stringify(interp.steps)
        r.structured_assertions = JSON.stringify(interp.assertions)
        console.log(`  [interpret] #${r.id} ${r.title} OK`)
      }
    }
  } else {
    // 模块模式:interpret N pending + 选待录制
    const cnt = sqlite.prepare('SELECT COUNT(*) n FROM test_case WHERE module_path LIKE ?').get(modulePath + '%') as { n: number }
    console.log(`  该模块用例总数:${cnt.n}`)
    console.log('[1] 结构化解释(interpret)...')
    const interp = await interpretBatch(
      { limit: N, wherePending: true, modulePath },
      (d, t, c) => console.log(`  [interpret ${d}/${t}] ${c.title} ${c.ok ? 'OK' : 'FAIL'}`),
    )
    console.log('  interpret:', interp)
    const where = ['structured_steps IS NOT NULL', "interpret_status='done'"]
    if (!force) where.push("(record_status IS NULL OR record_status != 'recorded')")
    rows = sqlite
      .prepare(`SELECT id, title, module_path, structured_steps, structured_assertions, raw_steps, raw_expected FROM test_case WHERE ${where.join(' AND ')} AND module_path LIKE ? ORDER BY id LIMIT ?`)
      .all(modulePath + '%', N) as Row[]
  }

  console.log(`[2] 待录制:${rows.length}${force ? '(含已录制,--force)' : ''}`)
  if (rows.length === 0) {
    console.log('[record] 无待录制用例,结束。')
    return
  }

  // AI 录制(每步 AI 预解析 locator + 执行验证)
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
      sqlite.prepare("UPDATE test_case SET record_status='failed', updated_at=? WHERE id=?").run(new Date().toISOString(), r.id)
      failed++
    } finally {
      browserPool.release(session)
    }
  }

  console.log(`\n[record] 完成: recorded=${recorded} failed=${failed}`)
  console.log('下一步:npm run real-regression -- ' + (caseIds ? '--cases=' + caseIds.join(',') : modulePath + ' ' + N) + ' (零 AI 确定性重放)')
  await browserPool.close()
}

void main().catch((e) => {
  console.error('[record] 失败:', e)
  process.exit(1)
})
