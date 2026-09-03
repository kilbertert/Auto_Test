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
  section { margin-top: 24px; }
  section h2 { font-size: 15px; margin: 0 0 8px; color: #4b5563; }
  .back { margin-bottom: 12px; font-size: 13px; }
  .note { padding: 8px 12px; background: #fef3c7; border-radius: 6px; font-size: 13px; }
  ul.feed { list-style: none; padding-left: 0; max-height: 260px; overflow-y: auto; font-size: 13px; font-family: ui-monospace, monospace; }
  ul.feed li { padding: 2px 0; border-bottom: 1px dashed #e6e8ec; }
  ul.evidence { list-style: none; padding-left: 0; margin: 0; font-size: 12px; }
  ul.evidence li { padding: 1px 0; }
  ul.evidence a { color: #1d4ed8; text-decoration: none; }
  ul.evidence a:hover { text-decoration: underline; }
  @media (prefers-color-scheme: dark) { ul.evidence a { color: #93c5fd; } }
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
    section h2 { color: #9ca3af; }
    .note { background: #78350f; }
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
  const tokenParam = new URLSearchParams(location.search).get('token')
  const withToken = (path) => tokenParam ? path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(tokenParam) : path
  const content = document.getElementById('content')
  const summary = document.getElementById('summary')
  const statusLabel = { running: '进行中', completed: '已完成', failed: '失败', invalid: '无法读取' }
  const outcomeLabel = { passed: '测试通过', product_failed: '发现产品问题', blocked: '被阻断', failed: '执行异常', none: '—' }
  const stageLabel = { preparing: '准备中', executing: '执行中', finalizing: '交付中', completed: '已完成', failed: '失败' }
  const statusClasses = new Set(['running', 'passed', 'product_failed', 'blocked', 'failed', 'invalid', 'completed'])
  const cell = (value) => { const td = document.createElement('td'); td.textContent = value == null || value === '' ? '—' : String(value); return td }
  const badgeCell = (status, label) => {
    const td = document.createElement('td')
    const span = document.createElement('span')
    span.className = 'badge ' + (statusClasses.has(status) ? status : 'invalid')
    span.textContent = label
    td.appendChild(span)
    return td
  }
  function renderTable(runs) {
    const table = document.createElement('table')
    const head = document.createElement('thead')
    head.innerHTML = '<tr><th>运行</th><th>状态</th><th>阶段</th><th>结果</th><th>开始时间</th><th>更新时间</th></tr>'
    table.appendChild(head)
    const body = document.createElement('tbody')
    for (const run of runs) {
      const tr = document.createElement('tr')
      tr.appendChild(cell(run.runId))
      tr.appendChild(badgeCell(run.status, statusLabel[run.status] ?? String(run.status)))
      tr.appendChild(cell(run.stage ? (stageLabel[run.stage] ?? run.stage) : '—'))
      tr.appendChild(cell(run.outcome && run.outcome !== 'none' ? (outcomeLabel[run.outcome] ?? run.outcome) : '—'))
      tr.appendChild(cell(run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'))
      tr.appendChild(cell(new Date(run.updatedAt).toLocaleString()))
      tr.style.cursor = 'pointer'
      tr.addEventListener('click', () => { void showDetail(run.runId) })
      body.appendChild(tr)
    }
    table.appendChild(body)
    content.replaceChildren(table)
  }
  const section = (titleText, ...children) => {
    const sectionEl = document.createElement('section')
    const h2 = document.createElement('h2'); h2.textContent = titleText
    sectionEl.appendChild(h2)
    for (const child of children) sectionEl.appendChild(child)
    return sectionEl
  }
  async function showDetail(runId) {
    content.textContent = '正在加载运行详情…'
    if (detailSource) { detailSource.close(); detailSource = null }
    let detail
    try { detail = await (await fetch(withToken('/api/runs/' + encodeURIComponent(runId)))).json() } catch (e) { content.textContent = '无法加载运行详情：' + e; return }
    if (!detail || detail.error) { content.textContent = '无法加载运行详情：' + (detail ? detail.error : '未知错误'); return }
    if (detail.entry.status === 'running') {
      const feed = document.createElement('ul'); feed.className = 'feed'
      const feedSection = section('实时事件', feed)
      detailSource = new EventSource(withToken('/api/runs/' + encodeURIComponent(runId) + '/events'))
      detailSource.addEventListener('state', (e) => {
        try {
          const state = JSON.parse(e.data)
          renderDetail(state, runId, feed, feedSection)
          if (state.status === 'completed' || state.status === 'failed') {
            if (detailSource) { detailSource.close(); detailSource = null }
            // fall back to the settled detail view for the final artifacts
            void showDetail(runId)
          }
        } catch { /* ignore malformed frame */ }
      })
      detailSource.addEventListener('events', (e) => {
        try {
          const payload = JSON.parse(e.data)
          for (const line of (payload.lines || [])) {
            const item = document.createElement('li')
            const at = line.at ? new Date(line.at).toLocaleTimeString() + ' ' : ''
            const kind = line.event ?? line.type ?? '事件'
            item.textContent = at + kind
            feed.appendChild(item)
          }
          while (feed.children.length > 100) feed.removeChild(feed.firstChild)
        } catch { /* ignore malformed frame */ }
      })
      renderDetail(detail, runId, feed, feedSection)
      return
    }
    renderDetail(detail, runId)
  }
  let detailSource = null
  function renderDetail(detail, runId, liveFeed, liveFeedSection) {
    const container = document.createElement('div'); container.id = 'detail-container'
    const back = document.createElement('button'); back.textContent = '← 返回运行列表'; back.className = 'back'
    back.addEventListener('click', () => {
      if (detailSource) { detailSource.close(); detailSource = null }
      void render()
    })
    container.appendChild(back)
    const title = document.createElement('h2')
    title.textContent = (detail.summary?.title ?? '运行') + ' — ' + runId
    container.appendChild(title)
    const progress = detail.progress ?? {
      activeEpochIndex: detail.activeEpoch?.index, activeEpochTotal: detail.activeEpoch?.total,
      activeEpochStage: detail.activeEpoch?.stage, epochCount: detail.epochCount,
      completedCaseCount: Array.isArray(detail.completedCaseIds) ? detail.completedCaseIds.length : 0,
      runInterruptionSummary: detail.runInterruption?.summary, runInterruptionNextAction: detail.runInterruption?.nextAction,
    }
    const progressList = document.createElement('ul')
    const li = (label, value) => { const item = document.createElement('li'); item.textContent = label + (value == null ? '—' : String(value)); return item }
    progressList.appendChild(li('状态：', statusLabel[detail.entry?.status ?? detail.status] ?? detail.entry?.status ?? detail.status))
    progressList.appendChild(li('阶段：', stageLabel[detail.entry?.stage ?? detail.stage] ?? detail.entry?.stage ?? detail.stage))
    if (progress.activeEpochTotal != null) progressList.appendChild(li('Epoch 进度：', (progress.activeEpochIndex ?? '—') + ' / ' + progress.activeEpochTotal + (progress.activeEpochStage ? '（' + progress.activeEpochStage + '）' : '')))
    if (progress.epochCount != null) progressList.appendChild(li('已规划 Epoch 数：', progress.epochCount))
    progressList.appendChild(li('已完成用例：', progress.completedCaseCount))
    if (progress.runInterruptionSummary) {
      progressList.appendChild(li('运行中断：', progress.runInterruptionSummary))
      if (progress.runInterruptionNextAction) progressList.appendChild(li('恢复操作：', progress.runInterruptionNextAction))
    }
    container.appendChild(section('运行进度', progressList))
    const summaryList = document.createElement('ul')
    for (const line of (detail.summary?.lines || [])) { const item = document.createElement('li'); item.textContent = line; summaryList.appendChild(item) }
    if (summaryList.children.length > 0) container.appendChild(section('结果摘要', summaryList))
    if (detail.resultProblem) { const note = document.createElement('p'); note.className = 'note'; note.textContent = detail.resultProblem; container.appendChild(note) }
    if (detail.cases && detail.cases.length > 0) {
      const table = document.createElement('table')
      const head = document.createElement('thead')
      head.innerHTML = '<tr><th>用例</th><th>标题</th><th>结果</th><th>失败来源</th><th>失败类型</th><th>摘要</th><th>证据</th></tr>'
      table.appendChild(head)
      const body = document.createElement('tbody')
      for (const item of detail.cases) {
        const tr = document.createElement('tr')
        tr.appendChild(cell(item.caseId))
        tr.appendChild(cell(item.title))
        tr.appendChild(badgeCell(item.outcome, outcomeLabel[item.outcome] ?? item.outcome))
        tr.appendChild(cell(item.failureSource))
        tr.appendChild(cell(item.failureKind))
        tr.appendChild(cell(item.summary))
        const evidenceCell = document.createElement('td')
        if (item.evidence && item.evidence.length > 0) {
          const list = document.createElement('ul'); list.className = 'evidence'
          for (const entry of item.evidence) {
            const li = document.createElement('li')
            if (entry.path) {
              // Results record evidence paths relative to agent-workspace
              // (evidence/<file>); the route serves from inside that directory.
              let relativePath = entry.path
              if (relativePath.startsWith('evidence/')) relativePath = relativePath.slice('evidence/'.length)
              const link = document.createElement('a')
              link.href = withToken('/api/runs/' + encodeURIComponent(runId) + '/evidence/' + relativePath.split('/').map(encodeURIComponent).join('/')
              link.target = '_blank'; link.rel = 'noopener'
              link.textContent = (entry.kind ? entry.kind + '：' : '') + entry.path
              li.appendChild(link)
            } else {
              li.textContent = (entry.kind ? entry.kind + '：' : '') + entry.description
            }
            list.appendChild(li)
          }
          evidenceCell.appendChild(list)
        } else {
          evidenceCell.textContent = '—'
        }
        tr.appendChild(evidenceCell)
        body.appendChild(tr)
      }
      table.appendChild(body)
      container.appendChild(section('用例结果', table))
    }
    if (detail.environmentBlockers && detail.environmentBlockers.length > 0) {
      const blockers = document.createElement('ul')
      for (const item of detail.environmentBlockers) {
        const entry = document.createElement('li')
        entry.textContent = (item.origin ?? item.kind) + '：' + item.condition + '（影响用例：' + item.caseIds.join('、') + '）'
        blockers.appendChild(entry)
      }
      container.appendChild(section('待补充的环境（解除后可恢复运行）', blockers))
    }
    if (liveFeedSection) container.appendChild(liveFeedSection)
    content.replaceChildren(container)
  }
  async function render() {
    let data
    try { data = await (await fetch(withToken('/api/runs'))).json() } catch (e) { content.textContent = ''; const div = document.createElement('div'); div.className = 'error'; div.textContent = '无法连接观测服务：' + e; content.appendChild(div); return }
    const runs = data.runs || []
    if (runs.length === 0) { content.textContent = '还没有任何运行记录'; content.className = 'empty'; summary.textContent = ''; return }
    content.className = ''
    summary.textContent = runs.length + ' 个运行'
    renderTable(runs)
  }
  await render()
  setInterval(render, 5000)
})()
</script>
</body>
</html>`
}
