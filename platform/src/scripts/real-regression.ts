/**
 * 确定性重放(零 AI):对模块的已录制用例(record_status='recorded')用 DeterministicCaseRunner 重放。
 *
 * 用法:npm run real-regression <modulePath> [N]   例:npm run real-regression 数据看板 3
 * 前置:先 npm run record <modulePath> N 录制;Edge CDP 已登录。
 */
import { browserPool } from '../browser/pool.js'
import { runMigrate } from '../db/migrate.js'
import { runRegression } from '../runner/regression.js'
import { sqlite } from '../db/client.js'

const modulePath = process.argv[2]
const N = parseInt(process.argv[3] ?? '5', 10)

async function main(): Promise<void> {
  if (!modulePath) {
    console.error('用法: npm run real-regression <modulePath> [N]')
    console.error('例: npm run real-regression 数据看板 3')
    process.exit(1)
  }
  runMigrate()
  console.log(`[real-regression] 模块:${modulePath}  N=${N}  CDP:${process.env.BROWSER_CDP_URL ?? '(未设,开新浏览器)'}`)
  console.log('模式:确定性重放(零 AI,可重复)')
  const cnt = sqlite
    .prepare("SELECT COUNT(*) n FROM test_case WHERE record_status='recorded' AND module_path LIKE ?")
    .get(modulePath + '%') as { n: number }
  console.log(`  已录制用例数:${cnt.n}`)
  if (cnt.n === 0) {
    console.log(`\n无已录制用例。请先:npm run record ${modulePath} ${N}`)
    return
  }
  try {
    const r = await runRegression('real-regression', { limit: N, modulePath }, (m) =>
      console.log('  ', m.type, m.text),
    )
    console.log('\n[real-regression] 结果:', r)
  } finally {
    await browserPool.close()
  }
}

void main().catch((e) => {
  console.error('[real-regression] 失败:', e)
  process.exit(1)
})
