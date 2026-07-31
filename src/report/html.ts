import type { IntegratedCaseReport, IntegratedRunReport, ReportCaseStatus, ReportTargetTrace } from './types.js'

function h(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function duration(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`
}

function statusLabel(status: ReportCaseStatus): string {
  const labels: Record<ReportCaseStatus, string> = {
    passed: '通过',
    failed: '失败',
    flaky: '不稳定',
    skipped: '跳过',
    blocked: '阻断',
    not_run: '未执行',
  }
  return labels[status]
}

function targetRows(targets: ReportTargetTrace[]): string {
  if (!targets.length) return '<p class="empty">无</p>'
  return `<div class="table-wrap"><table>
    <thead><tr><th>类型</th><th>IR</th><th>生成代码</th><th>定位/断言</th><th>验证</th><th>执行</th></tr></thead>
    <tbody>${targets.map((target) => {
      const validation = target.validations.length
        ? target.validations.map((check) => `R${check.replay}: count=${check.count} ${check.passed ? 'PASS' : 'FAIL'}`).join('<br>')
        : '无'
      const execution = target.executionSteps.length
        ? target.executionSteps.map((step) => `${duration(step.durationMs)}${step.error ? ` · ${h(step.error)}` : ''}`).join('<br>')
        : '无'
      const detail = target.assertion
        ? `${h(target.assertion.kind)} ${h(target.assertion.operator)} <code>${h(target.assertion.expected)}</code>`
        : target.expression ? `<code>${h(target.expression)}</code>` : h(target.action ?? '')
      return `<tr>
        <td><span class="type-label">${h(target.targetType)}</span></td>
        <td><strong>${h(target.id)}</strong><br><span class="secondary">${h(target.sourceText)}</span></td>
        <td>${target.codeLine ? `line ${target.codeLine}` : '无映射'}</td>
        <td>${detail}${target.valueRef ? `<br><span class="secondary">valueRef: ${h(target.valueRef)}</span>` : ''}</td>
        <td>${validation}</td>
        <td>${execution}</td>
      </tr>`
    }).join('')}</tbody>
  </table></div>`
}

function classificationBlock(testCase: IntegratedCaseReport): string {
  if (!testCase.classifications.length) return '<p class="empty">无失败分类</p>'
  return testCase.classifications.map((item) => `<div class="event event-${h(item.category)}">
    <div><strong>${h(item.category)}</strong> · ${h(item.confidence)} · ${h(item.failureKind)}</div>
    <div class="secondary">${h(item.phase)}${item.targetId ? ` / ${h(item.targetId)}` : ''} · replay ${item.replay ?? '-'}</div>
    ${item.evidence.map((evidence) => `<pre>${h(evidence)}</pre>`).join('')}
  </div>`).join('')
}

function repairBlock(testCase: IntegratedCaseReport): string {
  if (!testCase.repairs.length) return '<p class="empty">无修复</p>'
  return testCase.repairs.map((change, index) => `<div class="repair-row">
    <div><strong>Attempt change ${index + 1}</strong> · ${h(change.kind)} · ${h(change.targetType)}/${h(change.targetId)}</div>
    <div class="secondary">${h(change.reason)}</div>
    <div class="diff-grid"><pre><span>Before</span>\n${h(JSON.stringify(change.before, null, 2))}</pre><pre><span>After</span>\n${h(JSON.stringify(change.after, null, 2))}</pre></div>
  </div>`).join('')
}

function executionBlock(testCase: IntegratedCaseReport): string {
  if (!testCase.executions.length) return '<p class="empty">无 Playwright 执行结果</p>'
  return testCase.executions.map((execution) => `<div class="execution-row">
    <div><span class="status status-${h(execution.status)}">${h(execution.status)}</span> <strong>${h(execution.projectName)}</strong> · ${duration(execution.durationMs)} · retry ${execution.retryCount}</div>
    ${execution.startTime ? `<div class="secondary">${h(execution.startTime)}</div>` : ''}
    ${execution.errors.map((error) => `<pre>${h(error)}</pre>`).join('')}
    ${execution.attachments.length ? `<div class="attachment-list">${execution.attachments.map((attachment) => `<code>${h(attachment.name)} · ${h(attachment.contentType)}${attachment.path ? ` · ${h(attachment.path)}` : ''}</code>`).join('')}</div>` : ''}
  </div>`).join('')
}

function caseSection(testCase: IntegratedCaseReport): string {
  const search = [testCase.caseId, testCase.title, ...testCase.modulePath, ...testCase.tags].join(' ').toLowerCase()
  return `<section class="case" data-status="${h(testCase.status)}" data-search="${h(search)}">
    <details ${testCase.status === 'failed' || testCase.status === 'flaky' || testCase.status === 'blocked' ? 'open' : ''}>
      <summary>
        <span class="status status-${h(testCase.status)}">${statusLabel(testCase.status)}</span>
        ${testCase.repaired ? '<span class="status status-repaired">已修复</span>' : ''}
        <span class="case-id">${h(testCase.caseId)}</span>
        <strong>${h(testCase.title)}</strong>
        <span class="case-meta">${h(testCase.priority)} · ${h(testCase.risk)} · row ${testCase.sourceRow ?? '-'}</span>
      </summary>
      <div class="case-body">
        <section class="band">
          <h3>追溯</h3>
          <dl class="meta-grid">
            <div><dt>模块</dt><dd>${h(testCase.modulePath.join(' / ') || '-')}</dd></div>
            <div><dt>标签</dt><dd>${h(testCase.tags.join(', ') || '-')}</dd></div>
            <div><dt>审核</dt><dd>${h(testCase.reviewStatus)}</dd></div>
            <div><dt>生成代码</dt><dd>${h(testCase.code.generatedFile)}:${testCase.code.testLine ?? '-'}</dd></div>
          </dl>
        </section>
        <section class="band"><h3>Playwright 执行</h3>${executionBlock(testCase)}</section>
        <section class="band"><h3>步骤</h3>${targetRows(testCase.steps)}</section>
        <section class="band"><h3>断言</h3>${targetRows(testCase.assertions)}</section>
        ${testCase.cleanupSteps.length ? `<section class="band"><h3>清理步骤</h3>${targetRows(testCase.cleanupSteps)}</section>` : ''}
        <section class="band"><h3>失败分类</h3>${classificationBlock(testCase)}</section>
        <section class="band"><h3>修复记录</h3>${repairBlock(testCase)}</section>
      </div>
    </details>
  </section>`
}

export function renderIntegratedRunReportHtml(report: IntegratedRunReport): string {
  const summary = report.summary
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>${h(report.suiteId)} · Auto-Test Run Report</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17202a; background: #f4f6f8; letter-spacing: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; }
    header { padding: 22px clamp(16px, 4vw, 48px); background: #17202a; color: #fff; }
    header h1 { margin: 0; font-size: 24px; letter-spacing: 0; }
    header p { margin: 6px 0 0; color: #cbd5df; overflow-wrap: anywhere; }
    .summary-band, .controls, main { padding-left: clamp(16px, 4vw, 48px); padding-right: clamp(16px, 4vw, 48px); }
    .summary-band { display: grid; grid-template-columns: repeat(7, minmax(100px, 1fr)); gap: 8px; padding-top: 16px; padding-bottom: 16px; background: #fff; border-bottom: 1px solid #d7dde3; }
    .metric { min-width: 0; padding: 10px 12px; border: 1px solid #d7dde3; border-radius: 4px; }
    .metric span { display: block; color: #5b6875; font-size: 12px; }
    .metric strong { display: block; margin-top: 2px; font-size: 22px; }
    .controls { display: flex; gap: 12px; align-items: center; padding-top: 14px; padding-bottom: 14px; background: #eef1f4; border-bottom: 1px solid #d7dde3; position: sticky; top: 0; z-index: 2; }
    .segments { display: flex; flex-wrap: wrap; gap: 2px; padding: 2px; border: 1px solid #b8c1ca; border-radius: 4px; background: #fff; }
    button { border: 0; background: transparent; min-height: 32px; padding: 0 10px; cursor: pointer; color: #34414e; font: inherit; }
    button.active { background: #17202a; color: #fff; border-radius: 3px; }
    input { min-height: 38px; flex: 1; min-width: 180px; padding: 0 10px; border: 1px solid #9aa6b2; border-radius: 4px; background: #fff; font: inherit; }
    main { background: #fff; }
    .case { border-bottom: 1px solid #d7dde3; }
    .case[hidden] { display: none; }
    summary { display: grid; grid-template-columns: auto auto minmax(110px, auto) minmax(180px, 1fr) auto; gap: 10px; align-items: center; min-height: 58px; cursor: pointer; list-style: none; }
    summary::-webkit-details-marker { display: none; }
    .case-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #41505f; }
    .case-meta, .secondary { color: #687582; font-size: 13px; overflow-wrap: anywhere; }
    .case-body { border-top: 1px solid #e2e7eb; background: #fafbfc; }
    .band { padding: 16px 0; border-bottom: 1px solid #e2e7eb; }
    .band:last-child { border-bottom: 0; }
    h3 { margin: 0 0 10px; font-size: 15px; letter-spacing: 0; }
    .meta-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 0; }
    .meta-grid div { min-width: 0; }
    dt { color: #687582; font-size: 12px; }
    dd { margin: 3px 0 0; overflow-wrap: anywhere; }
    .status { display: inline-flex; align-items: center; min-height: 24px; padding: 0 7px; border-radius: 3px; font-size: 12px; font-weight: 700; white-space: nowrap; }
    .status-passed { background: #dff3e5; color: #166534; }
    .status-failed { background: #fee2e2; color: #991b1b; }
    .status-flaky { background: #fef3c7; color: #92400e; }
    .status-skipped, .status-not_run { background: #e8edf2; color: #52606d; }
    .status-blocked { background: #fce7d6; color: #9a3412; }
    .status-repaired { background: #dbeafe; color: #1d4ed8; }
    .table-wrap { overflow-x: auto; border: 1px solid #d7dde3; }
    table { width: 100%; border-collapse: collapse; min-width: 860px; background: #fff; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #e2e7eb; text-align: left; vertical-align: top; font-size: 13px; }
    th { background: #eef1f4; color: #465564; font-weight: 700; }
    tr:last-child td { border-bottom: 0; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    code { overflow-wrap: anywhere; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; padding: 10px; border: 1px solid #d7dde3; background: #fff; color: #283644; }
    pre span { color: #687582; font-family: inherit; }
    .event, .repair-row, .execution-row { padding: 10px 0; border-top: 1px solid #d7dde3; }
    .event:first-child, .repair-row:first-child, .execution-row:first-child { border-top: 0; }
    .event-product_defect strong { color: #991b1b; }
    .event-test_code strong { color: #1d4ed8; }
    .event-environment strong { color: #7c3aed; }
    .event-data strong, .event-policy strong { color: #9a3412; }
    .diff-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .attachment-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .attachment-list code { padding: 4px 6px; border: 1px solid #c8d0d8; background: #fff; }
    .empty { margin: 0; color: #687582; }
    .no-results { padding: 28px 0; color: #687582; }
    footer { padding: 16px clamp(16px, 4vw, 48px); color: #687582; background: #eef1f4; font-size: 12px; overflow-wrap: anywhere; }
    @media (max-width: 900px) { .summary-band { grid-template-columns: repeat(3, 1fr); } .meta-grid { grid-template-columns: repeat(2, 1fr); } summary { grid-template-columns: auto auto 1fr; padding: 10px 0; } summary strong, .case-meta { grid-column: 1 / -1; } .diff-grid { grid-template-columns: 1fr; } }
    @media (max-width: 600px) { .controls { align-items: stretch; flex-direction: column; } .segments { width: 100%; } .summary-band { grid-template-columns: repeat(2, 1fr); } .meta-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>Auto-Test Run Report</h1>
    <p>${h(report.suiteId)} · ${h(report.target.baseUrl)} · ${h(report.generatedAt)}</p>
  </header>
  <section class="summary-band" aria-label="执行摘要">
    <div class="metric"><span>用例</span><strong>${summary.total}</strong></div>
    <div class="metric"><span>通过</span><strong>${summary.passed}</strong></div>
    <div class="metric"><span>失败</span><strong>${summary.failed}</strong></div>
    <div class="metric"><span>不稳定</span><strong>${summary.flaky}</strong></div>
    <div class="metric"><span>阻断</span><strong>${summary.blocked}</strong></div>
    <div class="metric"><span>修复</span><strong>${summary.repaired}</strong></div>
    <div class="metric"><span>未执行</span><strong>${summary.notRun}</strong></div>
  </section>
  <section class="controls">
    <div class="segments" role="tablist" aria-label="状态筛选">
      <button class="active" data-filter="all">全部</button>
      <button data-filter="passed">通过</button>
      <button data-filter="failed">失败</button>
      <button data-filter="flaky">不稳定</button>
      <button data-filter="blocked">阻断</button>
      <button data-filter="not_run">未执行</button>
    </div>
    <input id="case-search" type="search" placeholder="搜索用例 ID、标题、模块或标签" aria-label="搜索用例">
  </section>
  <main id="case-list">
    ${report.cases.map(caseSection).join('')}
    <p id="no-results" class="no-results" hidden>没有匹配的用例</p>
  </main>
  <footer>Source: ${h(report.source.fileName)} / ${h(report.source.sheetName ?? '-')} · IR ${h(report.integrity.irSha256)} · Spec ${h(report.generatedSpec.sha256)}</footer>
  <script>
    const buttons = [...document.querySelectorAll('[data-filter]')]
    const input = document.getElementById('case-search')
    const cases = [...document.querySelectorAll('.case')]
    const empty = document.getElementById('no-results')
    let filter = 'all'
    function update() {
      const query = input.value.trim().toLowerCase()
      let visible = 0
      for (const item of cases) {
        const matchesStatus = filter === 'all' || item.dataset.status === filter
        const matchesQuery = !query || item.dataset.search.includes(query)
        item.hidden = !(matchesStatus && matchesQuery)
        if (!item.hidden) visible += 1
      }
      empty.hidden = visible !== 0
    }
    for (const button of buttons) button.addEventListener('click', () => {
      filter = button.dataset.filter
      for (const item of buttons) item.classList.toggle('active', item === button)
      update()
    })
    input.addEventListener('input', update)
  </script>
</body>
</html>`
}
