/**
 * 真实后台自适应登录(单 agent,无 reporter,避免幻觉):executor 探测真实表单、
 * 填凭据、点登录、断言、截图。捕获 executor 真实输出作为判定。
 */
import { OpenMultiAgent } from '@open-multi-agent/core'
import type { SupportedProvider, OrchestratorEvent, TraceEvent } from '@open-multi-agent/core'
import { browserPool } from '../browser/pool.js'
import { makeBrowserTools } from '../browser/tools.js'
import { makeExecutor } from '../agents/roster.js'
import { config } from '../config.js'
import { runMigrate } from '../db/migrate.js'
import { existsSync, readdirSync } from 'node:fs'

const LOGIN_URL = process.env.TEST_LOGIN_URL ?? config.TARGET_LOGIN_URL
const USER = process.env.TEST_USERNAME ?? 'system'
const PASS = process.env.TEST_PASSWORD ?? 'Test1234'

async function main(): Promise<void> {
  if (!config.hasLlm) {
    console.error('需要 OMA_API_KEY')
    process.exit(1)
  }
  console.log(`[real-login] 目标:${LOGIN_URL}  账号:${USER}`)
  runMigrate()
  await browserPool.init()
  const session = await browserPool.acquire('real-login')
  const tools = makeBrowserTools(session)
  const executor = makeExecutor(tools)

  const oma = new OpenMultiAgent({
    defaultModel: config.OMA_MODEL,
    defaultProvider: config.OMA_PROVIDER as SupportedProvider,
    defaultBaseURL: config.OMA_BASE_URL,
    defaultApiKey: config.OMA_API_KEY,
    maxConcurrency: 1,
    defaultToolPreset: 'readonly',
    onProgress: (e: OrchestratorEvent) =>
      console.log('  [progress]', e.type, e.agent ?? '', String(e.task ?? '').slice(0, 8)),
    onTrace: (e: TraceEvent) => {
      if (e.type === 'tool_call') console.log('    [tool]', e.tool, e.isError ? '(ERR)' : '')
    },
  })

  const prompt = [
    `导航到真实后台登录页:${LOGIN_URL}`,
    '1. browser_snapshot 查看登录表单结构。',
    '2. browser_locate 定位账号输入框(中文"账号"或"用户名"),browser_type 填:' + USER,
    '3. browser_locate 定位密码输入框,browser_type 填:' + PASS,
    '4. 若有验证码输入框:browser_snapshot 看验证码类型;图片验证码无法识别则 browser_type 填 "1234" 占位,并在输出说明"验证码可能阻断登录"。',
    '5. browser_locate 定位登录按钮,browser_click 点击。',
    '6. 等待页面响应后:browser_assert 校验——若 URL 跳转或出现后台菜单/欢迎文案=passed;若出现错误提示(验证码错误/账号或密码错误)=failed,用 text 断言捕获。',
    '7. 必须调用 browser_screenshot 截图(无论成败)。',
    '最终输出明确给出:verdict(passed/failed)、是否被验证码阻断、错误信息、截图路径。',
  ].join('\n')

  try {
    const r = await oma.runAgent(executor, prompt)
    console.log('\n[real-login] executor success=' + r.success)
    console.log('[real-login] executor 输出:\n' + r.output)
    const dir = 'screenshots/real-login'
    if (existsSync(dir)) {
      console.log('[real-login] 截图:', readdirSync(dir))
    } else {
      console.log('[real-login] (无截图目录)')
    }
  } finally {
    browserPool.release(session)
    await browserPool.close()
  }
}

void main().catch((e) => {
  console.error('[real-login] 失败:', e)
  process.exit(1)
})
