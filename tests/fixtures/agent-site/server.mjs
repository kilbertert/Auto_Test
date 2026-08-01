import { createServer } from 'node:http'

process.umask(0o027)

const host = '127.0.0.1'
const port = Number.parseInt(process.env.AUTO_TEST_AGENT_FIXTURE_PORT ?? '43127', 10)
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('AUTO_TEST_AGENT_FIXTURE_PORT must be a valid port')

const products = [
  { name: 'Atlas Lamp', category: 'Lighting', stock: 12 },
  { name: 'Harbor Chair', category: 'Furniture', stock: 4 },
  { name: 'Orbit Lamp', category: 'Lighting', stock: 7 },
]
const notes = new Map()

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      body { max-width: 900px; margin: 32px auto; padding: 0 20px; font: 16px/1.5 system-ui, sans-serif; color: #17212b; }
      nav { display: flex; gap: 16px; margin-bottom: 24px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 10px; border: 1px solid #c7cdd4; text-align: left; }
      form { display: flex; gap: 8px; margin: 16px 0; }
      input, select, button { min-height: 36px; padding: 6px 10px; font: inherit; }
      li { margin: 8px 0; }
    </style>
  </head>
  <body>
    <nav><a href="/catalog">Catalog</a><a href="/notes">Notes</a></nav>
    ${body}
  </body>
</html>`
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

async function form(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 16_384) throw new Error('request body too large')
  }
  return new URLSearchParams(body)
}

function catalogPage(category = 'All') {
  const visible = category === 'All' ? products : products.filter((product) => product.category === category)
  return page('Catalog', `
    <main>
      <h1>Product Catalog</h1>
      <form method="get" action="/catalog">
        <label>Category
          <select name="category">
            ${['All', 'Lighting', 'Furniture'].map((value) => `<option${value === category ? ' selected' : ''}>${value}</option>`).join('')}
          </select>
        </label>
        <button type="submit">Apply filter</button>
      </form>
      <p data-testid="result-count">${visible.length} products</p>
      <table>
        <thead><tr><th>Name</th><th>Category</th><th>Stock</th></tr></thead>
        <tbody>${visible.map((product) => `<tr><td><a href="/catalog/${encodeURIComponent(product.name)}">${escapeHtml(product.name)}</a></td><td>${product.category}</td><td>${product.stock}</td></tr>`).join('')}</tbody>
      </table>
    </main>`)
}

function productPage(product) {
  return page(product.name, `<main><h1>${escapeHtml(product.name)}</h1><dl><dt>Category</dt><dd>${product.category}</dd><dt>Available stock</dt><dd>${product.stock}</dd></dl></main>`)
}

function notesPage() {
  const items = [...notes.values()].map((note) => `
    <li data-note-id="${escapeHtml(note.id)}"><strong>${escapeHtml(note.title)}</strong>
      <form method="post" action="/notes/delete"><input type="hidden" name="id" value="${escapeHtml(note.id)}"><button type="submit">Delete ${escapeHtml(note.title)}</button></form>
    </li>`).join('')
  return page('Notes', `
    <main>
      <h1>Team Notes</h1>
      <form method="post" action="/notes">
        <label>Note title <input name="title" required></label>
        <button type="submit">Add note</button>
      </form>
      <p data-testid="note-count">${notes.size} notes</p>
      <ul>${items}</ul>
    </main>`)
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`)
  if (request.method === 'GET' && url.pathname === '/health') {
    response.writeHead(204, { 'cache-control': 'no-store' })
    response.end()
    return
  }
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/catalog')) {
    send(response, 200, catalogPage(url.searchParams.get('category') ?? 'All'))
    return
  }
  if (request.method === 'GET' && url.pathname.startsWith('/catalog/')) {
    const name = decodeURIComponent(url.pathname.slice('/catalog/'.length))
    const product = products.find((candidate) => candidate.name === name)
    send(response, product ? 200 : 404, product ? productPage(product) : page('Not Found', '<h1>Product not found</h1>'))
    return
  }
  if (request.method === 'GET' && url.pathname === '/notes') {
    send(response, 200, notesPage())
    return
  }
  if (request.method === 'POST' && url.pathname === '/notes') {
    const input = await form(request)
    const title = input.get('title')?.trim()
    if (!title) {
      send(response, 400, page('Invalid note', '<h1>Note title is required</h1>'))
      return
    }
    const id = `note-${Date.now()}-${Math.random().toString(16).slice(2)}`
    notes.set(id, { id, title })
    response.writeHead(303, { location: '/notes', 'cache-control': 'no-store' })
    response.end()
    return
  }
  if (request.method === 'POST' && url.pathname === '/notes/delete') {
    const input = await form(request)
    notes.delete(input.get('id') ?? '')
    response.writeHead(303, { location: '/notes', 'cache-control': 'no-store' })
    response.end()
    return
  }
  send(response, 404, page('Not Found', '<h1>Not Found</h1>'))
})

server.listen(port, host, () => console.log(`Agent fixture listening on http://${host}:${port}`))

function shutdown() {
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
