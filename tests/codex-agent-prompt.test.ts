import { describe, expect, it } from 'vitest'
import { agentTestFinalPrompt, codexTestAgentPrompt } from '../src/agent/prompt.js'
import { codexTestResultSchema } from '../src/agent/result.js'
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

describe('AgentHost test prompt safety rules', () => {
  it('makes the selected host the primary test engineer with raw inputs and full execution tools', () => {
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
    expect(prompt).toContain('before the first real business write on its first execution')
    expect(prompt).toContain('Do not perform a non-idempotent write outside the episode')
    expect(prompt).toContain("start the next case episode before that case's first action")
    expect(prompt).toContain('capture the reusable browser state outside the final case episode')
    expect(prompt).toContain('must not repeat the login flow because Core injects the capture')
    expect(prompt).toContain('capture it before the final episode so that episode records only the authenticated business path')
    expect(prompt).toContain('executionReceiptIds')
    expect(prompt).toContain('Do not use a receipt from another case')
    expect(prompt).toContain('infrastructure (provider, agent host CLI, browser, MCP, host, or network failure)')
    expect(prompt).not.toContain('659')
    expect(prompt).not.toContain('+65')
  })

  it('limits a long-suite context to the active execution epoch without inventing business semantics', () => {
    const workflow = manifest()
    workflow.phases = [
      { id: 'case-a', title: 'A', sourceRow: 2, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
    ]
    const prompt = codexTestAgentPrompt({
      manifest: workflow,
      environmentContext: '',
      secretAliases: [],
      executionEpoch: { id: 'epoch-0002', index: 1, total: 4, caseIds: ['case-a'], estimatedInputTokens: 500, estimatedOutputTokens: 900 },
      manifestPath: '/run/test-manifest.json',
      deliveryArtifactPath: '/run/case-results.epoch-0002.json',
    })

    expect(prompt).toContain('Execution epoch: epoch-0002 (2/4)')
    expect(prompt).toContain('Execute and report only these 1 case IDs')
    expect(prompt).toContain('/run/test-manifest.json')
    expect(prompt).toContain('/run/case-results.epoch-0002.json')
    expect(prompt).toContain('Do not execute them, classify them, or create placeholder outcomes')
    expect(prompt).toContain('outcome contract derived from the same source row')
  })

  it('spells out the strict final-result keys for schema-loose providers', () => {
    const prompt = agentTestFinalPrompt()
    const topLevelKeys = Object.keys(codexTestResultSchema.properties).join(', ')
    const caseKeys = Object.keys(codexTestResultSchema.properties.cases.items.properties).join(', ')
    const evidenceKeys = Object.keys(codexTestResultSchema.properties.cases.items.properties.evidence.items.properties).join(', ')

    expect(prompt).toContain(`Use only these top-level keys: ${topLevelKeys}.`)
    expect(prompt).toContain('Do not add caseIds, epoch, or mutationLedger')
    expect(prompt).toContain(`Use only these keys in every case: ${caseKeys}.`)
    expect(prompt).toContain('Do not add case-level blockers, productDefects, or nextActions')
    expect(prompt).toContain(`Every evidence item must contain exactly ${evidenceKeys}.`)
  })
})
