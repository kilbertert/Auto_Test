/**
 * 真实后台回归(基于历史用例):对一个模块的用例先 interpret(结构化),
 * 再用 executor agent(自适应,LLM 在环)via CDP 在已登录后台逐条执行。
 *
 * 用法:npm run real-regression <modulePath> [N]
 *   例:npm run real-regression 营销活动 5
 *
 * 前置:Edge 已 --remote-debugging-port=9222 启动并登录后台;.env 设 BROWSER_CDP_URL=http://127.0.0.1:9222
 * 安全:agent 被指示跳过创建/删除/编辑等写操作;仍建议选只读/查看类模块。
 */
import { OpenMultiAgent } from '@open-multi-agent/core'
import type { SupportedProvider, TraceEvent } from '@open-multi-agent/core'
import { browserPool } from '../browser/pool.js'
import { makeBrowserTools } from '../browser/tools.js'
import { makeExecutor } from '../agents/roster.js'
import { config } from '../config.js'
import { runMigrate } from '../db/migrate.js'
import { interpretBatch } from '../interpreter/interpret.js'
import { sqlite } from '../db/client.js'
import type { StructuredStep, StructuredAssertion } from '../interpreter/schemas.js'
import { existsSync, readdirSync } from 'node:fs'

const modulePath = process.argv[2]
const N = parseInt(process.argv[3] ?? '5', 10)
const LOGIN_URL = process.env.TEST_LOGIN_URL ?? config.TARGET_LOGIN_URL

interface CaseRow {
  id: number
  title: string | null
  module_path: string | null
  structured_steps: string | null
  structured_assertions: string | null
}

async function main(): Promise<void> {
  if (!modulePath) {
    console.error('用法: npm run real-regression <modulePath> [N]')
    console.error('例: npm run real-regression 营销活动 5')
    console.error('modulePath 是模块名前缀,匹配 test_case.module_path(如 "营销活动" / "会员" / "首页")')
    process.exit(1)
  }
  if (!config.hasLlm) {
    console.error('需要 OMA_API_KEY')
    process.exit(1)
  }
  runMigrate()
  console.log(
    `[real-regression] 模块:${modulePath}  N=${N}  CDP:${process.env.BROWSER_CDP_URL ?? '(未设,将开新浏览器)'}`,
  )
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
  console.log('  interpret 结果:', interp)

  // 2. 取该模块已结构化用例
  const cases = sqlite
    .prepare(
      `SELECT id, title, module_path, structured_steps, structured_assertions
       FROM test_case WHERE structured_steps IS NOT NULL AND interpret_status='done' AND module_path LIKE ?
       ORDER BY id LIMIT ?`,
    )
    .all(modulePath + '%', N) as CaseRow[]
  console.log(`[2] 待执行 interpreted 用例:${cases.length}`)

  if (cases.length === 0) {
    console.log('[real-regression] 无可执行用例,结束。')
    return
  }

  // 3. executor agent 逐条执行 via CDP
  const oma = new OpenMultiAgent({
    defaultModel: config.OMA_MODEL,
    defaultProvider: config.OMA_PROVIDER as SupportedProvider,
    defaultBaseURL: config.OMA_BASE_URL,
    defaultApiKey: config.OMA_API_KEY,
    maxConcurrency: 1,
    defaultToolPreset: 'readonly',
    onTrace: (e: TraceEvent) => {
      if (e.type === 'tool_call') console.log('    [tool]', e.tool, e.isError ? '(ERR)' : '')
    },
  })

  let completed = 0
  let errored = 0
  for (const c of cases) {
    const steps = JSON.parse(c.structured_steps!) as StructuredStep[]
    const asserts = c.structured_assertions ? (JSON.parse(c.structured_assertions) as StructuredAssertion[]) : []
    console.log(`\n[3] 执行 #${c.id} 「${c.title}」  (${c.module_path})`)
    const prompt = [
      `你已在后台首页(${LOGIN_URL},CDP 已登录)。执行以下测试用例,逐步用 browser_* 工具完成。`,
      `用例标题:${c.title}`,
      `模块:${c.module_path}`,
      `\n## 结构化步骤\n${JSON.stringify(steps, null, 2)}`,
      `\n## 断言\n${JSON.stringify(asserts, null, 2)}`,
      '\n## 要求',
      '- 你已在后台首页。**不要用 browser_navigate 到页面名(非 URL)**;"进入/打开 X 页面"=在左侧/顶部菜单中点击对应项(先 browser_snapshot 看菜单结构,再 browser_locate 按菜单项文本定位,browser_click)。',
      '- 数据看板等模块可能在左侧菜单"数据"或顶部"运营/充电桩"下,用 browser_snapshot 找到并点击进入。',
      '- 每个需要操作元素的步骤:browser_locate(用 targetDescription 中文描述)定位 → click/type/select 等。',
      '- 完成后用 browser_assert 校验断言,browser_screenshot 截图。',
      '- **只读安全**:不要做创建/删除/编辑/保存等写操作;若步骤要求写操作,跳过该步并在输出标记"跳过写操作"。',
      '- **高效**:只在首次进入页面或迷路时 browser_snapshot;已知元素直接 browser_locate+操作,不要每步都 snapshot。某步连续 2 次失败就跳过该步继续,不反复重试。',
      '- **必须输出最终文本**:完成步骤后立即输出 verdict(passed/failed)+ 每步结果 + 截图路径;不要只调用工具不输出文本总结。',
    ].join('\n')

    const session = await browserPool.acquire('real-reg-' + c.id)
    try {
      // CDP 新页面是空白 about:blank,先导航到已登录后台首页(共享 cookie → 已登录),
      // 之后 agent 用菜单点击导航到目标模块,而非 URL。
      await session.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch((e) =>
        console.log('  (首页导航警告:', String((e as Error).message).slice(0, 80), ')'),
      )
      const tools = makeBrowserTools(session)
      const executor = { ...makeExecutor(tools), maxTurns: 40 }
      const r = await oma.runAgent(executor, prompt)
      console.log(`  -> success=${r.success}`)
      console.log(`  -> 输出:${r.output.slice(0, 600)}`)
      const shotDir = `screenshots/real-reg-${c.id}`
      const shots = existsSync(shotDir) ? readdirSync(shotDir) : []
      console.log(`  -> 截图(${shots.length}):${shots.join(', ') || '(无)'}`)
      if (r.success) completed++
      else errored++
    } catch (e) {
      console.log(`  -> 异常:${String((e as Error).message).slice(0, 200)}`)
      errored++
    } finally {
      browserPool.release(session)
    }
  }

  console.log(`\n[real-regression] 完成:共 ${cases.length} 条,completed=${completed} errored=${errored}`)
  console.log('注:completed=agent 跑完未崩;verdict(passed/failed)见各条输出。截图在 screenshots/real-reg-*/')
  await browserPool.close()
}

void main().catch((e) => {
  console.error('[real-regression] 失败:', e)
  process.exit(1)
})
