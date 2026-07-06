import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { config } from './config.js'
import { browserPool } from './browser/pool.js'
import { subscribe, broadcast } from './ws-bus.js'
import { runAgentMode, newRunId } from './runner/orchestrate.js'
import { runSmoke } from './runner/smoke.js'
import { runMigrate } from './db/migrate.js'
import { runRegression } from './runner/regression.js'
import { getTree, getCases, getCase, importHandler, interpretHandler, getRuns, getRun } from './api/cases-api.js'
import { runExplore } from './runner/explore.js'

const ROOT = process.cwd()
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
}

/** 安全静态文件:解析后必须仍在 ROOT 下(防路径穿越)。 */
async function serveStatic(res: ServerResponse, relPath: string): Promise<void> {
  const safe = normalize(join(ROOT, relPath))
  if (!safe.startsWith(ROOT)) {
    res.statusCode = 403
    res.end('forbidden')
    return
  }
  try {
    const s = await stat(safe)
    if (s.isDirectory()) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    const data = await readFile(safe)
    res.setHeader('Content-Type', MIME[extname(safe)] ?? 'application/octet-stream')
    res.end(data)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise(resolve => {
    let buf = ''
    req.on('data', c => (buf += c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(buf))
      } catch {
        resolve({})
      }
    })
  })
}

async function main(): Promise<void> {
  console.log('[server] 运行数据库迁移...')
  runMigrate()
  console.log('[server] 初始化浏览器池...')
  await browserPool.init()

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/'
    const path = url.split('?')[0]

    // P0 开发用宽松 CORS;P5 收窄
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'content-type')
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    // 首页看板
    if (path === '/' && req.method === 'GET') {
      return serveStatic(res, 'public/dashboard.html')
    }
    // 触发 run
    if (path === '/api/v1/runs' && req.method === 'POST') {
      const body = await readBody(req)
      if (body.mode === 'agent') {
        if (!config.hasLlm) {
          return sendJson(res, 400, { error: 'agent 模式需要 OMA_API_KEY(见 .env)' })
        }
        const runId = newRunId()
        sendJson(res, 200, { runId, mode: 'agent' })
        void runAgentMode(runId).catch(e => {
          console.error('[run] agent 模式失败:', e)
          broadcast(runId, { type: 'run_complete', runId, error: String(e) })
        })
        return
      }
      if (body.mode === 'smoke') {
        const runId = newRunId()
        sendJson(res, 200, { runId, mode: 'smoke' })
        void runSmoke(runId, msg => broadcast(runId, msg)).catch(e => {
          console.error('[run] smoke 模式失败:', e)
          broadcast(runId, { type: 'run_complete', runId, error: String(e) })
        })
        return
      }
      if (body.mode === 'regression') {
        const runId = newRunId()
        const bodyOpts = body as { caseIds?: number[]; limit?: number }
        sendJson(res, 200, { runId, mode: 'regression' })
        void runRegression(runId, { caseIds: bodyOpts.caseIds, limit: bodyOpts.limit }, (msg) => broadcast(runId, msg))
          .then((r) => broadcast(runId, { type: 'run_complete', runId, summary: r }))
          .catch((e) => {
            console.error('[run] regression 失败:', e)
            broadcast(runId, { type: 'run_complete', runId, error: String(e) })
          })
        return
      }
      if (body.mode === 'explore') {
        if (!config.hasLlm) {
          return sendJson(res, 400, { error: 'explore 模式需要 OMA_API_KEY(见 .env)' })
        }
        const bodyOpts = body as { url?: string; goal?: string }
        const runId = newRunId()
        const url = bodyOpts.url ?? config.TARGET_LOGIN_URL
        const goal = bodyOpts.goal ?? '验证页面核心功能'
        sendJson(res, 200, { runId, mode: 'explore' })
        void runExplore(runId, goal, url).catch((e) => {
          console.error('[run] explore 失败:', e)
          broadcast(runId, { type: 'run_complete', runId, error: String(e) })
        })
        return
      }
      return sendJson(res, 400, { error: '未知 mode,支持 agent | smoke | regression | explore' })
    }
    // 用例/导入/解释/运行查询 API(供 Vue UI 消费)
    if (path === '/api/v1/tree' && req.method === 'GET') {
      return getTree(res)
    }
    if (path === '/api/v1/cases' && req.method === 'GET') {
      const params = new URL('http://x' + url).searchParams
      return getCases(res, Object.fromEntries(params.entries()))
    }
    if (path.startsWith('/api/v1/cases/') && req.method === 'GET') {
      return getCase(res, path.slice('/api/v1/cases/'.length))
    }
    if (path === '/api/v1/import' && req.method === 'POST') {
      const b = await readBody(req)
      return importHandler(res, b)
    }
    if (path === '/api/v1/interpret' && req.method === 'POST') {
      const b = await readBody(req)
      return interpretHandler(res, b)
    }
    if (path === '/api/v1/runs' && req.method === 'GET') {
      return getRuns(res)
    }
    if (path.startsWith('/api/v1/runs/') && req.method === 'GET') {
      return getRun(res, path.slice('/api/v1/runs/'.length))
    }
    // fixture 登录页:/fixture/login.html → src/fixtures/login.html
    if (path.startsWith('/fixture/') && req.method === 'GET') {
      return serveStatic(res, join('src', 'fixtures', path.slice('/fixture/'.length)))
    }
    // 截图:/screenshots/<runId>/x.png → screenshots/...
    if (path.startsWith('/screenshots/') && req.method === 'GET') {
      return serveStatic(res, path.slice(1))
    }

    sendJson(res, 404, { error: 'not found' })
  })

  // WebSocket:/ws?runId=xxx
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? ''
    if (!url.startsWith('/ws')) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const runId = new URL('http://localhost' + url).searchParams.get('runId') ?? 'default'
      const unsub = subscribe(runId, ws)
      ws.on('close', unsub)
    })
  })

  server.listen(config.PORT, () => {
    console.log(`[server] 监听 http://localhost:${config.PORT}`)
    console.log(`[server] 看板: http://localhost:${config.PORT}/`)
    console.log(`[server] fixture 登录页: http://localhost:${config.PORT}/fixture/login.html`)
    console.log(`[server] LLM 凭据: ${config.hasLlm ? '已配置(agent 模式可用)' : '未配置(仅 smoke 可用)'}`)
  })

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`\n[server] 收到 ${sig},关闭中...`)
    server.close()
    await browserPool.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

void main().catch(e => {
  console.error('[server] 启动失败:', e)
  process.exit(1)
})
