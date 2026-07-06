/** 回归验证脚本:插入一条指向本地 fixture 的结构化用例,跑 DeterministicCaseRunner。 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { sqlite } from '../db/client.js'
import { runMigrate } from '../db/migrate.js'
import { browserPool } from '../browser/pool.js'
import { runRegression } from '../runner/regression.js'

const FIXTURE_KEY = 'fixture|login|regression|demo'

async function main(): Promise<void> {
  runMigrate()
  const fixtureUrl = pathToFileURL(join(process.cwd(), 'src/fixtures/login.html')).href
  const steps = [
    { action: 'navigate', targetDescription: '登录页', value: fixtureUrl, locator: null, rawText: '', confidence: 0.9 },
    { action: 'type', targetDescription: '用户名', locator: { type: 'css', value: 'input[name="username"]' }, value: 'system', rawText: '', confidence: 0.9 },
    { action: 'type', targetDescription: '密码', locator: { type: 'css', value: 'input[name="password"]' }, value: 'Test1234', rawText: '', confidence: 0.9 },
    { action: 'click', targetDescription: '登录按钮', locator: { type: 'role', value: 'button', name: '登录' }, rawText: '', confidence: 0.9 },
  ]
  const assertions = [
    { kind: 'visible', target: '成功提示', locator: { type: 'css', value: '#success-msg' }, expected: 'true', rawText: '', confidence: 0.8 },
  ]
  const now = new Date().toISOString()
  sqlite.prepare(
    `INSERT OR REPLACE INTO test_case (global_key, title, module_path, priority, test_method, structured_steps, structured_assertions, interpret_status, interpret_version, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(FIXTURE_KEY, 'fixture登录回归', '登录/登录/主流程', 'high', '场景法', JSON.stringify(steps), JSON.stringify(assertions), 'done', 1, now, now)
  const row = sqlite.prepare('SELECT id FROM test_case WHERE global_key=?').get(FIXTURE_KEY) as { id: number }
  console.log('fixture 用例 id:', row.id)

  try {
    const r = await runRegression('regression-verify', { caseIds: [row.id] }, (m) => console.log('  ', m.type, m.text))
    console.log('回归结果:', r)
  } finally {
    await browserPool.close()
  }
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
