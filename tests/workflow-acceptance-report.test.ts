import { describe, expect, it } from 'vitest'
import { buildWorkflowAcceptanceReport, renderWorkflowAcceptanceHtml } from '../src/workflow/acceptance-report.js'
import type { WorkflowAcceptanceEvidence, WorkflowIntakeManifest } from '../src/workflow/types.js'

const workflow: WorkflowIntakeManifest = {
  version: '1.0',
  kind: 'workflow-intake',
  workflowId: 'flow-1',
  source: { format: 'xlsx', fileName: 'flow.xlsx', sheetName: 'Flow', sha256: 'a'.repeat(64) },
  targetUrls: ['https://example.test/'],
  requiredCapabilities: ['multiOrigin'],
  phases: [],
  embeddedImages: [],
  supplementalImages: [],
  review: { status: 'draft', reasons: [] },
}

const evidence: WorkflowAcceptanceEvidence = {
  version: '1.0',
  workflowId: 'flow-1',
  sourceSha256: 'a'.repeat(64),
  mode: 'canary',
  startedAt: '2026-07-28T00:00:00.000Z',
  finishedAt: '2026-07-28T00:01:00.000Z',
  accountRef: 'workflow.accounts[0]',
  businessCanaryStatus: 'passed',
  productAcceptanceStatus: 'blocked',
  phases: [{
    phaseId: 'phase-1',
    title: '<script>phase</script>',
    sourceRefs: ['Flow row 2'],
    status: 'passed',
    assertions: [{ description: 'ended', passed: true, evidence: 'status=ended' }],
    observations: [],
  }],
  finalState: {
    activeChargingOrders: 0,
    activeOccupancyOrders: 0,
    freshContextReturnedToLogin: true,
    simulatorConnected: true,
    notes: [],
  },
  productGaps: ['executor missing'],
}

describe('workflow acceptance report', () => {
  it('checks intake integrity and summarizes evidence', () => {
    const report = buildWorkflowAcceptanceReport(workflow, evidence)
    expect(report.summary).toMatchObject({ phases: 1, passed: 1, assertions: 1, assertionsPassed: 1 })
    expect(() => buildWorkflowAcceptanceReport(workflow, { ...evidence, sourceSha256: 'b'.repeat(64) })).toThrow(/source hash/i)
  })

  it('escapes evidence in the static HTML report', () => {
    const html = renderWorkflowAcceptanceHtml(buildWorkflowAcceptanceReport(workflow, evidence))
    expect(html).toContain('&lt;script&gt;phase&lt;/script&gt;')
    expect(html).not.toContain('<script>phase</script>')
    expect(html).toContain('产品验收阻断项')
  })
})
