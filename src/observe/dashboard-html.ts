/** Single-file dashboard page served by the observation server (no build step). */
export function observationDashboardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Auto-Test 观测面板</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #f5f6f8; color: #1c2024; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 20px; }
  header h1 { font-size: 20px; margin: 0; }
  header .status { font-size: 13px; opacity: .7; }
  table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #e6e8ec; font-size: 14px; }
  th { background: #eceff3; font-size: 12px; letter-spacing: .04em; color: #4b5563; }
  tr:hover td { background: #f8fafc; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .running { background: #dbeafe; color: #1d4ed8; }
  .passed { background: #dcfce7; color: #166534; }
  .product_failed { background: #fee2e2; color: #991b1b; }
  .blocked { background: #fef3c7; color: #92400e; }
  .failed { background: #f3f4f6; color: #374151; }
  .invalid { background: #f3f4f6; color: #6b7280; }
  .empty { padding: 32px; text-align: center; opacity: .7; }
  .error { padding: 12px 16px; background: #fee2e2; border-radius: 8px; }
  @media (prefers-color-scheme: dark) {
    body { background: #101418; color: #e5e7eb; }
    table { background: #161b22; }
    th { background: #1c2128; color: #9ca3af; }
    td { border-bottom-color: #21262d; }
    tr:hover td { background: #1c2128; }
    .running { background: #1e3a8a; color: #93c5fd; }
    .passed { background: #14532d; color: #86efac; }
    .product_failed { background: #7f1d1d; color: #fca5a5; }
    .blocked { background: #78350f; color: #fcd34d; }
    .failed, .invalid { background: #1f2937; color: #d1d5db; }
    .error { background: #7f1d1d; }
  }
</style>
</head>
<body>
<header>
  <h1>Auto-Test 观测面板</h1>
  <span class="status" id="summary"></span>
</header>
<main id="content"><div class="empty">正在加载运行列表…</div></main>
<script>
(async () => {
  const content = document.getElementById('content')
  const summary = document.getElementById('summary')
  const statusLabel = { running: '进行中', completed: '已完成', failed: '失败', invalid: '无法读取' }
  const outcomeLabel = { passed: '测试通过', product_failed: '发现产品问题', blocked: '被阻断', failed: '执行异常', none: '—' }
  async function render() {
    let data
    try { data = await (await fetch('/api/runs')).json() } catch (e) { content.innerHTML = '<div class="error">无法连接观测服务：' + e + '</div>'; return }
    const runs = data.runs || []
    if (runs.length === 0) { content.innerHTML = '<div class="empty">还没有任何运行记录</div>'; summary.textContent = ''; return }
    summary.textContent = runs.length + ' 个运行'
    const rows = runs.map(run => \`<tr>
      <td>\${run.runId}</td>
      <td><span class="badge \${run.status}">\${statusLabel[run.status] ?? run.status}</span></td>
      <td>\${outcomeLabel[run.outcome] ?? run.outcome ?? '—'}</td>
      <td>\${run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}</td>
      <td>\${new Date(run.updatedAt).toLocaleString()}</td>
    </tr>\`).join('')
    content.innerHTML = \`<table>
      <thead><tr><th>运行</th><th>状态</th><th>结果</th><th>开始时间</th><th>更新时间</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>\`
  }
  await render()
  setInterval(render, 5000)
})()
</script>
</body>
</html>`
}
