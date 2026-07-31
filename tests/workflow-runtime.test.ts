import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LocatorIR } from '../src/core/types.js'
import { executeWorkflow, workflowResumeTarget } from '../src/workflow/runtime-engine.js'
import { assessMutationRecovery } from '../src/workflow/failure-diagnosis.js'
import { WorkflowStateStore } from '../src/workflow/runtime-state.js'
import { alignedActionRowIndex, entityAlreadyStoppedForAction, missingTableHeaderLabels, selectUniqueEntityRow } from '../src/workflow/table-entities.js'
import type {
  CaptureTableRowRequest,
  ClickAlignedTableActionRequest,
  WorkflowExecutionResult,
  WorkflowExecutionPlan,
  WorkflowPageSession,
  WorkflowRuntimeDriver,
  WorkflowRuntimeTarget,
  WorkflowTableSpec,
} from '../src/workflow/runtime-types.js'
import { validateWorkflowExecutionPlan } from '../src/workflow/runtime-validation.js'
import { WorkflowPreActionError } from '../src/workflow/workflow-errors.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const button = (name: string): LocatorIR => ({ strategy: 'role', value: 'button', name, source: 'manual' })
const textbox = (name: string): LocatorIR => ({ strategy: 'role', value: 'textbox', name, source: 'manual' })
const dataTable: WorkflowTableSpec = { headerLabels: ['Order ID', 'Phone'], bodyOffset: 0 }
const actionTable: WorkflowTableSpec = { headerLabels: ['Operation'], bodyOffset: 0 }

interface FakeBehavior {
  failClickOnce?: boolean
  failClicksRemaining?: number
  failBeforeClickOnce?: boolean
  failBeforeClickAfter?: number
  leaveOriginOnClick?: boolean
  urlOverride?: string
  liveEntityStatus?: string
  entityCellPrefix?: string
  captureMissing?: boolean
  pressedKeys?: string[]
  captchaSolves?: string[]
  navigatedUrls?: string[]
  clickError?: string
}

class FakeSession implements WorkflowPageSession {
  currentUrl = 'about:blank'
  capturedRow = ''
  fills: string[] = []
  presses: string[] = []
  actions: ClickAlignedTableActionRequest[] = []
  captchaSolves = 0
  timeout = 0
  private successfulClicksBeforePreActionFailure = 0

  constructor(
    private readonly target: WorkflowRuntimeTarget,
    private readonly behavior: FakeBehavior = {},
  ) {}

  private shouldFailClick(): boolean {
    if ((this.behavior.failClicksRemaining ?? 0) > 0) {
      this.behavior.failClicksRemaining = (this.behavior.failClicksRemaining ?? 0) - 1
      return true
    }
    if (!this.behavior.failClickOnce) return false
    this.behavior.failClickOnce = false
    return true
  }

  private shouldFailBeforeClick(): boolean {
    if (this.behavior.failBeforeClickOnce) {
      this.behavior.failBeforeClickOnce = false
      return true
    }
    if (this.behavior.failBeforeClickAfter === undefined) return false
    if (this.successfulClicksBeforePreActionFailure < this.behavior.failBeforeClickAfter) {
      this.successfulClicksBeforePreActionFailure += 1
      return false
    }
    delete this.behavior.failBeforeClickAfter
    return true
  }

  setDefaultTimeout(timeoutMs: number): void { this.timeout = timeoutMs }
  async url(): Promise<string> { return this.behavior.urlOverride ?? this.currentUrl }
  async navigate(url: string): Promise<void> {
    this.currentUrl = url
    this.behavior.navigatedUrls?.push(url)
  }
  async click(): Promise<void> {
    if (this.shouldFailBeforeClick()) {
      throw new WorkflowPreActionError('Locator resolver found no valid live element: synthetic pre-action failure')
    }
    if (this.shouldFailClick()) {
      throw new Error(this.behavior.clickError ?? 'click failed while handling synthetic-secret-phone')
    }
    if (this.behavior.leaveOriginOnClick) this.currentUrl = 'https://outside.example.test/'
  }
  async fill(_locator: LocatorIR, value: string): Promise<void> { this.fills.push(value) }
  async press(_locator: LocatorIR, key: string): Promise<void> {
    this.presses.push(key)
    this.behavior.pressedKeys?.push(key)
  }
  async check(): Promise<void> {}
  async ensureChecked(): Promise<void> {}
  async select(): Promise<void> {}
  async solveCaptcha(): Promise<void> {
    this.captchaSolves += 1
    this.behavior.captchaSolves?.push(this.target.id)
  }
  async reload(): Promise<void> {}
  async wait(): Promise<void> {}
  async captureTableRow(request: CaptureTableRowRequest) {
    if (this.behavior.captureMissing) throw new Error('Expected exactly one matching entity row; found 0')
    const id = `${this.target.id === 'h5' ? '2' : '3'}${'0'.repeat(18)}`
    this.capturedRow = `${id} ${request.match.join(' ')} Charging`
    const selected = selectUniqueEntityRow([this.capturedRow], request.match, new RegExp(request.idPattern), request.exclude)
    return { ...selected, table: request.table, capturedAt: new Date(0).toISOString() }
  }
  async clickAlignedTableAction(request: ClickAlignedTableActionRequest): Promise<void> {
    if (this.shouldFailBeforeClick()) {
      throw new WorkflowPreActionError('Locator resolver found no valid live element: synthetic pre-action failure')
    }
    if (this.shouldFailClick()) {
      throw new Error('click failed while handling synthetic-secret-phone')
    }
    alignedActionRowIndex([this.capturedRow], ['Force Stop'], request.entityId, request.actionNames)
    this.actions.push(request)
    if (this.behavior.leaveOriginOnClick) this.currentUrl = 'https://outside.example.test/'
  }
  async tableRows(table: WorkflowTableSpec): Promise<string[]> {
    return table.headerLabels.includes('Operation') ? ['Force Stop'] : this.capturedRow ? [this.capturedRow] : []
  }
  async entityRow(_table: WorkflowTableSpec, entityId: string) {
    if (!this.capturedRow.includes(entityId)) throw new Error('captured entity row is missing')
    const rowText = this.behavior.liveEntityStatus
      ? this.capturedRow.replace(/Charging$/, this.behavior.liveEntityStatus)
      : this.capturedRow
    return { rowText, cells: [`${this.behavior.entityCellPrefix ?? ''}${entityId}`, this.behavior.liveEntityStatus ?? 'Charging'] }
  }
  async locatorText(): Promise<string> { return 'Charging' }
  async locatorState(): Promise<boolean> { return true }
  async locatorCount(): Promise<number> { return 1 }
}

class FakeDriver implements WorkflowRuntimeDriver {
  readonly sessions = new Map<string, FakeSession>()
  readonly requestedKeys: string[] = []
  readonly closedKeys: string[] = []
  closeAllCalled = false

  constructor(private readonly behavior: FakeBehavior = {}) {}

  async session(key: string, target: WorkflowRuntimeTarget): Promise<WorkflowPageSession> {
    this.requestedKeys.push(key)
    let session = this.sessions.get(key)
    if (!session) {
      session = new FakeSession(target, this.behavior)
      this.sessions.set(key, session)
    }
    return session
  }

  async closeSession(key: string): Promise<void> {
    if (this.sessions.delete(key)) this.closedKeys.push(key)
  }

  async closeAll(): Promise<void> {
    this.closeAllCalled = true
    for (const key of [...this.sessions.keys()]) await this.closeSession(key)
  }
}

function basePlan(): WorkflowExecutionPlan {
  return {
    version: '1.0',
    kind: 'workflow-execution-plan',
    workflowId: 'charging-workflow',
    sourceSha256: 'a'.repeat(64),
    targets: [{ id: 'h5', baseUrl: 'https://h5.example.test/', allowedOrigins: ['https://h5.example.test/'] }],
    dataBindings: [
      { name: 'phones', source: 'secret', valueType: 'stringList', secretRef: 'workflow.phones' },
      { name: 'connector', source: 'literal', valueType: 'scalar', value: 'DEVICE-1' },
    ],
    groups: [{
      id: 'accounts',
      forEach: { valuesRef: 'phones', itemName: 'phone' },
      phases: [{
        id: 'start-and-stop',
        title: 'start and stop',
        targetId: 'h5',
        risk: 'destructive',
        contextMode: 'freshPerIteration',
        steps: [
          { id: 'navigate-h5', kind: 'navigate' },
          { id: 'fill-phone', kind: 'fill', locator: textbox('Phone'), value: { valueRef: 'phone' } },
          {
            id: 'capture-order',
            kind: 'captureTableRow',
            entityName: 'chargingOrder',
            table: dataTable,
            match: [{ valueRef: 'phone' }, { valueRef: 'connector' }],
            idPattern: '\\b(\\d{19})\\b',
            timeoutMs: 1_000,
            pollIntervalMs: 10,
          },
          {
            id: 'stop-order',
            kind: 'clickAlignedTableAction',
            entityName: 'chargingOrder',
            dataTable,
            actionTable,
            actionNames: ['Force Stop'],
          },
        ],
        assertions: [
          { id: 'order-is-charging', kind: 'entityText', entityName: 'chargingOrder', operator: 'contains', expected: { literal: 'Charging' } },
          { id: 'one-order', kind: 'tableRowCount', table: dataTable, match: [{ valueRef: 'phone' }], expected: 1 },
        ],
      }],
    }],
    policy: { phaseTimeoutMs: 10_000, destructiveActions: 'requireApproval' },
    review: {
      status: 'approved',
      reviewedBy: 'tester',
      reviewedAt: '2026-07-28T00:00:00.000Z',
      sourceRefs: ['synthetic fixture'],
      unresolvedAmbiguities: [],
    },
  }
}

async function stateStore(): Promise<WorkflowStateStore> {
  const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-runtime-'))
  temporaryDirectories.push(directory)
  return new WorkflowStateStore(resolve(directory, 'workflow.state.json'))
}

describe('workflow runtime engine', () => {
  it('matches live table headers without depending on locale capitalization or whitespace', () => {
    const header = 'Order Number   User Information\nPartner  Payment Method'
    expect(missingTableHeaderLabels(header, ['order number', 'user information', 'partner'])).toEqual([])
    expect(missingTableHeaderLabels(header, ['Order Number', 'Missing Column'])).toEqual(['Missing Column'])
  })

  it('executes a keyboard press against a resolved locator', async () => {
    const plan = basePlan()
    plan.dataBindings = []
    delete plan.groups[0]!.forEach
    const phase = plan.groups[0]!.phases[0]!
    phase.risk = 'read'
    phase.contextMode = 'shared'
    phase.steps = [
      { id: 'navigate-h5', kind: 'navigate' },
      { id: 'submit-phone', kind: 'press', locator: textbox('Phone'), key: 'Enter' },
    ]
    phase.assertions = [{ id: 'login-page', kind: 'url', operator: 'contains', expected: { literal: 'h5.example.test' } }]
    const pressedKeys: string[] = []
    const driver = new FakeDriver({ pressedKeys })

    const result = await executeWorkflow(plan, driver, { environment: {} })

    expect(result.status, result.error).toBe('passed')
    expect(pressedKeys).toEqual(['Enter'])
  })

  it('supports a hidden locator state assertion', async () => {
    const plan = basePlan()
    plan.dataBindings = []
    delete plan.groups[0]!.forEach
    const phase = plan.groups[0]!.phases[0]!
    phase.risk = 'read'
    phase.steps = [{ id: 'navigate-h5', kind: 'navigate' }]
    phase.assertions = [{ id: 'login-hidden', kind: 'locatorState', locator: textbox('Username'), expected: 'hidden' }]

    const result = await executeWorkflow(plan, new FakeDriver(), { environment: {} })

    expect(result.status, result.error).toBe('passed')
  })

  it('executes a dynamic captcha step without persisting the solved code', async () => {
    const plan = basePlan()
    plan.dataBindings = []
    delete plan.groups[0]!.forEach
    const phase = plan.groups[0]!.phases[0]!
    phase.risk = 'read'
    phase.steps = [
      { id: 'open-login', kind: 'navigate' },
      { id: 'solve-login-captcha', kind: 'solveCaptcha', imageLocator: { strategy: 'css', value: 'img.captcha', source: 'manual' }, inputLocator: textbox('Captcha') },
    ]
    phase.assertions = [{ id: 'login-page', kind: 'url', operator: 'contains', expected: { literal: 'h5.example.test' } }]
    const captchaSolves: string[] = []
    const driver = new FakeDriver({ captchaSolves })

    const result = await executeWorkflow(plan, driver, { environment: {} })

    expect(result.status).toBe('passed')
    expect(captchaSolves).toEqual(['h5'])
    expect(JSON.stringify(result)).not.toContain('captcha-code')
  })

  it('serializes account iterations, isolates contexts and never persists matched secret row text', async () => {
    const store = await stateStore()
    const driver = new FakeDriver()
    const result = await executeWorkflow(basePlan(), driver, {
      allowDestructive: true,
      stateStore: store,
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONES: '["synthetic-phone-a","synthetic-phone-b"]' },
    })

    expect(result.status).toBe('passed')
    expect(result.phases).toHaveLength(2)
    expect(result.steps).toHaveLength(8)
    expect(result.assertions).toHaveLength(4)
    expect(Object.keys(result.entities)).toEqual([
      'accounts[0].chargingOrder',
      'accounts[1].chargingOrder',
    ])
    expect(JSON.stringify(result)).not.toContain('synthetic-phone')
    expect(driver.requestedKeys).toEqual([
      'iteration:accounts:0:h5',
      'iteration:accounts:1:h5',
    ])
    expect(driver.closedKeys).toEqual(expect.arrayContaining(driver.requestedKeys))
    await expect(access(store.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('re-reads a captured entity row before evaluating an exact cell assertion', async () => {
    const plan = basePlan()
    plan.groups[0]!.phases[0]!.assertions = [{
      id: 'order-is-still-charging',
      kind: 'entityText',
      entityName: 'chargingOrder',
      field: '状态',
      operator: 'equals',
      expected: { literal: 'Charging' },
    }]
    const result = await executeWorkflow(plan, new FakeDriver({ liveEntityStatus: 'Charging complete' }), {
      allowDestructive: true,
      stateStore: await stateStore(),
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' },
    })

    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('cell equal') })
  })

  it('uses a unique exact cell fallback when a captured table spec is only a header subset', async () => {
    const plan = basePlan()
    const phase = plan.groups[0]!.phases[0]!
    const capture = phase.steps.find((step) => step.kind === 'captureTableRow')!
    if (capture.kind !== 'captureTableRow') throw new Error('fixture capture is unavailable')
    capture.table = { headerLabels: ['Status'], bodyOffset: 0 }
    phase.assertions = [{
      id: 'status-is-charging',
      kind: 'entityText',
      entityName: 'chargingOrder',
      field: 'Status',
      operator: 'equals',
      expected: { literal: 'Charging' },
    }]

    const result = await executeWorkflow(plan, new FakeDriver(), {
      allowDestructive: true,
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' },
    })

    expect(result.status, result.error).toBe('passed')
  })

  it('accepts a complete entity ID inside static UI decoration without weakening literal equality', async () => {
    const referenced = basePlan()
    referenced.groups[0]!.phases[0]!.assertions = [{
      id: 'linked-order',
      kind: 'entityText',
      entityName: 'chargingOrder',
      field: 'Associated Charging Order',
      operator: 'equals',
      expected: { valueRef: 'entities.chargingOrder.id' },
    }]
    const environment = { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' }
    const referencedResult = await executeWorkflow(referenced, new FakeDriver({ entityCellPrefix: 'Order details:' }), {
      allowDestructive: true,
      environment,
    })
    expect(referencedResult.status).toBe('passed')

    const literal = basePlan()
    literal.groups[0]!.phases[0]!.assertions = [{
      id: 'literal-order',
      kind: 'entityText',
      entityName: 'chargingOrder',
      field: 'Associated Charging Order',
      operator: 'equals',
      expected: { literal: `2${'0'.repeat(18)}` },
    }]
    const literalResult = await executeWorkflow(literal, new FakeDriver({ entityCellPrefix: 'Order details:' }), {
      allowDestructive: true,
      environment,
    })
    expect(literalResult).toMatchObject({ status: 'failed', error: expect.stringContaining('exactly one cell equal') })
  })

  it('re-reads a captured entity after crossing a phase boundary without persisting row text', async () => {
    const plan = basePlan()
    const phase = plan.groups[0]!.phases[0]!
    const open = phase.steps.find((step) => step.kind === 'navigate')!
    const capture = phase.steps.find((step) => step.kind === 'captureTableRow')!
    plan.groups[0]!.phases = [
      { ...phase, id: 'capture-phase', steps: [open, capture], assertions: [{ id: 'captured', kind: 'entityText', entityName: 'chargingOrder', operator: 'contains', expected: { literal: 'Charging' } }] },
      { ...phase, id: 'verify-phase', risk: 'read', steps: [{ id: 'reopen', kind: 'navigate' }], assertions: [{ id: 'still-charging', kind: 'entityText', entityName: 'chargingOrder', field: 'Status', operator: 'equals', expected: { literal: 'Charging' } }] },
    ]
    const result = await executeWorkflow(plan, new FakeDriver(), {
      allowDestructive: true,
      stateStore: await stateStore(),
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' },
    })

    expect(result.status).toBe('passed')
    expect(JSON.stringify(result)).not.toContain('synthetic-phone')
  })

  it('fails closed when destructive approval is absent and leaves a private recovery checkpoint', async () => {
    const store = await stateStore()
    const result = await executeWorkflow(basePlan(), new FakeDriver(), {
      stateStore: store,
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' },
    })

    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('explicit approval') })
    expect((await stat(store.path)).mode & 0o777).toBe(0o600)
    expect(await store.load()).toMatchObject({ status: 'interrupted', cursor: { groupIndex: 0, phaseIndex: 0 } })
  })

  it('checks compensation approval before opening a session or recording the source mutation', async () => {
    const plan = basePlan()
    const source = plan.groups[0]!.phases[0]!
    source.risk = 'write'
    source.recovery = {
      strategy: 'compensate',
      phaseIds: ['cleanup-order'],
      maxAttempts: 1,
      sourceRefs: ['cell:cleanup'],
    }
    plan.groups[0]!.phases.push({
      id: 'cleanup-order',
      title: 'delete created device',
      targetId: 'h5',
      risk: 'destructive',
      contextMode: 'shared',
      steps: [{ id: 'delete-device', kind: 'click', locator: button('Delete') }],
      assertions: [{ id: 'device-deleted', kind: 'url', operator: 'contains', expected: { literal: 'h5.example.test' } }],
    })
    const driver = new FakeDriver()

    const result = await executeWorkflow(plan, driver, {
      allowWrite: true,
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' },
    })

    expect(result).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Compensation for phase start-and-stop is not approved before mutation'),
    })
    expect(driver.requestedKeys).toEqual([])
    expect(result.mutations).toEqual([])
  })

  it('blocks an autonomous write phase without recovery before opening a session', async () => {
    const plan = basePlan()
    plan.groups[0]!.phases[0]!.risk = 'write'
    const driver = new FakeDriver()

    const result = await executeWorkflow(plan, driver, {
      allowWrite: true,
      requireRecoveryFor: ['write', 'destructive'],
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' },
    })

    expect(result).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('has no autonomous recovery contract'),
    })
    expect(driver.requestedKeys).toEqual([])
    expect(result.mutations).toEqual([])
  })

  it('treats an authorized zero-entity cleanup as an implicit idempotent recovery boundary', async () => {
    const store = await stateStore()
    const plan = basePlan()
    delete plan.groups[0]!.forEach
    plan.dataBindings = [{ name: 'connector', source: 'literal', valueType: 'scalar', value: 'DEVICE-1' }]
    const phase = plan.groups[0]!.phases[0]!
    phase.risk = 'destructive'
    phase.contextMode = 'shared'
    phase.steps = [
      { id: 'navigate-cleanup', kind: 'navigate' },
      {
        id: 'capture-cleanup',
        kind: 'captureTableRow',
        entityName: 'cleanupEntity',
        table: dataTable,
        match: [{ valueRef: 'connector' }],
        idPattern: '\\b(\\d{19})\\b',
        timeoutMs: 1_000,
        pollIntervalMs: 10,
      },
      {
        id: 'delete-cleanup',
        kind: 'clickAlignedTableAction',
        entityName: 'cleanupEntity',
        dataTable,
        actionTable,
        actionNames: ['Delete'],
      },
    ]
    phase.assertions = [{ id: 'cleanup-empty', kind: 'tableRowCount', table: dataTable, match: [{ valueRef: 'connector' }], expected: 0 }]

    const failed = await executeWorkflow(plan, new FakeDriver(), {
      allowDestructive: true,
      requireRecoveryFor: ['write', 'destructive'],
      autoRecover: true,
      stateStore: store,
      environment: {},
    })
    expect(failed.status).toBe('failed')
    expect(failed.mutations.at(-1)?.status).toBe('retry_ready')

    const interrupted = await store.load()
    const resumed = await executeWorkflow(plan, new FakeDriver({ captureMissing: true }), {
      allowDestructive: true,
      requireRecoveryFor: ['write', 'destructive'],
      autoRecover: true,
      resume: true,
      resumeFromTarget: workflowResumeTarget(interrupted!, plan),
      stateStore: store,
      environment: {},
    })
    expect(resumed.status, resumed.error).toBe('passed')
    expect(resumed.mutations.filter((event) => event.phaseId === phase.id).at(-1)?.status).toBe('retry_ready')
    expect(assessMutationRecovery(resumed)).toMatchObject({ attempted: true, safeToRetry: true })
  })

  it('marks a query-first zero-entity cleanup safe after its zero-state assertion passes', async () => {
    const plan = basePlan()
    delete plan.groups[0]!.forEach
    plan.dataBindings = [{ name: 'connector', source: 'literal', valueType: 'scalar', value: 'DEVICE-1' }]
    const phase = plan.groups[0]!.phases[0]!
    phase.risk = 'destructive'
    phase.contextMode = 'shared'
    phase.steps = [
      { id: 'open-cleanup', kind: 'navigate' },
      { id: 'submit-query', kind: 'click', locator: button('Search') },
      {
        id: 'capture-cleanup',
        kind: 'captureTableRow',
        entityName: 'cleanupEntity',
        table: dataTable,
        match: [{ valueRef: 'connector' }],
        idPattern: '\\b(\\d{19})\\b',
        timeoutMs: 1_000,
        pollIntervalMs: 10,
      },
      {
        id: 'delete-cleanup',
        kind: 'clickAlignedTableAction',
        entityName: 'cleanupEntity',
        dataTable,
        actionTable,
        actionNames: ['Delete'],
      },
    ]
    phase.assertions = [{ id: 'cleanup-empty', kind: 'tableRowCount', table: dataTable, match: [{ valueRef: 'connector' }], expected: 0 }]

    const result = await executeWorkflow(plan, new FakeDriver({ captureMissing: true }), {
      allowDestructive: true,
      environment: {},
    })

    expect(result.status, result.error).toBe('passed')
    expect(result.mutations.map((event) => event.status)).toEqual(['started', 'retry_ready'])
    expect(assessMutationRecovery(result)).toMatchObject({ attempted: true, safeToRetry: true })
  })

  it('requires an explicit recovery target and can rewind the interrupted phase safely', async () => {
    const store = await stateStore()
    const plan = basePlan()
    const environment = { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-secret-phone' }
    const failed = await executeWorkflow(plan, new FakeDriver({ failClickOnce: true }), {
      allowDestructive: true,
      stateStore: store,
      environment,
    })

    expect(failed.status).toBe('failed')
    expect(failed.error).not.toContain('synthetic-secret-phone')
    expect(await readFile(store.path, 'utf8')).not.toContain('synthetic-secret-phone')
    await expect(executeWorkflow(plan, new FakeDriver(), {
      allowDestructive: true,
      stateStore: store,
      environment,
    })).rejects.toThrow(/unfinished workflow state/i)
    await expect(executeWorkflow(plan, new FakeDriver(), {
      allowDestructive: true,
      resume: true,
      stateStore: store,
      environment,
    })).rejects.toThrow(/resume-from/i)

    const resumed = await executeWorkflow(plan, new FakeDriver(), {
      allowDestructive: true,
      resume: true,
      resumeFromTarget: 'navigate-h5',
      stateStore: store,
      environment,
    })
    expect(resumed.status).toBe('passed')
    expect(resumed.steps.filter((event) => event.stepId === 'navigate-h5')).toHaveLength(2)
    expect(resumed.steps.some((event) => event.status === 'failed')).toBe(true)
    await expect(access(store.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('redacts unbound AUTO_TEST_SECRET values from runtime failures', async () => {
    const plan = basePlan()
    const result = await executeWorkflow(plan, new FakeDriver({
      failClickOnce: true,
      clickError: 'click failed while handling unbound-private-value',
    }), {
      allowDestructive: true,
      environment: {
        AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone',
        AUTO_TEST_SECRET_UNUSED: 'unbound-private-value',
      },
    })

    expect(result.status).toBe('failed')
    expect(result.error).not.toContain('unbound-private-value')
  })

  it('keeps skipped phase failures authoritative after a later safety audit', async () => {
    const store = await stateStore()
    const plan = basePlan()
    plan.groups[0]!.phases.push({
      id: 'final-audit',
      title: 'final audit',
      targetId: 'h5',
      risk: 'read',
      contextMode: 'freshPerIteration',
      steps: [{ id: 'audit-nav', kind: 'navigate' }],
      assertions: [{ id: 'audit-url', kind: 'url', operator: 'contains', expected: { literal: 'h5.example.test' } }],
    })
    const environment = { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' }
    const failed = await executeWorkflow(plan, new FakeDriver({ failClickOnce: true }), {
      allowDestructive: true,
      stateStore: store,
      environment,
    })
    expect(failed.status).toBe('failed')

    const recovered = await executeWorkflow(plan, new FakeDriver(), {
      allowDestructive: true,
      resume: true,
      resumeFromTarget: 'audit-nav',
      stateStore: store,
      environment,
    })
    expect(recovered).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('unresolved failed phases'),
    })
    expect(recovered.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phaseId: 'start-and-stop', status: 'failed' }),
      expect.objectContaining({ phaseId: 'final-audit', status: 'passed' }),
    ]))
    await expect(access(store.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects resume when the execution plan revision changed', async () => {
    const store = await stateStore()
    const plan = basePlan()
    const environment = { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' }
    await executeWorkflow(plan, new FakeDriver({ failClickOnce: true }), {
      allowDestructive: true,
      stateStore: store,
      environment,
    })
    const changed = structuredClone(plan)
    changed.groups[0]!.phases[0]!.title = 'changed after interruption'

    await expect(executeWorkflow(changed, new FakeDriver(), {
      allowDestructive: true,
      resume: true,
      resumeFromTarget: 'navigate-h5',
      stateStore: store,
      environment,
    })).rejects.toThrow(/plan hash/i)
  })

  it('detects navigation caused by a click leaving the target allowlist', async () => {
    const result = await executeWorkflow(basePlan(), new FakeDriver({ leaveOriginOnClick: true }), {
      allowDestructive: true,
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' },
    })
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('allowedOrigins') })
  })

  it('records the safe H5 failedStart route and error reason', async () => {
    const plan = basePlan()
    const phase = plan.groups[0]!.phases[0]!
    phase.steps = [{ id: 'navigate-h5', kind: 'navigate' }]
    phase.assertions = [{
      id: 'charging-route',
      kind: 'url',
      operator: 'contains',
      expected: { literal: '/charging' },
    }]
    const result = await executeWorkflow(plan, new FakeDriver({
      urlOverride: 'https://h5.example.test/#/failedStart?errMsg=Insufficient%20balance',
    }), {
      allowDestructive: true,
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' },
    })

    expect(result).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('/#/failedStart (Insufficient balance)'),
    })
  })

  it('records mutations and automatically compensates a failed destructive phase', async () => {
    const store = await stateStore()
    const plan = basePlan()
    const source = plan.groups[0]!.phases[0]!
    source.recovery = {
      strategy: 'compensate',
      phaseIds: ['cleanup-order'],
      maxAttempts: 1,
      sourceRefs: ['policy:synthetic-cleanup'],
    }
    plan.groups[0]!.phases.push({
      id: 'cleanup-order',
      title: 'cleanup captured order',
      targetId: 'h5',
      risk: 'destructive',
      contextMode: 'freshPerIteration',
      recovery: { strategy: 'retry', maxAttempts: 1, sourceRefs: ['policy:idempotent-cleanup'] },
      steps: [{
        id: 'cleanup-stop-order',
        kind: 'clickAlignedTableAction',
        entityName: 'chargingOrder',
        dataTable,
        actionTable,
        actionNames: ['Force Stop'],
      }],
      assertions: [{ id: 'cleanup-url-safe', kind: 'url', operator: 'contains', expected: { literal: 'h5.example.test' } }],
    })
    const result = await executeWorkflow(plan, new FakeDriver({ failClickOnce: true }), {
      allowDestructive: true,
      autoRecover: true,
      stateStore: store,
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' },
    })

    expect(result.status).toBe('failed')
    expect(result.recoveries).toEqual([
      expect.objectContaining({ sourcePhaseId: 'start-and-stop', recoveryPhaseId: 'cleanup-order', status: 'passed' }),
    ])
    expect(result.mutations.map((event) => event.status)).toEqual([
      'started',
      'failed',
      'compensation_started',
      'compensated',
    ])
    expect(assessMutationRecovery(result)).toMatchObject({ attempted: true, safeToRetry: true })
    expect(JSON.stringify(result)).not.toContain('synthetic-phone-a')

    const interrupted = await store.load()
    expect(interrupted?.recoveryResumeTarget).toBe('navigate-h5')
    const resumed = await executeWorkflow(plan, new FakeDriver(), {
      allowDestructive: true,
      autoRecover: true,
      resume: true,
      resumeFromTarget: workflowResumeTarget(interrupted!, plan),
      stateStore: store,
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' },
    })
    expect(resumed.status).toBe('passed')
    await expect(access(store.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('replays leading read prerequisites before compensating after a process restart', async () => {
    const store = await stateStore()
    const plan = basePlan()
    delete plan.groups[0]!.forEach
    plan.dataBindings = [
      { name: 'phone', source: 'literal', valueType: 'scalar', value: 'fixture-phone' },
      { name: 'connector', source: 'literal', valueType: 'scalar', value: 'DEVICE-1' },
    ]
    const source = plan.groups[0]!.phases[0]!
    source.contextMode = 'shared'
    source.recovery = {
      strategy: 'compensate',
      phaseIds: ['cleanup-order'],
      maxAttempts: 1,
      sourceRefs: ['policy:synthetic-cleanup'],
    }
    plan.groups[0]!.phases.unshift({
      id: 'login-prerequisite',
      title: 'establish authenticated page state',
      targetId: 'h5',
      risk: 'read',
      contextMode: 'shared',
      steps: [{ id: 'open-h5', kind: 'navigate' }],
      assertions: [{ id: 'h5-open', kind: 'url', operator: 'contains', expected: { literal: 'h5.example.test' } }],
    })
    plan.groups[0]!.phases.push({
      id: 'cleanup-order',
      title: 'cleanup captured order',
      targetId: 'h5',
      risk: 'destructive',
      contextMode: 'shared',
      recovery: { strategy: 'retry', maxAttempts: 1, sourceRefs: ['policy:idempotent-cleanup'] },
      steps: [
        {
          id: 'recapture-cleanup-order',
          kind: 'captureTableRow',
          entityName: 'chargingOrder',
          table: dataTable,
          match: [{ valueRef: 'phone' }, { valueRef: 'connector' }],
          idPattern: '\\b(\\d{19})\\b',
          timeoutMs: 1_000,
          pollIntervalMs: 10,
        },
        {
          id: 'cleanup-stop-order',
          kind: 'clickAlignedTableAction',
          entityName: 'chargingOrder',
          dataTable,
          actionTable,
          actionNames: ['Force Stop'],
        },
      ],
      assertions: [{ id: 'cleanup-page', kind: 'url', operator: 'contains', expected: { literal: 'h5.example.test' } }],
    })

    const failed = await executeWorkflow(plan, new FakeDriver({ failClickOnce: true }), {
      allowDestructive: true,
      stateStore: store,
      environment: {},
    })
    expect(failed.status).toBe('failed')
    const interrupted = await store.load()
    const navigatedUrls: string[] = []
    const resumedDriver = new FakeDriver({ navigatedUrls })
    const recovered = await executeWorkflow(plan, resumedDriver, {
      allowDestructive: true,
      autoRecover: true,
      resume: true,
      resumeFromTarget: workflowResumeTarget(interrupted!, plan),
      stopAfterRecovery: true,
      stateStore: store,
      environment: {},
    })

    expect(recovered.mutations.at(-1)?.status).toBe('compensated')
    expect(navigatedUrls).toContain('https://h5.example.test/')
  })

  it('does not run compensation when locator resolution fails before the mutation action', async () => {
    const plan = basePlan()
    plan.groups[0]!.phases[0]!.recovery = {
      strategy: 'compensate',
      phaseIds: ['cleanup-order'],
      maxAttempts: 1,
      sourceRefs: ['policy:synthetic-cleanup'],
    }
    plan.groups[0]!.phases.push({
      id: 'cleanup-order',
      title: 'cleanup captured order',
      targetId: 'h5',
      risk: 'destructive',
      contextMode: 'freshPerIteration',
      recovery: { strategy: 'retry', maxAttempts: 1, sourceRefs: ['policy:idempotent-cleanup'] },
      steps: [{
        id: 'cleanup-stop-order',
        kind: 'clickAlignedTableAction',
        entityName: 'chargingOrder',
        dataTable,
        actionTable,
        actionNames: ['Force Stop'],
      }],
      assertions: [{ id: 'cleanup-url-safe', kind: 'url', operator: 'contains', expected: { literal: 'h5.example.test' } }],
    })

    const result = await executeWorkflow(plan, new FakeDriver({ failBeforeClickOnce: true }), {
      allowDestructive: true,
      autoRecover: true,
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' },
    })

    expect(result.status).toBe('failed')
    expect(result.mutations.map((event) => event.status)).toEqual(['started', 'retry_ready'])
    expect(result.recoveries).toEqual([])
    expect(assessMutationRecovery(result)).toMatchObject({ attempted: true, safeToRetry: true })
  })

  it('keeps a mutation failed when a later pre-action check fails after an earlier mutating click', async () => {
    const plan = basePlan()
    plan.dataBindings = []
    delete plan.groups[0]!.forEach
    const phase = plan.groups[0]!.phases[0]!
    phase.steps = [
      { id: 'navigate-h5', kind: 'navigate' },
      { id: 'stop-device', kind: 'click', locator: button('Stop') },
      { id: 'confirm-stop', kind: 'click', locator: button('Confirm') },
    ]
    phase.assertions = [{ id: 'stopped', kind: 'url', operator: 'contains', expected: { literal: 'h5.example.test' } }]

    const result = await executeWorkflow(plan, new FakeDriver({ failBeforeClickAfter: 1 }), {
      allowDestructive: true,
      environment: {},
    })

    expect(result.status).toBe('failed')
    expect(result.mutations.map((event) => event.status)).toEqual(['started', 'failed'])
    expect(assessMutationRecovery(result)).toMatchObject({ attempted: true, safeToRetry: false })
  })

  it('retries a previously failed declared compensation before resuming the source phase', async () => {
    const store = await stateStore()
    const plan = basePlan()
    plan.groups[0]!.phases[0]!.recovery = {
      strategy: 'compensate',
      phaseIds: ['cleanup-order'],
      maxAttempts: 1,
      sourceRefs: ['policy:synthetic-cleanup'],
    }
    plan.groups[0]!.phases.push({
      id: 'cleanup-order',
      title: 'cleanup captured order',
      targetId: 'h5',
      risk: 'destructive',
      contextMode: 'freshPerIteration',
      recovery: { strategy: 'retry', maxAttempts: 1, sourceRefs: ['policy:idempotent-cleanup'] },
      steps: [
        { id: 'cleanup-navigate', kind: 'navigate' },
        { id: 'cleanup-stop-order', kind: 'click', locator: button('Force Stop') },
      ],
      assertions: [{ id: 'cleanup-url-safe', kind: 'url', operator: 'contains', expected: { literal: 'h5.example.test' } }],
    })
    const environment = { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' }
    const first = await executeWorkflow(plan, new FakeDriver({ failClicksRemaining: 2 }), {
      allowDestructive: true,
      autoRecover: true,
      stateStore: store,
      environment,
    })

    expect(first.status).toBe('failed')
    expect(first.mutations.at(-1)?.status).toBe('compensation_failed')
    const interrupted = await store.load()
    const resumed = await executeWorkflow(plan, new FakeDriver(), {
      allowDestructive: true,
      autoRecover: true,
      resume: true,
      resumeFromTarget: workflowResumeTarget(interrupted!, plan),
      stateStore: store,
      environment,
    })

    expect(resumed.status).toBe('passed')
    expect(resumed.mutations).toContainEqual(expect.objectContaining({ status: 'compensated', phaseId: 'start-and-stop' }))
    await expect(access(store.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('resumes a multi-phase compensation from its first incomplete recovery phase', async () => {
    const store = await stateStore()
    const plan = basePlan()
    plan.groups[0]!.phases[0]!.recovery = {
      strategy: 'compensate',
      phaseIds: ['recapture-order', 'cleanup-order'],
      maxAttempts: 1,
      sourceRefs: ['policy:synthetic-cleanup'],
    }
    plan.groups[0]!.phases.push(
      {
        id: 'recapture-order',
        title: 'recapture order before cleanup',
        targetId: 'h5',
        risk: 'read',
        contextMode: 'freshPerIteration',
        steps: [{
          id: 'recapture-order-row',
          kind: 'captureTableRow',
          entityName: 'chargingOrder',
          table: dataTable,
          match: [{ valueRef: 'phone' }, { valueRef: 'connector' }],
          idPattern: '\\b(\\d{19})\\b',
          timeoutMs: 1_000,
          pollIntervalMs: 10,
        }],
        assertions: [{ id: 'recapture-url-safe', kind: 'url', operator: 'contains', expected: { literal: 'h5.example.test' } }],
      },
      {
        id: 'cleanup-order',
        title: 'cleanup captured order',
        targetId: 'h5',
        risk: 'destructive',
        contextMode: 'freshPerIteration',
        recovery: { strategy: 'retry', maxAttempts: 1, sourceRefs: ['policy:idempotent-cleanup'] },
        steps: [
          { id: 'cleanup-navigate', kind: 'navigate' },
          { id: 'cleanup-stop-order', kind: 'click', locator: button('Force Stop') },
        ],
        assertions: [{ id: 'cleanup-url-safe', kind: 'url', operator: 'contains', expected: { literal: 'h5.example.test' } }],
      },
    )
    const environment = { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' }
    const first = await executeWorkflow(plan, new FakeDriver({ failClicksRemaining: 2 }), {
      allowDestructive: true,
      autoRecover: true,
      stateStore: store,
      environment,
    })

    expect(first.status).toBe('failed')
    expect(first.recoveries).toEqual([
      expect.objectContaining({ recoveryPhaseId: 'recapture-order', status: 'passed' }),
      expect.objectContaining({ recoveryPhaseId: 'cleanup-order', status: 'failed' }),
    ])

    const interrupted = await store.load()
    const resumed = await executeWorkflow(plan, new FakeDriver(), {
      allowDestructive: true,
      autoRecover: true,
      resume: true,
      resumeFromTarget: workflowResumeTarget(interrupted!, plan),
      stateStore: store,
      environment,
    })

    expect(resumed.status).toBe('passed')
    expect(resumed.recoveries.filter((event) => event.recoveryPhaseId === 'recapture-order')).toHaveLength(1)
    expect(resumed.recoveries.filter((event) => event.recoveryPhaseId === 'cleanup-order')).toEqual([
      expect.objectContaining({ status: 'failed' }),
      expect.objectContaining({ status: 'passed' }),
    ])
    await expect(access(store.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  function planWithOptionalEntityRecovery(): WorkflowExecutionPlan {
    const plan = basePlan()
    const source = plan.groups[0]!.phases[0]!
    source.steps = [
      { id: 'navigate-h5', kind: 'navigate' },
      { id: 'start-order', kind: 'click', locator: button('Start') },
    ]
    source.assertions = [{ id: 'source-url', kind: 'url', operator: 'contains', expected: { literal: 'h5.example.test' } }]
    source.recovery = {
      strategy: 'compensate',
      phaseIds: ['capture-created-order', 'cleanup-created-order', 'audit-no-active-order'],
      maxAttempts: 1,
      sourceRefs: ['policy:optional-created-entity'],
    }
    plan.groups[0]!.phases.push(
      {
        id: 'capture-created-order',
        title: 'capture created order when present',
        targetId: 'h5',
        risk: 'read',
        contextMode: 'freshPerIteration',
        steps: [{
          id: 'capture-created-order-row',
          kind: 'captureTableRow',
          entityName: 'createdOrder',
          table: dataTable,
          match: [{ valueRef: 'phone' }],
          idPattern: '\\b(\\d{19})\\b',
          timeoutMs: 1_000,
          pollIntervalMs: 10,
        }],
        assertions: [{ id: 'capture-url-safe', kind: 'url', operator: 'contains', expected: { literal: 'h5.example.test' } }],
      },
      {
        id: 'cleanup-created-order',
        title: 'cleanup created order when present',
        targetId: 'h5',
        risk: 'destructive',
        contextMode: 'freshPerIteration',
        recovery: { strategy: 'retry', maxAttempts: 1, sourceRefs: ['policy:idempotent-cleanup'] },
        steps: [{
          id: 'cleanup-created-order-action',
          kind: 'clickAlignedTableAction',
          entityName: 'createdOrder',
          dataTable,
          actionTable,
          actionNames: ['Force Stop'],
        }],
        assertions: [{ id: 'cleanup-url-safe', kind: 'url', operator: 'contains', expected: { literal: 'h5.example.test' } }],
      },
      {
        id: 'audit-no-active-order',
        title: 'audit no active order',
        targetId: 'h5',
        risk: 'read',
        contextMode: 'freshPerIteration',
        steps: [{ id: 'audit-navigate', kind: 'navigate' }],
        assertions: [{ id: 'active-count-zero', kind: 'tableRowCount', table: dataTable, match: [{ valueRef: 'phone' }], expected: 0 }],
      },
    )
    return plan
  }

  it('treats an absent recovery entity as not needed only after the zero-state audit passes', async () => {
    const result = await executeWorkflow(planWithOptionalEntityRecovery(), new FakeDriver({
      failClickOnce: true,
      captureMissing: true,
    }), {
      allowDestructive: true,
      autoRecover: true,
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' },
    })

    expect(result.status).toBe('failed')
    expect(result.recoveries).toEqual([
      expect.objectContaining({ recoveryPhaseId: 'capture-created-order', status: 'not_needed' }),
      expect.objectContaining({ recoveryPhaseId: 'cleanup-created-order', status: 'not_needed' }),
      expect.objectContaining({ recoveryPhaseId: 'audit-no-active-order', status: 'passed' }),
    ])
    expect(result.mutations.at(-1)?.status).toBe('compensated')
    expect(assessMutationRecovery(result)).toMatchObject({ attempted: true, safeToRetry: true })
  })

  it('can stop after recovering a blocked mutation without rerunning its source phase', async () => {
    const store = await stateStore()
    const plan = planWithOptionalEntityRecovery()
    const environment = { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' }
    const first = await executeWorkflow(plan, new FakeDriver({ failClickOnce: true }), {
      allowDestructive: true,
      stateStore: store,
      environment,
    })
    expect(first.status).toBe('failed')

    const interrupted = await store.load()
    const recovered = await executeWorkflow(plan, new FakeDriver({ captureMissing: true }), {
      allowDestructive: true,
      autoRecover: true,
      resume: true,
      resumeFromTarget: workflowResumeTarget(interrupted!, plan),
      stopAfterRecovery: true,
      stateStore: store,
      environment,
    })

    expect(recovered.status).toBe('failed')
    expect(recovered.phases.filter((event) => event.phaseId === 'start-and-stop')).toHaveLength(1)
    expect(recovered.mutations.at(-1)?.status).toBe('compensated')
    expect(assessMutationRecovery(recovered)).toMatchObject({ attempted: true, safeToRetry: true })
    expect(await store.load()).toBeDefined()
  })

  it('marks an idempotent failed mutation ready for an autonomous retry', async () => {
    const plan = basePlan()
    plan.groups[0]!.phases[0]!.recovery = {
      strategy: 'retry',
      maxAttempts: 1,
      sourceRefs: ['policy:idempotent-phase'],
    }
    const result = await executeWorkflow(plan, new FakeDriver({ failClickOnce: true }), {
      allowDestructive: true,
      autoRecover: true,
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' },
    })

    expect(result.status).toBe('failed')
    expect(result.mutations.at(-1)).toMatchObject({ status: 'retry_ready', phaseId: 'start-and-stop' })
    expect(assessMutationRecovery(result)).toMatchObject({ attempted: true, safeToRetry: true })
  })

  it('supports a one-account partial canary that stops before a named destructive target', async () => {
    const store = await stateStore()
    const driver = new FakeDriver()
    const result = await executeWorkflow(basePlan(), driver, {
      allowDestructive: true,
      iterationOffsetPerGroup: 1,
      maxIterationsPerGroup: 1,
      stopBeforeTarget: 'stop-order',
      stateStore: store,
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONES: '["synthetic-phone-a","synthetic-phone-b"]' },
    })

    expect(result.status).toBe('partial')
    expect(result.phases).toEqual([expect.objectContaining({ phaseId: 'start-and-stop', status: 'partial', iteration: 1 })])
    expect(result.steps.map((event) => event.stepId)).toEqual(['navigate-h5', 'fill-phone', 'capture-order'])
    expect(driver.requestedKeys).toEqual(['iteration:accounts:1:h5'])
    await expect(access(store.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('can stop before the first target of a destructive phase without destructive approval', async () => {
    const plan = basePlan()
    plan.groups[0]!.phases[0]!.steps = [{ id: 'destructive-entry', kind: 'click', locator: button('Start') }]
    plan.groups[0]!.phases[0]!.assertions = [{ id: 'never-reached', kind: 'url', operator: 'contains', expected: { literal: 'h5.example.test' } }]
    const result = await executeWorkflow(plan, new FakeDriver(), {
      stopBeforeTarget: 'destructive-entry',
      environment: { AUTO_TEST_SECRET_WORKFLOW_PHONES: 'synthetic-phone-a' },
    })

    expect(result.status).toBe('partial')
    expect(result.error ?? '').not.toContain('approval')
    expect(result.steps).toEqual([])
  })
})

describe('workflow runtime validation and table alignment', () => {
  it('rejects entity use before capture', () => {
    const plan = basePlan()
    plan.groups[0]!.phases[0]!.steps = [plan.groups[0]!.phases[0]!.steps[3]!]
    expect(() => validateWorkflowExecutionPlan(plan)).toThrow(/before capture/i)
  })

  it('rejects unknown runtime kinds instead of silently treating them as success', () => {
    const plan = basePlan() as unknown as Record<string, unknown>
    const groups = plan.groups as Array<{ phases: Array<{ steps: Array<Record<string, unknown>> }> }>
    groups[0]!.phases[0]!.steps[0]!.kind = 'aiGuessAndContinue'
    expect(() => validateWorkflowExecutionPlan(plan)).toThrow(/invalid kind/i)
  })

  it('reports a structured validation error when tableRowCount match is missing', () => {
    const plan = basePlan() as unknown as Record<string, unknown>
    const groups = plan.groups as Array<{ phases: Array<{ assertions: unknown[] }> }>
    groups[0]!.phases[0]!.assertions = [{
      id: 'broken-table-count',
      kind: 'tableRowCount',
      table: dataTable,
      expected: 1,
    }]
    expect(() => validateWorkflowExecutionPlan(plan)).toThrow(/match must be an array/i)
  })

  it('supports minimum table row count assertions without weakening exact counts', async () => {
    const plan = basePlan()
    plan.dataBindings = []
    delete plan.groups[0]!.forEach
    const phase = plan.groups[0]!.phases[0]!
    phase.risk = 'read'
    phase.contextMode = 'shared'
    phase.steps = [{ id: 'open', kind: 'navigate' }]
    phase.assertions = [{ id: 'orders-present', kind: 'tableRowCount', table: dataTable, match: [], operator: 'gte', expected: 1 }]
    const driver = new FakeDriver()
    const session = await driver.session('shared:h5', plan.targets[0]!) as FakeSession
    session.capturedRow = 'one order row'

    const result = await executeWorkflow(plan, driver, { environment: {} })

    expect(result.status, result.error).toBe('passed')
  })

  it('requires unique entity rows and revalidates the aligned action row', () => {
    expect(selectUniqueEntityRow(['order 2000000000000000000 phone-a'], ['phone-a'], /\b(\d{19})\b/)).toMatchObject({
      id: '2000000000000000000',
      rowIndex: 0,
    })
    expect(() => selectUniqueEntityRow(['id phone-a', 'other phone-a'], ['phone-a'], /(id)/)).toThrow(/found 2/i)
    expect(selectUniqueEntityRow(['1 Charging complete', '2 Charging'], ['Charging'], /(\d+)/, ['Charging complete']).id).toBe('2')
    expect(selectUniqueEntityRow(['ID-A   Charging'], ['id-a charging'], /(ID-A)/i).id).toBe('ID-A')
    expect(selectUniqueEntityRow(
      ['123 回归设备_01 20260713000001 YKC-快充型号'],
      ['20260713000001'],
      /^(20260713000001)$/,
    ).id).toBe('20260713000001')
    expect(alignedActionRowIndex(['id-a', 'id-b'], ['Details', 'Force Stop'], 'id-b', ['Force Stop'])).toBe(1)
    expect(alignedActionRowIndex(['id-a'], ['删除 修改 详情'], 'id-a', ['delete'])).toBe(0)
    expect(alignedActionRowIndex(['ID-A'], ['DELETE'], 'id-a', ['delete'])).toBe(0)
    expect(() => alignedActionRowIndex(['id-a'], ['Details'], 'id-a', ['Force Stop'])).toThrow(/allowed action/i)
    expect(entityAlreadyStoppedForAction(['id-a offline'], ['Delete'], 'id-a', ['Force Stop'])).toBe(true)
    expect(entityAlreadyStoppedForAction(['id-a online'], ['Delete'], 'id-a', ['Force Stop'])).toBe(false)
  })
})

describe('mutation recovery assessment', () => {
  it('keeps failed mutation attempts outstanding when a later attempt is retry-ready', () => {
    const result: WorkflowExecutionResult = {
      version: '1.0',
      workflowId: 'fixture',
      sourceSha256: 'a'.repeat(64),
      planSha256: 'b'.repeat(64),
      runId: 'fixture-run',
      startedAt: '2026-07-31T00:00:00.000Z',
      finishedAt: '2026-07-31T00:00:01.000Z',
      status: 'failed',
      phases: [],
      steps: [],
      assertions: [],
      entityCaptures: [],
      recoveries: [],
      entities: {},
      mutations: [
        { mutationId: 'g:single:p:1', groupId: 'g', phaseId: 'p', iteration: null, attempt: 1, risk: 'write', status: 'started', recordedAt: '2026-07-31T00:00:00.000Z' },
        { mutationId: 'g:single:p:1', groupId: 'g', phaseId: 'p', iteration: null, attempt: 1, risk: 'write', status: 'failed', recordedAt: '2026-07-31T00:00:00.000Z' },
        { mutationId: 'g:single:p:2', groupId: 'g', phaseId: 'p', iteration: null, attempt: 2, risk: 'write', status: 'started', recordedAt: '2026-07-31T00:00:01.000Z' },
        { mutationId: 'g:single:p:2', groupId: 'g', phaseId: 'p', iteration: null, attempt: 2, risk: 'write', status: 'retry_ready', recordedAt: '2026-07-31T00:00:01.000Z' },
      ],
    }

    expect(assessMutationRecovery(result)).toMatchObject({
      attempted: true,
      safeToRetry: false,
      outstandingMutationIds: ['g:single:p:1'],
    })
  })
})
