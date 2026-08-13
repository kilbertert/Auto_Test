import { describe, expect, it } from 'vitest'
import { selectSkillBriefs, skillBriefContext } from '../src/agent/skill-brief.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'

function manifest(capabilities: WorkflowIntakeManifest['requiredCapabilities'] = []): WorkflowIntakeManifest {
  return {
    version: '1.0', kind: 'workflow-intake', workflowId: 'brief-fixture',
    source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'a'.repeat(64) },
    targetUrls: ['https://example.test/'], requiredCapabilities: capabilities,
    phases: [], embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
  }
}

describe('scenario skill brief selection', () => {
  it('selects no briefs when no capability signal is present', () => {
    expect(selectSkillBriefs(manifest())).toEqual([])
  })

  it('loads table and multi-origin briefs only when their capabilities are present', () => {
    const selected = selectSkillBriefs(manifest(['runtimeEntityCapture', 'multiOrigin']))
    expect(selected.map((brief) => brief.id)).toEqual(['table-entity-identification', 'multi-origin-session'])
  })

  it('renders a stable, secret-free context section', () => {
    const selected = selectSkillBriefs(manifest(['scheduledWait']))
    const context = skillBriefContext(selected)
    expect(context).toContain('异步等待规则')
    expect(context).not.toContain('${')
    expect(skillBriefContext([])).toContain('没有匹配')
  })
})
