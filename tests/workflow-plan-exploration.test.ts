import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LocatorIR } from '../src/core/types.js'
import type { WorkflowLocatorResolver } from '../src/workflow/locator-resolver.js'
import { approveExploredWorkflowPlan, exploreWorkflowPlan, remainingWorkflowAmbiguities } from '../src/workflow/plan-exploration.js'
import type { WorkflowPlanDraft } from '../src/workflow/planner-types.js'
import { workflowDraftSha256 } from '../src/workflow/planner-validation.js'
import type {
  CaptureTableRowRequest,
  ClickAlignedTableActionRequest,
  WorkflowExplorationPageSession,
  WorkflowRuntimeDriver,
  WorkflowRuntimeTarget,
  WorkflowTableSpec,
} from '../src/workflow/runtime-types.js'

function draft(): WorkflowPlanDraft {
  return {
    version: '1.0',
    kind: 'workflow-plan-draft',
    workflowId: 'exploration-fixture',
    sourceSha256: 'a'.repeat(64),
    targets: [{ id: 'app', baseUrl: 'https://app.example.test/', allowedOrigins: ['https://app.example.test/'] }],
    dataBindings: [{ name: 'phone', source: 'secret', valueType: 'scalar', secretRef: 'workflow.phone' }],
    groups: [{
      id: 'single',
      phases: [{
        id: 'login',
        title: 'login',
        targetId: 'app',
        risk: 'read',
        contextMode: 'shared',
        sourceRefs: ['phase:login'],
        steps: [
          { id: 'open', kind: 'navigate', sourceRefs: ['phase:login'] },
          {
            id: 'fill-phone',
            kind: 'fill',
            target: {
              description: 'phone input',
              candidates: [{ strategy: 'placeholder', value: 'Phone', source: 'aiSuggested' }],
              sourceRefs: ['cell:B2'],
            },
            value: { valueRef: 'phone' },
            sourceRefs: ['cell:B2'],
          },
        ],
        assertions: [{ id: 'url-ok', kind: 'url', operator: 'contains', expected: { literal: 'app.example.test' }, sourceRefs: ['cell:C2'] }],
      }],
    }],
    policy: { phaseTimeoutMs: 10_000, actionTimeoutMs: 1_000, destructiveActions: 'requireApproval' },
    review: { status: 'draft', sourceRefs: ['source:fixture'], unresolvedAmbiguities: [] },
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

class FakeExplorationSession implements WorkflowExplorationPageSession {
  currentUrl = 'about:blank'
  filled: string[] = []
  errors: string[] = []
  choiceCandidates: string[] = []
  evidenceText = '- textbox "Phone"'
  waitInRealTime = false
  captureMissing = false
  setDefaultTimeout(): void {}
  async url(): Promise<string> { return this.currentUrl }
  async navigate(url: string): Promise<void> { this.currentUrl = url }
  async click(locator: LocatorIR): Promise<void> {
    if (locator.strategy === 'text' && locator.value === 'Send Code') this.errors = ['incorrect number format']
  }
  async fill(_locator: LocatorIR, value: string): Promise<void> { this.filled.push(value) }
  async press(): Promise<void> {}
  async check(): Promise<void> {}
  async ensureChecked(): Promise<void> {}
  async select(): Promise<void> {}
  async solveCaptcha(): Promise<void> {}
  async reload(): Promise<void> {}
  async wait(timeoutMs: number): Promise<void> {
    if (this.waitInRealTime) await new Promise((resolvePromise) => setTimeout(resolvePromise, timeoutMs))
  }
  async captureTableRow(_request: CaptureTableRowRequest): Promise<never> {
    if (this.captureMissing) throw new Error('Expected exactly one matching entity row; found 0')
    throw new Error('not used')
  }
  async clickAlignedTableAction(_request: ClickAlignedTableActionRequest): Promise<void> {}
  async tableRows(_table: WorkflowTableSpec): Promise<string[]> { return [] }
  async entityRow(): Promise<never> { throw new Error('not used') }
  async locatorText(): Promise<string> { return '' }
  async locatorState(): Promise<boolean> { return true }
  async locatorCount(locator: LocatorIR): Promise<number> { return locator.value === '.captcha' ? 0 : 1 }
  async inspectLocator(locator: LocatorIR) {
    return locator.strategy === 'placeholder' && locator.value === 'Phone'
      ? { count: 1, visible: true, enabled: true, editable: true }
      : locator.strategy === 'text' && locator.value === 'Send Code'
        ? { count: 1, visible: true, enabled: true, editable: false, clickable: true }
        : locator.strategy === 'css' && (locator.value === 'div.el-switch.is-checked' || locator.value === ':nth-match(div.el-switch, 1)')
          ? { count: 1, visible: true, enabled: true, editable: false, clickable: true }
      : { count: 0, visible: null, enabled: null, editable: null }
  }
  async applicationErrors(): Promise<string[]> { return this.errors }
  async pageEvidence() {
    return {
      url: this.currentUrl,
      title: 'Fixture',
      ariaSnapshot: this.evidenceText,
      applicationErrors: this.errors,
      choiceCandidates: this.choiceCandidates,
      interactiveElements: [{ tag: 'input', role: 'textbox', name: 'Phone', text: '', placeholder: 'Phone', testId: '', id: 'phone', href: '', css: '#phone', visible: true, enabled: true }],
      tableCandidates: [],
    }
  }
}

class FakeExplorationDriver implements WorkflowRuntimeDriver {
  readonly sessionValue = new FakeExplorationSession()
  async session(_key: string, _target: WorkflowRuntimeTarget) { return this.sessionValue }
  async closeSession(): Promise<void> {}
  async closeAll(): Promise<void> {}
}

const unusedResolver: WorkflowLocatorResolver = {
  name: 'unused',
  async resolve() { throw new Error('resolver should not be called for a valid planner candidate') },
}

describe('workflow plan exploration and approval', () => {
  it('promotes only Playwright-validated locator candidates and keeps approval explicit', async () => {
    const input = draft()
    const driver = new FakeExplorationDriver()
    const report = await exploreWorkflowPlan(input, driver, {
      resolver: unusedResolver,
      evidenceDirectory: '/tmp/auto-test-exploration-fixture',
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONE: 'synthetic-secret-phone' },
    })

    expect(report.status).toBe('passed')
    expect(report.locatorResolutions).toEqual([
      expect.objectContaining({
        targetId: 'fill-phone',
        resolutionSource: 'plannerCandidate',
        locator: expect.objectContaining({ strategy: 'placeholder', value: 'Phone', source: 'playwrightCli' }),
      }),
    ])
    expect(JSON.stringify(report)).not.toContain('synthetic-secret-phone')

    const approved = approveExploredWorkflowPlan(input, report, 'tester')
    expect(approved.review).toMatchObject({ status: 'approved', reviewedBy: 'tester' })
    expect(approved.groups[0]?.phases[0]?.steps[1]).toMatchObject({
      locator: { strategy: 'placeholder', value: 'Phone', source: 'playwrightCli' },
    })
  })

  it('does not charge live locator exploration against an unrealistically short runtime phase budget', async () => {
    const input = draft()
    input.policy.phaseTimeoutMs = 1
    input.policy.actionTimeoutMs = 1
    input.groups[0]!.phases[0]!.steps.push({ id: 'model-latency', kind: 'wait', timeoutMs: 5, sourceRefs: ['phase:login'] })
    const driver = new FakeExplorationDriver()
    driver.sessionValue.waitInRealTime = true

    const report = await exploreWorkflowPlan(input, driver, {
      resolver: unusedResolver,
      evidenceDirectory: '/tmp/auto-test-exploration-timeout-fixture',
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONE: 'synthetic-secret-phone' },
    })

    expect(report.status).toBe('passed')
  })

  it('does not require aligned-action tables for an idempotent cleanup entity that is absent', async () => {
    const input = draft()
    input.dataBindings.push({ name: 'deviceId', source: 'literal', valueType: 'scalar', value: 'DEVICE-1' })
    const phase = input.groups[0]!.phases[0]!
    phase.risk = 'destructive'
    phase.recovery = { strategy: 'retry', maxAttempts: 1, sourceRefs: ['policy:idempotent-cleanup'] }
    phase.steps = [
      { id: 'open-list', kind: 'navigate', sourceRefs: ['phase:login'] },
      {
        id: 'capture-device',
        kind: 'captureTableRow',
        entityName: 'device',
        table: { headerLabels: ['Device ID'], bodyOffset: 0, region: 'main' },
        match: [{ valueRef: 'deviceId' }],
        idPattern: '\\b(DEVICE-1)\\b',
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        sourceRefs: ['phase:login'],
      },
      {
        id: 'delete-device',
        kind: 'clickAlignedTableAction',
        entityName: 'device',
        dataTable: { headerLabels: ['Device ID'], bodyOffset: 0, region: 'main' },
        actionTable: { headerLabels: ['Operation'], bodyOffset: 0, region: 'fixedRight' },
        actionNames: ['Delete'],
        sourceRefs: ['phase:login'],
      },
    ]
    phase.assertions = [{
      id: 'device-absent',
      kind: 'tableRowCount',
      table: { headerLabels: ['Device ID'], bodyOffset: 0, region: 'main' },
      match: [{ valueRef: 'deviceId' }],
      expected: 0,
      sourceRefs: ['phase:login'],
    }]
    const driver = new FakeExplorationDriver()
    driver.sessionValue.captureMissing = true

    const report = await exploreWorkflowPlan(input, driver, {
      resolver: unusedResolver,
      evidenceDirectory: '/tmp/auto-test-optional-cleanup-fixture',
      allowDestructive: true,
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONE: 'synthetic-secret-phone' },
    })

    expect(report.status).toBe('passed')
    expect(report.unresolvedTableIds).toEqual([])
  })

  it('redacts profile secrets that are not referenced by the current draft', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-profile-secret-'))
    try {
      const input = draft()
      const driver = new FakeExplorationDriver()
      driver.sessionValue.evidenceText = '- textbox "Phone"\n- text "profile-only-secret"'
      const report = await exploreWorkflowPlan(input, driver, {
        resolver: unusedResolver,
        evidenceDirectory: directory,
        environment: {
          AUTO_TEST_SECRET_WORKFLOW_PHONE: 'synthetic-secret-phone',
          AUTO_TEST_SECRET_PROFILE_PASSWORD: 'profile-only-secret',
        },
      })

      const evidenceFiles = await readdir(directory)
      const evidence = await readFile(resolve(directory, evidenceFiles[0]!), 'utf8')
      expect(report.status).toBe('passed')
      expect(evidence).not.toContain('profile-only-secret')
      expect(evidence).toContain('<redacted-secret>')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('blocks for environment data when an opened choice list lacks the required option', async () => {
    const input = draft()
    input.groups[0]!.phases[0]!.steps = [{
      id: 'choose-device-type',
      kind: 'click',
      target: {
        description: 'visible device type option',
        candidates: [
          { strategy: 'role', value: 'option', name: 'Required Type', exact: true, source: 'aiSuggested' },
          { strategy: 'text', value: 'Required Type', exact: true, source: 'aiSuggested' },
        ],
        sourceRefs: ['cell:B2'],
      },
      sourceRefs: ['cell:B2'],
    }]
    input.groups[0]!.phases[0]!.assertions = [
      { id: 'still-on-app', kind: 'url', operator: 'contains', expected: { literal: 'app.example.test' }, sourceRefs: ['cell:C2'] },
    ]
    const driver = new FakeExplorationDriver()
    driver.sessionValue.choiceCandidates = ['Available Type A', 'Available Type B']

    const report = await exploreWorkflowPlan(input, driver, {
      resolver: unusedResolver,
      evidenceDirectory: '/tmp/auto-test-missing-choice-fixture',
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONE: 'fixture-phone' },
    })

    expect(report.status).toBe('failed')
    expect(report.runtimeResult.error).toContain('Required option is unavailable in the current environment')
    expect(report.runtimeResult.error).toContain('Available Type A')
  })

  it('rejects approval after the draft changes', async () => {
    const input = draft()
    const report = await exploreWorkflowPlan(input, new FakeExplorationDriver(), {
      resolver: unusedResolver,
      evidenceDirectory: '/tmp/auto-test-exploration-fixture',
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONE: 'synthetic-secret-phone' },
    })
    input.groups[0]!.phases[0]!.title = 'changed'
    expect(() => approveExploredWorkflowPlan(input, report, 'tester')).toThrow(/draft hash/i)
  })

  it('clears verified conditional-cleanup mechanics but preserves missing business oracles', () => {
    const input = draft()
    input.review.unresolvedAmbiguities = [
      '当前 DSL 没有条件分支，无法表达零匹配时继续，以及实体已停止时跳过停止。',
      'Expected settlement amount is not defined by the source case.',
    ]
    const report = {
      status: 'passed',
      runtimeResult: { status: 'passed' },
    } as never

    expect(remainingWorkflowAmbiguities(input, report)).toEqual([
      'Expected settlement amount is not defined by the source case.',
    ])
  })

  it('does not block a passed read-only smoke case on conservative coverage notes', () => {
    const input = draft()
    input.review.unresolvedAmbiguities = [
      'The source does not define which fields from the latest order row must be validated or their expected values; the plan therefore verifies that at least one row exists without capturing, selecting, or acting on an order.',
      'The brief references test_02 through test_04, but the supplied workflow intake contains no corresponding manifest phases, steps, preconditions, or immutable expected outcomes; those cases cannot be added without their source manifests.',
      'Expected settlement amount is not defined by the source case.',
    ]
    const report = {
      status: 'passed',
      runtimeResult: { status: 'passed' },
    } as never

    expect(remainingWorkflowAmbiguities(input, report)).toEqual([
      'Expected settlement amount is not defined by the source case.',
    ])
  })

  it('accepts an absent locator as valid evidence for locatorCount expected zero', async () => {
    const input = draft()
    input.groups[0]!.phases[0]!.assertions.push({
      id: 'no-captcha',
      kind: 'locatorCount',
      target: {
        description: 'graphical captcha',
        candidates: [{ strategy: 'css', value: '.captcha', source: 'aiSuggested' }],
        sourceRefs: ['cell:D2'],
      },
      expected: 0,
      sourceRefs: ['cell:D2'],
    })
    const report = await exploreWorkflowPlan(input, new FakeExplorationDriver(), {
      resolver: unusedResolver,
      evidenceDirectory: '/tmp/auto-test-exploration-fixture',
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONE: 'synthetic-secret-phone' },
    })

    expect(report.status).toBe('passed')
    expect(report.locatorResolutions).toContainEqual(expect.objectContaining({
      targetId: 'no-captcha',
      inspection: expect.objectContaining({ count: 0 }),
    }))
  })

  it('attributes a newly visible application error to the step that triggered it', async () => {
    const input = draft()
    input.groups[0]!.phases[0]!.steps.push({
      id: 'request-code',
      kind: 'click',
      target: {
        description: 'request verification code',
        candidates: [{ strategy: 'text', value: 'Send Code', exact: true, source: 'aiSuggested' }],
        sourceRefs: ['cell:C2'],
      },
      sourceRefs: ['cell:C2'],
    })
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-application-error-'))
    try {
      const report = await exploreWorkflowPlan(input, new FakeExplorationDriver(), {
        resolver: unusedResolver,
        evidenceDirectory: directory,
        environment: { AUTO_TEST_SECRET_WORKFLOW_PHONE: 'synthetic-secret-phone' },
      })

      expect(report.status).toBe('failed')
      expect(report.runtimeResult.steps.at(-1)).toMatchObject({
        stepId: 'request-code',
        status: 'failed',
        error: expect.stringMatching(/Application error after step request-code: incorrect number format/),
      })
      expect(report.runtimeResult.assertions).toHaveLength(0)
      const evidenceFile = (await readdir(directory)).find((name) => name.includes('request-code-application-error'))
      expect(evidenceFile).toBeTruthy()
      const evidence = await readFile(resolve(directory, evidenceFile!), 'utf8')
      expect(evidence).toContain('"applicationErrors"')
      expect(evidence).not.toContain('synthetic-secret-phone')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects state-dependent switch locators for ensureChecked', async () => {
    const input = draft()
    input.groups[0]!.phases[0]!.steps.push({
      id: 'ensure-switch-off',
      kind: 'ensureChecked',
      target: {
        description: 'first stable switch wrapper',
        candidates: [{ strategy: 'css', value: 'div.el-switch.is-checked', source: 'aiSuggested' }],
        sourceRefs: ['cell:D2'],
      },
      expected: false,
      sourceRefs: ['cell:D2'],
    })
    const resolver: WorkflowLocatorResolver = {
      name: 'stable-switch-fixture',
      async resolve(request) {
        expect(request.operation).toBe('ensureChecked')
        return {
          locator: { strategy: 'css', value: ':nth-match(div.el-switch, 1)', source: 'aiSuggested' },
          reasoning: 'Uses a stable wrapper without checked-state classes.',
        }
      },
    }

    const report = await exploreWorkflowPlan(input, new FakeExplorationDriver(), {
      resolver,
      evidenceDirectory: '/tmp/auto-test-stable-switch-fixture',
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONE: 'synthetic-secret-phone' },
    })

    expect(report.status).toBe('passed')
    expect(report.locatorResolutions).toContainEqual(expect.objectContaining({
      targetId: 'ensure-switch-off',
      resolutionSource: 'aiResolver',
      locator: expect.objectContaining({ value: ':nth-match(div.el-switch, 1)' }),
    }))
  })

  it('clears only live-resolvable technical ambiguities after a passed exploration', async () => {
    const input = draft()
    input.review.unresolvedAmbiguities = [
      '需要确认手机号是本地号码还是已包含国家码，并据此选择区号。',
      '需要业务确认退款订单是否应视为通过。',
    ]
    const report = await exploreWorkflowPlan(input, new FakeExplorationDriver(), {
      resolver: unusedResolver,
      evidenceDirectory: '/tmp/auto-test-ambiguity-fixture',
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONE: 'synthetic-secret-phone' },
    })

    expect(remainingWorkflowAmbiguities(input, report)).toEqual(['需要业务确认退款订单是否应视为通过。'])
    expect(() => approveExploredWorkflowPlan(input, report, 'tester')).toThrow(/unresolved business ambiguities/i)

    input.review.unresolvedAmbiguities = ['需要确认手机号是本地号码还是已包含国家码，并据此选择区号。']
    const compatible = { ...report, draftSha256: workflowDraftSha256(input) }
    expect(remainingWorkflowAmbiguities(input, compatible)).toEqual([])
    expect(() => approveExploredWorkflowPlan(input, compatible, 'tester')).not.toThrow()
  })

  it('persists directly validated table evidence into the approved execution plan', async () => {
    const input = draft()
    input.groups[0]!.phases[0]!.assertions.push({
      id: 'no-active-orders',
      kind: 'tableRowCount',
      table: { headerLabels: ['Order ID', 'Status'], bodyOffset: 0, region: 'main' },
      match: [{ literal: 'Charging' }],
      expected: 0,
      sourceRefs: ['cell:D2'],
    })
    const report = await exploreWorkflowPlan(input, new FakeExplorationDriver(), {
      resolver: unusedResolver,
      evidenceDirectory: '/tmp/auto-test-direct-table-fixture',
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONE: 'synthetic-secret-phone' },
    })

    expect(report.status).toBe('passed')
    expect(report.tableResolutions).toContainEqual(expect.objectContaining({
      targetId: 'no-active-orders:table',
      resolved: { headerLabels: ['Order ID', 'Status'], bodyOffset: 0, region: 'main' },
    }))
    const approved = approveExploredWorkflowPlan(input, report, 'tester')
    expect(JSON.stringify(approved)).not.toContain('__auto_test_draft_table__')
  })
})
