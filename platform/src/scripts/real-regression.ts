/**
 * 确定性重放(零 AI):对已录制用例(record_status='recorded')用 DeterministicCaseRunner 重放。
 *
 * 用法:
 *   npm run real-regression -- <modulePath> [N]          按模块重放
 *   npm run real-regression -- --cases=18,19,20          按用例 ID 重放
 * 前置:先 npm run record 录制;Edge CDP 已登录。
 */
import { browserPool } from '../browser/pool.js'
import { runMigrate } from '../db/migrate.js'
import { runRegression } from '../runner/regression.js'
import { sqlite } from '../db/client.js'

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

async function main(): Promise<void> {
  if (!caseIds && !modulePath) {
    console.error('用法:')
    console.error('  npm run real-regression -- <modulePath> [N]   按模块')
    console.error('  npm run real-regression -- --cases=18,19,20  按用例 ID')
    process.exit(1)
  }
  runMigrate()
  console.log(
    `[real-regression] ${caseIds ? '用例 ID:' + caseIds.join(',') : '模块:' + modulePath + ' N=' + N}  CDP:${process.env.BROWSER_CDP_URL ?? '(未设,开新浏览器)'}`,
  )
  console.log('模式:确定性重放(零 AI,可重复)')

  try {
    if (caseIds) {
      const cnt = sqlite
        .prepare(`SELECT COUNT(*) n FROM test_case WHERE record_status='recorded' AND id IN (${caseIds.map(() => '?').join(',')})`)
        .get(...caseIds) as { n: number }
      console.log(`  已录制:${cnt.n}/${caseIds.length}`)
      if (cnt.n === 0) {
        console.log('无已录制用例,请先: npm run record -- --cases=' + caseIds.join(','))
        return
      }
      const r = await runRegression('real-regression', { caseIds }, (m) => console.log('  ', m.type, m.text))
      console.log('\n[real-regression] 结果:', r)
    } else {
      const cnt = sqlite
        .prepare("SELECT COUNT(*) n FROM test_case WHERE record_status='recorded' AND module_path LIKE ?")
        .get(modulePath + '%') as { n: number }
      console.log(`  已录制用例数:${cnt.n}`)
      if (cnt.n === 0) {
        console.log(`\n无已录制用例。请先: npm run record -- ${modulePath} ${N}`)
        return
      }
      const r = await runRegression('real-regression', { limit: N, modulePath }, (m) =>
        console.log('  ', m.type, m.text),
      )
      console.log('\n[real-regression] 结果:', r)
    }
  } finally {
    await browserPool.close()
  }
}

void main().catch((e) => {
  console.error('[real-regression] 失败:', e)
  process.exit(1)
})
