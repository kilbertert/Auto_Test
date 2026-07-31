import { createServer } from 'node:http'

process.umask(0o027)

const host = '127.0.0.1'
const port = Number.parseInt(process.env.AUTO_TEST_FIXTURE_PORT ?? '43117', 10)
const expectedUsername = process.env.AUTO_TEST_SECRET_DEMO_USERNAME
const expectedPassword = process.env.AUTO_TEST_SECRET_DEMO_PASSWORD

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'",
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  response.end(body)
}

function loginPage(error = '') {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>登录 - Auto-Test Fixture</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, sans-serif; background: #f4f6f8; color: #17202a; }
      main { width: min(360px, calc(100% - 32px)); padding: 28px; border: 1px solid #cbd2d9; border-radius: 8px; background: #fff; box-sizing: border-box; }
      h1 { margin: 0 0 24px; font-size: 24px; letter-spacing: 0; }
      label { display: grid; gap: 6px; margin-top: 16px; font-weight: 600; }
      input { min-height: 40px; padding: 0 10px; border: 1px solid #8795a1; border-radius: 4px; font: inherit; }
      button { width: 100%; min-height: 42px; margin-top: 24px; border: 0; border-radius: 4px; background: #1769aa; color: #fff; font: 600 16px system-ui, sans-serif; cursor: pointer; }
      [role="alert"] { margin: 0 0 16px; color: #b42318; }
    </style>
  </head>
  <body>
    <main>
      <h1>系统登录</h1>
      ${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}
      <form method="post" action="/session">
        <label>用户名<input name="username" autocomplete="username" required></label>
        <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit">登录</button>
      </form>
    </main>
  </body>
</html>`
}

function dashboardPage(username) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>控制台 - Auto-Test Fixture</title>
  </head>
  <body>
    <main>
      <h1>控制台</h1>
      <p data-testid="current-user">当前用户：${escapeHtml(username)}</p>
    </main>
  </body>
</html>`
}

async function readForm(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 16_384) throw new Error('request body too large')
  }
  return new URLSearchParams(body)
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`)

  if (request.method === 'GET' && url.pathname === '/health') {
    response.writeHead(204, { 'cache-control': 'no-store' })
    response.end()
    return
  }
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) {
    send(response, 200, loginPage())
    return
  }
  if (request.method === 'POST' && url.pathname === '/session') {
    if (!expectedUsername || !expectedPassword) {
      send(response, 503, loginPage('测试凭据未配置'))
      return
    }
    try {
      const form = await readForm(request)
      const username = form.get('username') ?? ''
      const password = form.get('password') ?? ''
      if (username !== expectedUsername || password !== expectedPassword) {
        send(response, 401, loginPage('用户名或密码错误'))
        return
      }
      response.writeHead(303, {
        'cache-control': 'no-store',
        location: `/dashboard?user=${encodeURIComponent(username)}`,
      })
      response.end()
    } catch {
      send(response, 400, loginPage('请求格式错误'))
    }
    return
  }
  if (request.method === 'GET' && url.pathname === '/dashboard') {
    send(response, 200, dashboardPage(url.searchParams.get('user') ?? 'unknown'))
    return
  }
  send(response, 404, '<h1>Not Found</h1>')
})

server.listen(port, host, () => {
  console.log(`Fixture server listening on http://${host}:${port}`)
})

function shutdown() {
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
