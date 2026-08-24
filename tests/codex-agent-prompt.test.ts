import { describe, expect, it } from 'vitest'
import { agentTestFinalPrompt, agentTestResumePrompt, codexTestAgentPrompt, compactCaseIndex } from '../src/agent/prompt.js'
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

function compactManifest(): WorkflowIntakeManifest {
  const workflow = manifest()
  workflow.phases = [{
    id: 'case-a',
    sourceCaseId: 'A-1',
    title: '登录后核对订单列表',
    sourceRow: 7,
    risk: 'write',
    steps: [{ id: 'step-a', sourceText: '打开订单列表并逐行核对金额与状态', confidence: 1 }],
    resources: [{ sourceCell: 'D7', text: 'https://app.example.test/orders', urls: ['https://app.example.test/orders'] }],
    secretBindings: [],
    imageIds: ['image-a'],
    outcome: { observable: ['订单列表展示已支付订单'], evidence: ['interaction', 'observation'], cleanup: ['删除本单创建的草稿订单'] },
    review: { status: 'draft', ambiguities: ['步骤顺序未在来源行中明确'] },
  }]
  workflow.embeddedImages = [{
    id: 'image-a', sheetName: 'Cases', sourceCell: 'E7', sourceRow: 7, fileName: 'image-a.png',
    mediaType: 'image/png', bytes: 2048, sha256: 'b'.repeat(64), reviewStatus: 'required',
  }]
  return workflow
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
    expect(prompt).not.toContain('subagents')
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

describe('compact execution context', () => {
  it('keeps immutable identity and source pointers without embedding the full manifest JSON', () => {
    const workflow = compactManifest()
    const index = compactCaseIndex(workflow)

    expect(index).toContain('workflowId prompt-fixture')
    expect(index).toContain('a'.repeat(64))
    expect(index).toContain('case-a')
    expect(index).toContain('source case id A-1')
    expect(index).toContain('登录后核对订单列表')
    expect(index).toContain('row 7')
    expect(index).toContain('write')
    expect(index).toContain('image-a')
    expect(index).toContain('outcome evidence interaction+observation')
    expect(index).toContain('1 intake ambiguity note(s)')
    // Source-row business text stays in the immutable manifest file; a turn
    // carries only the pointer to it.
    expect(index).not.toContain('打开订单列表并逐行核对金额与状态')
    expect(index).not.toContain('"steps"')
    expect(index).not.toContain('workflow-intake')
    expect(index.length).toBeLessThan(JSON.stringify(workflow, null, 2).length)
  })

  it('references the manifest file instead of re-embedding manifest JSON in both access modes', () => {
    const workflow = compactManifest()
    const phase = workflow.phases[0]!
    const embeddedImage = workflow.embeddedImages[0]!
    const base = {
      manifest: workflow,
      environmentContext: '',
      secretAliases: [],
      manifestPath: '/run/agent-workspace/test-manifest.json',
    }
    const direct = codexTestAgentPrompt({ ...base, testDataAccess: 'direct' })
    const restricted = codexTestAgentPrompt({ ...base, testDataAccess: 'opaque' })

    for (const prompt of [direct, restricted]) {
      expect(prompt).toContain('/run/agent-workspace/test-manifest.json')
      expect(prompt).toContain('read it from the workspace on demand')
      expect(prompt).toContain('workflowId prompt-fixture')
      expect(prompt).toContain('- case-a')
      expect(prompt).not.toContain('"kind": "workflow-intake"')
      expect(prompt).not.toContain('打开订单列表并逐行核对金额与状态')
      expect(prompt).not.toContain(JSON.stringify(phase, null, 2))
      expect(prompt).not.toContain(JSON.stringify(embeddedImage, null, 2))
    }
  })

  it('gives a replacement physical thread the stable workspace paths on resume', () => {
    const epoch = { id: 'epoch-0001', index: 0, total: 1, caseIds: ['case-a'], estimatedInputTokens: 10, estimatedOutputTokens: 10 }
    const prompt = agentTestResumePrompt(true, epoch, '/run/agent-workspace/case-results.epoch-0001.json', {
      inputDirectory: '/run/agent-workspace/input',
      sourceFilePath: '/run/agent-workspace/input/original/fixture.xlsx',
      manifestPath: '/run/agent-workspace/test-manifest.json',
      runValuesPath: '/run/.agent-private/run-values.json',
      checkpointPath: '/run/.agent-private/checkpoints/epoch-0001.json',
    })

    expect(prompt).toContain('/run/agent-workspace/input')
    expect(prompt).toContain('/run/agent-workspace/test-manifest.json')
    expect(prompt).toContain('/run/.agent-private/run-values.json')
    expect(prompt).toContain('/run/.agent-private/checkpoints/epoch-0001.json')
    expect(prompt).toContain('read these files on demand')

    // Without workspace pointers the resume prompt keeps its historical shape.
    expect(agentTestResumePrompt()).not.toContain('Unchanged run workspace paths')
  })
})
