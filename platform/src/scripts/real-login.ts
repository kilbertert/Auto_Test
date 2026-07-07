/**
 * 真实后台验证(单 agent,无 reporter,避免幻觉)。
 * - CDP 模式(BROWSER_CDP_URL 已设置):连接用户已登录浏览器,验证登录态 + 探测后台首页。
 * - launch 模式(默认):全新浏览器,自适应尝试登录(验证码可能阻断)。
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
const CDP = process.env.BROWSER_CDP_URL

async function main(): Promise<void> {
  if (!config.hasLlm) {
    console.error('需要 OMA_API_KEY')
    process.exit(1)
  }
  console.log(`[real-login] 模式:${CDP ? 'CDP(已登录浏览器)' : 'launch(全新浏览器)'}  目标:${LOGIN_URL}`)
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

  const prompt = CDP
    ? [
        `你已通过 CDP 连接到一个用户已手动登录的浏览器。导航到:${LOGIN_URL}`,
        '1. browser_snapshot 查看当前页面。',
        '2. 判断是否已登录:若已是后台首页/工作台(有菜单、导航、用户信息)= 已登录;若仍是登录页(有账号/密码/验证码输入框)= 未登录。',
        '3. 若已登录:简要描述后台首页主结构(主要菜单/模块),browser_screenshot 截图,verdict=passed,说明"已登录,可开始测试"。',
        '4. 若未登录:verdict=failed,明确提示"请在浏览器中先手动登录后台(含验证码),再运行本脚本"。',
      ].join('\n')
    : [
        `导航到真实后台登录页:${LOGIN_URL}`,
        '1. browser_snapshot 查看登录表单结构。',
        '2. browser_locate 定位账号输入框(中文"账号"或"用户名"),browser_type 填:' + USER,
        '3. browser_locate 定位密码输入框,browser_type 填:' + PASS,
        '4. 若有验证码输入框:browser_snapshot 看验证码类型;图片验证码无法识别则 browser_type 填 "1234" 占位,并在输出说明"验证码可能阻断登录"。',
        '5. browser_locate 定位登录按钮,browser_click 点击。',
        '6. 等待页面响应后:browser_assert 校验——URL 跳转或出现后台菜单/欢迎文案=passed;出现错误提示(验证码错误/账号或密码错误)=failed,用 text 断言捕获。',
        '7. 必须调用 browser_screenshot 截图(无论成败)。',
        '最终输出:verdict(passed/failed)、是否被验证码阻断、错误信息、截图路径。',
      ].join('\n')

  try {
    const r = await oma.runAgent(executor, prompt)
    console.log('\n[real-login] executor success=' + r.success)
    console.log('[real-login] executor 输出:\n' + r.output)
    const dir = 'screenshots/real-login'
    console.log('[real-login] 截图:', existsSync(dir) ? readdirSync(dir) : '(无)')
  } finally {
    browserPool.release(session)
    await browserPool.close()
  }
}

void main().catch((e) => {
  console.error('[real-login] 失败:', e)
  process.exit(1)
})
