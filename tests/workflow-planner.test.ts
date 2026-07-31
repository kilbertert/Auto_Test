import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LocatorIR } from '../src/core/types.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'
import type { WorkflowPlanDraft, WorkflowPlannerProvider } from '../src/workflow/planner-types.js'
import { workflowExplorationRefinementPrompt, workflowPlannerPrompt, workflowRecoveryPlanningPrompt } from '../src/workflow/planner-prompt.js'
import { parseWorkflowPlanJson, planWorkflow } from '../src/workflow/planner.js'
import { projectDraftToExecutionPlan, validateWorkflowPlanDraft } from '../src/workflow/planner-validation.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function draft(): WorkflowPlanDraft {
  return {
    version: '1.0',
    kind: 'workflow-plan-draft',
    workflowId: 'synthetic-workflow',
    sourceSha256: 'a'.repeat(64),
    targets: [{ id: 'app', baseUrl: 'https://app.example.test/', allowedOrigins: ['https://app.example.test/'] }],
    dataBindings: [{ name: 'phones', source: 'secret', valueType: 'stringList', secretRef: 'workflow.phones' }],
    groups: [{
      id: 'accounts',
      forEach: { valuesRef: 'phones', itemName: 'phone' },
      phases: [{
        id: 'login',
        title: 'login',
        targetId: 'app',
        risk: 'read',
        contextMode: 'freshPerIteration',
        sourceRefs: ['phase:login'],
        steps: [
          { id: 'open', kind: 'navigate', sourceRefs: ['phase:login'] },
          {
            id: 'fill-phone',
            kind: 'fill',
            target: {
              description: 'phone number input',
              candidates: [{ strategy: 'placeholder', value: 'Phone', source: 'aiSuggested' }],
              sourceRefs: ['cell:B2'],
            },
            value: { valueRef: 'phone' },
            sourceRefs: ['cell:B2'],
          },
        ],
        assertions: [{ id: 'login-visible', kind: 'url', operator: 'contains', expected: { literal: 'app.example.test' }, sourceRefs: ['cell:C2'] }],
      }],
    }],
    policy: { phaseTimeoutMs: 10_000, destructiveActions: 'requireApproval' },
    review: { status: 'draft', sourceRefs: ['source:synthetic'], unresolvedAmbiguities: [] },
    planner: {
      provider: 'fixture',
      model: null,
      generatedAt: '2026-07-28T00:00:00.000Z',
      inputSha256: 'b'.repeat(64),
      imageSha256s: [],
      summary: [],
    },
  }
}

describe('workflow planner validation', () => {
  it('accepts a complete object with only an extra closing array bracket from the model envelope', () => {
    expect(parseWorkflowPlanJson('{"kind":"workflow-plan-draft"}]')).toEqual({ kind: 'workflow-plan-draft' })
    expect(() => parseWorkflowPlanJson('{"kind":"workflow-plan-draft"} trailing')).toThrow()
  })

  it('keeps model output in draft state and projects it into the validated runtime DSL', () => {
    const value = validateWorkflowPlanDraft(draft())
    const projected = projectDraftToExecutionPlan(value)
    expect(value.review.status).toBe('draft')
    expect(projected.review.status).toBe('approved')
    expect(projected.groups[0]?.phases[0]?.steps[1]).toMatchObject({
      kind: 'fill',
      locator: { source: 'aiSuggested' },
    })
  })

  it('rejects plaintext sensitive data and untraceable planner targets', () => {
    const withPhone = draft()
    withPhone.dataBindings.push({ name: 'bad', source: 'literal', valueType: 'scalar', value: '+6598765432' })
    expect(() => validateWorkflowPlanDraft(withPhone)).toThrow(/plaintext sensitive data/i)

    const withoutRefs = draft()
    const step = withoutRefs.groups[0]!.phases[0]!.steps[1]!
    if (step.kind === 'fill') step.target.sourceRefs = []
    expect(() => validateWorkflowPlanDraft(withoutRefs)).toThrow(/source references/i)
  })

  it('rejects an authentication phase that discards the session before shared dependent phases', () => {
    const input = draft()
    const login = input.groups[0]!.phases[0]!
    login.contextMode = 'freshPhase'
    input.groups[0]!.phases.push({
      id: 'dashboard',
      title: 'open dashboard',
      targetId: 'app',
      risk: 'read',
      contextMode: 'shared',
      sourceRefs: ['phase:dashboard'],
      steps: [{ id: 'open-dashboard', kind: 'navigate', sourceRefs: ['phase:dashboard'] }],
      assertions: [{ id: 'dashboard-visible', kind: 'url', operator: 'contains', expected: { literal: 'dashboard' }, sourceRefs: ['phase:dashboard'] }],
    })

    expect(() => validateWorkflowPlanDraft(input)).toThrow(/authentication phase login uses freshPhase.*expects a shared session/i)
  })

  it('allows a self-contained fresh authentication phase without dereferencing a missing dependent phase', () => {
    const input = draft()
    input.groups[0]!.phases[0]!.contextMode = 'freshPhase'

    expect(() => validateWorkflowPlanDraft(input)).not.toThrow()
  })

  it('defers only transient success messages when a later phase has a durable entity oracle', () => {
    const input = draft()
    const create = input.groups[0]!.phases[0]!
    create.risk = 'write'
    create.assertions = [{
      id: 'created-toast',
      kind: 'locatorState',
      target: {
        description: '设备创建成功提示',
        candidates: [{ strategy: 'css', value: '.el-message--success', source: 'aiSuggested' }],
        sourceRefs: ['cell:C2'],
      },
      expected: 'visible',
      sourceRefs: ['cell:C2'],
    }]
    input.groups[0]!.phases.push({
      id: 'verify-device',
      title: 'verify device',
      targetId: 'app',
      risk: 'read',
      contextMode: 'freshPerIteration',
      sourceRefs: ['phase:verify'],
      steps: [{
        id: 'capture-device',
        kind: 'captureTableRow',
        entityName: 'device',
        table: { headerLabels: ['Device ID'], bodyOffset: 0 },
        match: [{ literal: 'DEVICE-1' }],
        idPattern: '\\b(DEVICE-1)\\b',
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        sourceRefs: ['cell:D2'],
      }],
      assertions: [{
        id: 'device-name',
        kind: 'entityText',
        entityName: 'device',
        operator: 'contains',
        expected: { literal: 'DEVICE-1' },
        sourceRefs: ['cell:E2'],
      }],
    })

    const value = validateWorkflowPlanDraft(input)
    expect(value.groups[0]!.phases[0]!.assertions[0]).toMatchObject({
      id: 'created-toast',
      kind: 'url',
      expected: { literal: 'https://app.example.test' },
    })
  })

  it('derives terminal-state exclusions from exact entity assertions', () => {
    const input = draft()
    const phase = input.groups[0]!.phases[0]!
    phase.steps.push({
      id: 'capture-order',
      kind: 'captureTableRow',
      entityName: 'order',
      table: { headerLabels: ['Order ID', 'Status'], bodyOffset: 0 },
      match: [{ valueRef: 'phone' }, { literal: 'Charging' }],
      idPattern: '\\b(\\d+)\\b',
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      sourceRefs: ['cell:D2'],
    })
    phase.assertions.push(
      { id: 'order-complete', kind: 'entityText', entityName: 'order', operator: 'equals', expected: { literal: 'Charging complete' }, sourceRefs: ['cell:E2'] },
      { id: 'no-active-order', kind: 'tableRowCount', table: { headerLabels: ['Order ID', 'Status'], bodyOffset: 0 }, match: [{ literal: 'Charging' }], expected: 0, sourceRefs: ['cell:F2'] },
    )

    const value = validateWorkflowPlanDraft(input)
    const capture = value.groups[0]!.phases[0]!.steps.find((step) => step.kind === 'captureTableRow')
    const audit = value.groups[0]!.phases[0]!.assertions.find((assertion) => assertion.kind === 'tableRowCount')
    expect(capture).toMatchObject({ exclude: [{ literal: 'Charging complete' }] })
    expect(audit).toMatchObject({ exclude: [{ literal: 'Charging complete' }] })
  })

  it('canonicalizes captured entity ID shorthand without overriding a real binding', () => {
    const input = draft()
    const phase = input.groups[0]!.phases[0]!
    phase.steps.push(
      {
        id: 'capture-order',
        kind: 'captureTableRow',
        entityName: 'order',
        table: { headerLabels: ['Order ID'], bodyOffset: 0 },
        match: [{ valueRef: 'phone' }],
        idPattern: '\\b(\\d+)\\b',
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        sourceRefs: ['cell:D2'],
      },
      {
        id: 'capture-fee',
        kind: 'captureTableRow',
        entityName: 'fee',
        table: { headerLabels: ['Charging Order ID'], bodyOffset: 0 },
        match: [{ valueRef: 'order.id' }],
        idPattern: '\\b(\\d+)\\b',
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        sourceRefs: ['cell:E2'],
      },
    )

    const value = validateWorkflowPlanDraft(input)
    const capture = value.groups[0]!.phases[0]!.steps.find((step) => step.id === 'capture-fee')
    expect(capture).toMatchObject({ match: [{ valueRef: 'entities.order.id' }] })

    const withBinding = draft()
    withBinding.dataBindings.push({ name: 'order.id', source: 'literal', valueType: 'scalar', value: 'fixture-order' })
    const bindingPhase = withBinding.groups[0]!.phases[0]!
    bindingPhase.steps.push(
      {
        id: 'capture-order',
        kind: 'captureTableRow',
        entityName: 'order',
        table: { headerLabels: ['Order ID'], bodyOffset: 0 },
        match: [{ valueRef: 'phone' }],
        idPattern: '\\b(\\d+)\\b',
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        sourceRefs: ['cell:D2'],
      },
      {
        id: 'capture-fee',
        kind: 'captureTableRow',
        entityName: 'fee',
        table: { headerLabels: ['Charging Order ID'], bodyOffset: 0 },
        match: [{ valueRef: 'order.id' }],
        idPattern: '\\b(\\d+)\\b',
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        sourceRefs: ['cell:E2'],
      },
    )
    const bindingValue = validateWorkflowPlanDraft(withBinding)
    const bindingCapture = bindingValue.groups[0]!.phases[0]!.steps.find((step) => step.id === 'capture-fee')
    expect(bindingCapture).toMatchObject({ match: [{ valueRef: 'order.id' }] })
  })

  it('canonicalizes a select option alias into the runtime value operand', () => {
    const input = draft()
    const phase = input.groups[0]!.phases[0]!
    phase.steps.push({
      id: 'select-country',
      kind: 'select',
      target: { description: 'country selector', candidates: [], sourceRefs: ['cell:D2'] },
      value: { literal: 'fixture-country' },
      sourceRefs: ['cell:D2'],
    })
    const raw = phase.steps.at(-1) as unknown as Record<string, unknown>
    raw.option = raw.value
    delete raw.value

    const value = validateWorkflowPlanDraft(input)

    expect(value.groups[0]!.phases[0]!.steps.at(-1)).toMatchObject({
      kind: 'select',
      value: { literal: 'fixture-country' },
    })
  })

  it('canonicalizes a recovery kind alias into its strategy', () => {
    const input = draft()
    const phase = input.groups[0]!.phases[0]!
    phase.risk = 'write'
    phase.recovery = { strategy: 'retry', maxAttempts: 1, sourceRefs: ['policy:idempotent'] }
    const raw = phase.recovery as unknown as Record<string, unknown>
    raw.kind = raw.strategy
    delete raw.strategy

    const value = validateWorkflowPlanDraft(input)

    expect(value.groups[0]!.phases[0]!.recovery).toMatchObject({
      strategy: 'retry',
      maxAttempts: 1,
    })
  })

  it('projects both captcha locators from exploration evidence', () => {
    const input = draft()
    const phase = input.groups[0]!.phases[0]!
    phase.steps.push({
      id: 'solve-captcha',
      kind: 'solveCaptcha',
      imageTarget: { description: 'captcha image', candidates: [], sourceRefs: ['cell:D2'] },
      inputTarget: { description: 'captcha input', candidates: [], sourceRefs: ['cell:D2'] },
      sourceRefs: ['cell:D2'],
    })
    const image: LocatorIR = { strategy: 'css', value: 'img.captcha', source: 'manual' }
    const inputLocator: LocatorIR = { strategy: 'label', value: 'Captcha', source: 'manual' }
    const projected = projectDraftToExecutionPlan(validateWorkflowPlanDraft(input), new Map([
      ['solve-captcha:image', image],
      ['solve-captcha:input', inputLocator],
    ]))

    expect(projected.groups[0]!.phases[0]!.steps.at(-1)).toMatchObject({
      kind: 'solveCaptcha',
      imageLocator: image,
      inputLocator,
    })
  })

  it('does not allow an intake manifest type to masquerade as a plan draft', () => {
    const intake = { version: '1.0', kind: 'workflow-intake' } as unknown as WorkflowIntakeManifest
    expect(() => validateWorkflowPlanDraft(intake)).toThrow(/planner metadata/i)
  })

  it('does not return an earlier draft that failed manifest phase coverage', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-planner-validation-'))
    temporaryDirectories.push(directory)
    const input = draft()
    const { planner: _planner, ...body } = input
    const manifest: WorkflowIntakeManifest = {
      version: '1.0',
      kind: 'workflow-intake',
      workflowId: input.workflowId,
      source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: input.sourceSha256 },
      targetUrls: ['https://app.example.test/'],
      requiredCapabilities: [],
      phases: [
        { id: 'login', title: 'login', sourceRow: 2, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
        { id: 'audit', title: 'audit', sourceRow: 3, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
      ],
      embeddedImages: [],
      supplementalImages: [],
      review: { status: 'draft', reasons: [] },
    }
    const provider: WorkflowPlannerProvider = {
      name: 'fixture',
      model: null,
      async generate() { return { planJson: JSON.stringify(body), summary: [] } },
      async repair() { return { planJson: '{"broken":', summary: [] } },
    }

    await expect(planWorkflow({
      manifest,
      mediaDirectory: directory,
      workspaceDirectory: directory,
      provider,
      initialResponse: { planJson: JSON.stringify(body), summary: [] },
    })).rejects.toThrow()
  })

  it('tells planners to preserve secret input semantics and attribute application errors to their trigger', () => {
    const initial = workflowPlannerPrompt({
      manifest: {},
      brief: '',
      imagePaths: [],
      imageSha256s: [],
      inputSha256: 'a'.repeat(64),
      workspaceDirectory: '/tmp/planner-prompt',
    })
    const refinement = workflowExplorationRefinementPrompt('{}', '{}', '{}')
    const recovery = workflowRecoveryPlanningPrompt('{}')

    expect(initial).toContain('not permission to request or resend a code')
    expect(initial).toContain('Home/Delete/Backspace')
    expect(initial).toContain('visible, hidden, enabled, or checked')
    expect(initial).toContain('Never invent delete, cleanup, reset, stop, rollback, retry')
    expect(refinement).toContain('Application error after step <id>')
    expect(refinement).toContain('reveal no prefix, length, or format information')
    expect(refinement).toContain('does not imply that Send/Get/Resend Code must be clicked')
    expect(recovery).toContain('Never invent idempotency, retry safety, cleanup authority')
    expect(recovery).toContain('leave recovery absent')
  })
})
