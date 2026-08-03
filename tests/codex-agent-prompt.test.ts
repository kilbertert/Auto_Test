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
  it('makes Codex the primary test engineer with raw inputs and full execution tools', () => {
    const prompt = codexTestAgentPrompt({
      manifest: manifest(),
      environmentContext: '',
      secretAliases: [{
        secretRef: 'workflow.value', purpose: 'sensitive value', aliases: ['AUTO_TEST_VALUE_001'],
      }],
      testDataAccess: 'direct',
      inputDirectory: '/run/input',
      sourceFilePath: '/run/input/original/fixture.xlsx',
      runValuesPath: '/run/input/run-values.json',
    })

    expect(prompt).toContain('primary test engineer')
    expect(prompt).toContain('shell commands')
    expect(prompt).toContain('browser_run_code_unsafe')
    expect(prompt).toContain('/run/input/original/fixture.xlsx')
    expect(prompt).toContain('/run/input/run-values.json')
    expect(prompt).toContain('context, not a browser network allowlist')
    expect(prompt).toContain('test_plan_update is optional')
    expect(prompt).toContain('field_composition_check')
    expect(prompt).toContain('optional diagnostic helpers, not execution gates')
    expect(prompt).toContain("kind 'case-results'")
    expect(prompt).toContain('evidencePaths (existing workspace-relative paths)')
    expect(prompt).toContain('case_execution_begin')
    expect(prompt).toContain('executionReceiptIds')
    expect(prompt).toContain('Do not use a receipt from another case')
    expect(prompt).toContain('infrastructure (provider, Codex CLI, browser, MCP, host, or network failure)')
    expect(prompt).not.toContain('659')
    expect(prompt).not.toContain('+65')
  })
})
