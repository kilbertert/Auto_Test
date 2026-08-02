import { describe, expect, it } from 'vitest'
import { codexTestAgentPrompt } from '../src/agent/prompt.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'

function manifest(): WorkflowIntakeManifest {
  return {
    version: '1.0',
    kind: 'workflow-intake',
    workflowId: 'prompt-fixture',
    source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'a'.repeat(64) },
    targetUrls: ['https://app.example.test/', 'https://admin.example.test/'],
    requiredCapabilities: ['multiOrigin', 'otpOrCaptcha'],
    phases: [],
    embeddedImages: [],
    supplementalImages: [],
    review: { status: 'draft', reasons: [] },
  }
}

describe('Codex test agent prompt safety rules', () => {
  it('declares origin access requests and generic composite-field evidence handling', () => {
    const prompt = codexTestAgentPrompt({
      manifest: manifest(),
      environmentContext: '',
      secretAliases: [{ secretRef: 'workflow.value', purpose: 'sensitive value', aliases: ['AUTO_TEST_VALUE_001'] }],
    })

    expect(prompt).toContain('request_environment_access')
    expect(prompt).toContain('Registered target origins (strict browser allowlist)')
    expect(prompt).toContain('do not duplicate a prefix')
    expect(prompt).toContain('at most one evidence-driven correction')
    expect(prompt).not.toContain('659')
  })
})
