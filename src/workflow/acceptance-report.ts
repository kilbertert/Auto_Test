import type {
  WorkflowAcceptanceEvidence,
  WorkflowAcceptanceReport,
  WorkflowEvidenceStatus,
  WorkflowIntakeManifest,
} from './types.js'

export function buildWorkflowAcceptanceReport(
  workflow: WorkflowIntakeManifest,
  evidence: WorkflowAcceptanceEvidence,
): WorkflowAcceptanceReport {
  if (workflow.workflowId !== evidence.workflowId) throw new Error('Acceptance evidence workflowId does not match intake manifest')
  if (workflow.source.sha256 !== evidence.sourceSha256) throw new Error('Acceptance evidence source hash does not match intake manifest')
  const assertions = evidence.phases.flatMap((phase) => phase.assertions)
  const count = (status: WorkflowEvidenceStatus): number => evidence.phases.filter((phase) => phase.status === status).length
  return {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    workflow: {
      workflowId: workflow.workflowId,
      source: structuredClone(workflow.source),
      targetUrls: [...workflow.targetUrls],
      requiredCapabilities: [...workflow.requiredCapabilities],
      phaseCount: workflow.phases.length,
      imageCount: workflow.embeddedImages.length + workflow.supplementalImages.length,
    },
    acceptance: structuredClone(evidence),
    summary: {
      phases: evidence.phases.length,
      passed: count('passed'),
      failed: count('failed'),
      blocked: count('blocked'),
      assertions: assertions.length,
      assertionsPassed: assertions.filter((assertion) => assertion.passed).length,
    },
  }
}

function h(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function statusLabel(status: WorkflowEvidenceStatus): string {
  return status === 'passed' ? '通过' : status === 'failed' ? '失败' : '阻断'
}

export function renderWorkflowAcceptanceHtml(report: WorkflowAcceptanceReport): string {
  const evidence = report.acceptance
  const phaseSections = evidence.phases.map((phase) => `<section class="phase">
    <header><span class="status status-${h(phase.status)}">${statusLabel(phase.status)}</span><h2>${h(phase.title)}</h2><code>${h(phase.phaseId)}</code></header>
    <p class="source">来源：${phase.sourceRefs.map(h).join(' · ')}</p>
    <table><thead><tr><th>断言</th><th>结果</th><th>证据</th></tr></thead><tbody>${phase.assertions.map((assertion) => `<tr><td>${h(assertion.description)}</td><td>${assertion.passed ? 'PASS' : 'FAIL'}</td><td>${h(assertion.evidence)}</td></tr>`).join('')}</tbody></table>
    ${phase.observations.length ? `<ul>${phase.observations.map((item) => `<li>${h(item)}</li>`).join('')}</ul>` : ''}
    ${phase.entities ? `<dl>${Object.entries(phase.entities).map(([key, value]) => `<div><dt>${h(key)}</dt><dd><code>${h(value)}</code></dd></div>`).join('')}</dl>` : ''}
  </section>`).join('')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'">
<title>${h(report.workflow.workflowId)} · 工作流验收报告</title><style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#17202a;background:#f4f6f8}*{box-sizing:border-box}body{margin:0}body>header,main,footer{padding-left:clamp(16px,4vw,52px);padding-right:clamp(16px,4vw,52px)}body>header{padding-top:24px;padding-bottom:24px;background:#17202a;color:#fff}h1{margin:0;font-size:25px}header p{margin:8px 0 0;color:#cbd5df;overflow-wrap:anywhere}.gate{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:16px clamp(16px,4vw,52px);background:#fff;border-bottom:1px solid #d7dde3}.metric{padding:12px;border:1px solid #d7dde3;border-radius:5px}.metric span{display:block;color:#687582;font-size:12px}.metric strong{display:block;margin-top:3px;font-size:21px}.status{display:inline-flex;padding:4px 8px;border-radius:4px;font-size:12px;font-weight:700}.status-passed{background:#dff3e5;color:#166534}.status-failed{background:#fee2e2;color:#991b1b}.status-blocked{background:#fef3c7;color:#92400e}main{padding-top:18px;padding-bottom:18px}.overview,.phase,.gaps{background:#fff;border:1px solid #d7dde3;border-radius:6px;padding:16px;margin-bottom:14px}.overview h2,.gaps h2{margin-top:0}.phase header{display:flex;align-items:center;gap:10px}.phase h2{font-size:18px;margin:0}.source{color:#687582;font-size:13px}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{padding:9px;border:1px solid #d7dde3;text-align:left;vertical-align:top;font-size:13px}th{background:#eef1f4}ul{padding-left:22px}li{margin:5px 0}dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}dl div{min-width:0}dt{color:#687582;font-size:12px}dd{margin:3px 0 0;overflow-wrap:anywhere}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}footer{padding-top:16px;padding-bottom:16px;color:#687582;background:#eef1f4;font-size:12px;overflow-wrap:anywhere}@media(max-width:760px){.gate{grid-template-columns:repeat(2,1fr)}.phase header{align-items:flex-start;flex-wrap:wrap}table{display:block;overflow-x:auto}dl{grid-template-columns:1fr}}
</style></head><body><header><h1>Auto-Test 工作流验收报告</h1><p>${h(report.workflow.workflowId)} · ${h(report.workflow.source.fileName)} · ${h(report.generatedAt)}</p></header>
<section class="gate"><div class="metric"><span>业务 canary</span><strong class="status status-${h(evidence.businessCanaryStatus)}">${statusLabel(evidence.businessCanaryStatus)}</strong></div><div class="metric"><span>产品验收门</span><strong class="status status-${h(evidence.productAcceptanceStatus)}">${statusLabel(evidence.productAcceptanceStatus)}</strong></div><div class="metric"><span>阶段</span><strong>${report.summary.passed}/${report.summary.phases}</strong></div><div class="metric"><span>断言</span><strong>${report.summary.assertionsPassed}/${report.summary.assertions}</strong></div></section>
<main><section class="overview"><h2>输入与完整性</h2><p>Sheet：${h(report.workflow.source.sheetName)} · SHA-256：<code>${h(report.workflow.source.sha256)}</code></p><p>目标：${report.workflow.targetUrls.map((url) => `<code>${h(url)}</code>`).join(' · ')}</p><p>图片资产：${report.workflow.imageCount} · 所需能力：${report.workflow.requiredCapabilities.map(h).join(', ')}</p></section>${phaseSections}
<section class="gaps"><h2>产品验收阻断项</h2><ul>${evidence.productGaps.map((gap) => `<li>${h(gap)}</li>`).join('')}</ul></section>
<section class="overview"><h2>最终状态</h2><p>活跃充电订单：${evidence.finalState.activeChargingOrders} · 活跃占位费订单：${evidence.finalState.activeOccupancyOrders} · 新 Context 回到登录页：${evidence.finalState.freshContextReturnedToLogin ? '是' : '否'} · 模拟桩连接：${evidence.finalState.simulatorConnected ? '是' : '否'}</p><ul>${evidence.finalState.notes.map((note) => `<li>${h(note)}</li>`).join('')}</ul></section></main>
<footer>Account: ${h(evidence.accountRef)} · ${h(evidence.startedAt)} — ${h(evidence.finishedAt)} · Source hash verified</footer></body></html>`
}
