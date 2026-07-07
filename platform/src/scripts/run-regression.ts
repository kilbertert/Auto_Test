/** fixture 确定性重放验证:插入一条已知 locator 的结构化用例,跑零 AI 重放。 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { sqlite } from '../db/client.js'
import { runMigrate } from '../db/migrate.js'
import { browserPool } from '../browser/pool.js'
import { runRegression } from '../runner/regression.js'

const FIXTURE_KEY = 'fixture|login|replay|demo'

async function main(): Promise<void> {
  runMigrate()
  const fixtureUrl = pathToFileURL(join(process.cwd(), 'src/fixtures/login.html')).href
  // 已解析的步骤(locator 硬编码,模拟录制产物)
  const resolvedSteps = [
    { action: 'navigate_url', resolvedLocator: null, value: fixtureUrl, targetDescription: '登录页', rawText: '' },
    { action: 'type', resolvedLocator: { type: 'css', value: 'input[name="username"]' }, value: 'system', targetDescription: '用户名', rawText: '' },
    { action: 'type', resolvedLocator: { type: 'css', value: 'input[name="password"]' }, value: 'Test1234', targetDescription: '密码', rawText: '' },
    { action: 'click', resolvedLocator: { type: 'role', value: 'button', name: '登录' }, value: undefined, targetDescription: '登录按钮', rawText: '' },
  ]
  const resolvedAssertions = [
    { kind: 'visible', resolvedLocator: { type: 'css', value: '#success-msg' }, expected: 'true', target: '成功提示', rawText: '' },
  ]
  const now = new Date().toISOString()
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO test_case (global_key, title, module_path, priority, test_method, resolved_steps, resolved_assertions, record_status, interpret_status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      FIXTURE_KEY,
      'fixture登录重放',
      '登录/登录/主流程',
      'high',
      '场景法',
      JSON.stringify(resolvedSteps),
      JSON.stringify(resolvedAssertions),
      'recorded',
      'done',
      now,
      now,
    )
  const row = sqlite.prepare('SELECT id FROM test_case WHERE global_key=?').get(FIXTURE_KEY) as { id: number }
  console.log('fixture 用例 id:', row.id)

  try {
    const r = await runRegression('fixture-replay', { caseIds: [row.id] }, (m) => console.log('  ', m.type, m.text))
    console.log('重放结果:', r)
  } finally {
    await browserPool.close()
  }
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
