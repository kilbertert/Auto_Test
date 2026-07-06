/**
 * AI 探索演示:npm run explore [url] [goal]
 *
 * 默认目标:验证本地 fixture 登录页的登录功能(正确登录 + 空字段校验)。
 * 流程:runMigrate → browserPool.init → runExplore(runTeam 自动分解目标并执行) → browserPool.close。
 * 进度打印到控制台(经 runExplore 的 onProgress 回调)。
 *
 * 注意:探索模式依赖 LLM(runTeam + coordinator),需配置 OMA_API_KEY 等。
 * 默认 url 指向 3199 端口的 fixture 登录页(需先启动 server:PORT=3199 npm run dev)。
 */
import { runMigrate } from '../db/migrate.js'
import { browserPool } from '../browser/pool.js'
import { config } from '../config.js'
import { runExplore } from '../runner/explore.js'

const DEFAULT_URL = 'http://localhost:3199/fixture/login.html'
const DEFAULT_GOAL = '验证登录功能,覆盖正确登录与空字段校验'

function logProgress(m: unknown): void {
  const msg = m as { type?: string; event?: unknown; output?: string; error?: string; success?: boolean }
  switch (msg.type) {
    case 'run_start':
      console.log('[explore] 开始探索')
      break
    case 'progress':
      console.log('[explore] 进度:', JSON.stringify(msg.event))
      break
    case 'trace':
      // trace 较细,仅打印类型,避免刷屏
      break
    case 'stream':
      break
    case 'run_complete':
      console.log('[explore] 完成:', msg.output ?? msg.error ?? '')
      break
    default:
      console.log('[explore]', msg.type ?? '')
  }
}

async function main(): Promise<void> {
  if (!config.hasLlm) {
    console.error('[explore] 需要 LLM 凭据:设置 OMA_API_KEY(及 OMA_MODEL/OMA_PROVIDER/OMA_BASE_URL)。')
    console.error('[explore] 探索模式依赖 runTeam + coordinator,无 LLM 无法运行。')
    process.exit(1)
  }

  runMigrate()
  await browserPool.init()

  const url = process.argv[2] ?? DEFAULT_URL
  const goal = process.argv[3] ?? DEFAULT_GOAL
  const runId = 'explore-demo'

  console.log(`[explore] runId=${runId}`)
  console.log(`[explore] url=${url}`)
  console.log(`[explore] goal=${goal}`)

  try {
    await runExplore(runId, goal, url, logProgress)
  } catch (e) {
    console.error('[explore] 失败:', e)
    process.exitCode = 1
  } finally {
    await browserPool.close()
  }
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
