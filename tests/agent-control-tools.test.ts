import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EnvironmentProfile } from '../src/workflow/environment-profile.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'
import { createControlMcpServer } from '../src/agent/control-server.js'
import type { AgentTestControlConfig } from '../src/agent/control-types.js'
import {
  openRunArtifactStoreForRun,
  runArtifactLayout,
  type RunArtifactStore,
} from '../src/agent/run-artifact-store.js'
import { prepareAgentWorkspace, type AgentWorkspace } from '../src/agent/workspace.js'

/**
 * The Control MCP journal tools as seen from outside the process. These tools
 * are an optional recovery and audit journal, so every assertion here is about
 * where a journal tool reads and writes and which entries it accepts — never
 * about a journal tool being required to pass a Case.
 */
const directories: string[] = []
const clients: Client[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const manifest: WorkflowIntakeManifest = {
  version: '1.0',
  kind: 'workflow-intake',
  workflowId: 'control-tools-fixture',
  source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'b'.repeat(64) },
  targetUrls: ['https://tools.example.test/app'],
  requiredCapabilities: [],
  phases: [
    {
      id: 'inspect-board',
      title: 'Inspect board',
      sourceRow: 2,
      risk: 'read',
      steps: [{ id: 'step-1', sourceText: 'Open the board', confidence: 1 }],
      resources: [],
      secretBindings: [],
      imageIds: [],
      review: { status: 'draft', ambiguities: [] },
    },
    {
      id: 'place-order',
      title: 'Place order',
      sourceRow: 3,
      risk: 'write',
      steps: [{ id: 'step-2', sourceText: 'Place one order', confidence: 1 }],
      resources: [],
      secretBindings: [],
      imageIds: [],
      review: { status: 'draft', ambiguities: [] },
    },
  ],
  embeddedImages: [],
  supplementalImages: [],
  review: { status: 'draft', reasons: [] },
}

const profile: EnvironmentProfile = {
  id: 'control-tools-fixture',
  origins: ['https://tools.example.test', 'https://reports.example.test'],
  auth: [],
  policy: { allowWrite: true, allowDestructive: false },
}

interface PreparedRun {
  runRoot: string
  workspace: AgentWorkspace
  store: RunArtifactStore
  controlConfig: AgentTestControlConfig
  client: Client
}

async function prepareRun(): Promise<PreparedRun> {
  const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-control-tools-'))
  directories.push(directory)
  const runRoot = resolve(directory, 'run')
  const workspace = await prepareAgentWorkspace({
    outputDirectory: runRoot,
    manifest,
    profile,
    secrets: { budget: '123400' },
    headed: false,
    browserExecutablePath: '/verified/chromium',
    environment: { PATH: '/usr/bin' },
  })
  await mkdir(resolve(runRoot, 'agent-workspace', 'evidence'), { recursive: true })
  await writeFile(resolve(runRoot, 'agent-workspace', 'evidence', 'live-note.md'), 'observed live\n')
  const controlConfig = JSON.parse(await readFile(workspace.controlConfigPath, 'utf8')) as AgentTestControlConfig
  return {
    runRoot,
    workspace,
    store: await openRunArtifactStoreForRun(runRoot),
    controlConfig,
    client: await connect(controlConfig),
  }
}

async function connect(controlConfig: AgentTestControlConfig): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = await createControlMcpServer(controlConfig)
  const client = new Client({ name: 'auto-test-control-tools-test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  clients.push(client)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: 'text'; text: string }>
  const text = content[0]?.text ?? ''
  if (result.isError) throw new Error(`${name} failed: ${text}`)
  return JSON.parse(text) as any
}

async function callFailure(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: 'text'; text: string }>
  expect(result.isError).toBe(true)
  return content[0]?.text ?? ''
}

const fieldGateInput = {
  caseId: 'place-order',
  fieldId: 'budget-value',
  logicalValueRef: 'workflow.budget',
  purpose: 'Enter a budget split across currency and amount controls',
  components: [
    { id: 'currency', role: 'selector', label: 'Currency', source: 'static', observedValue: 'CUR', representation: 'component', contribution: 'context' },
    { id: 'amount', role: 'input', label: 'Amount', source: 'secret', representation: 'component', contribution: 'segment' },
  ],
  rendered: [
    { componentId: 'currency', valueKind: 'static', literalValue: 'CUR' },
    { componentId: 'amount', valueKind: 'secret', valueLength: 6, secretAlias: 'AUTO_TEST_VALUE_001' },
  ],
  evidence: ['evidence/live-note.md'],
}

describe('control MCP journal tools over the RunArtifactStore', () => {
  it('resolves the journal layout from the store when the control config declares no journal path', async () => {
    const { runRoot, store } = await prepareRun()
    const client = await connect(
      JSON.parse(await readFile(`${runRoot}/.agent-private/control-config.json`, 'utf8')) as AgentTestControlConfig,
    )

    await call(client, 'environment_requirement_record', {
      caseIds: ['inspect-board'],
      kind: 'physical',
      condition: 'The board needs one hardware key plugged in',
      evidence: ['evidence/live-note.md'],
    })
    await call(client, 'field_composition_check', fieldGateInput)
    await call(client, 'case_result_record', {
      caseId: 'place-order',
      outcome: 'passed',
      summary: 'Order placed with the expected retained state',
      executionReceiptIds: ['receipt-1'],
    })

    const layout = runArtifactLayout(runRoot)
    expect(JSON.parse(await readFile(layout.environmentRequirementsPath, 'utf8'))).toHaveLength(1)
    expect(JSON.parse(await readFile(layout.fieldCompositionsPath, 'utf8'))).toHaveLength(1)
    expect(JSON.parse(await readFile(layout.caseResultsPath, 'utf8'))).toHaveLength(1)
    expect((await store.readEnvironmentRequirements()).entries).toHaveLength(1)
    expect((await store.readFieldCompositionGates()).entries).toHaveLength(1)
    expect((await store.readCaseResultDecisions()).entries).toHaveLength(1)
  })

  it('reaches the store layout even when the control config carries a stale journal path', async () => {
    const run = await prepareRun()
    const layout = runArtifactLayout(run.runRoot)
    // A control config as an earlier version of the tool persisted it: journal
    // artifact paths next to the run-root key. The store derives every path from
    // the run root, so a stale value can never redirect where a resumed run writes.
    const staleConfig = JSON.parse(JSON.stringify({
      ...run.controlConfig,
      mutationLedgerPath: layout.mutationLedgerPath,
      caseResultsPath: layout.caseResultsPath,
      environmentRequirementsPath: resolve(run.runRoot, 'agent-workspace', 'stale-requirements.json'),
      executionReceiptsPath: resolve(run.runRoot, 'agent-workspace', 'stale-receipts.json'),
      fieldCompositionPath: resolve(run.runRoot, 'agent-workspace', 'stale-gates.json'),
    })) as AgentTestControlConfig
    const client = await connect(staleConfig)

    await call(client, 'mutation_begin', {
      id: 'mutation-order-1',
      caseId: 'place-order',
      description: 'Persist one business order',
      risk: 'write',
    })
    await call(client, 'environment_requirement_record', {
      caseIds: ['inspect-board'],
      kind: 'physical',
      condition: 'The board needs one hardware key plugged in',
      evidence: ['evidence/live-note.md'],
    })
    await call(client, 'field_composition_check', fieldGateInput)
    await call(client, 'case_result_record', {
      caseId: 'place-order',
      outcome: 'passed',
      summary: 'Order placed with the expected retained state',
      executionReceiptIds: ['receipt-1'],
    })
    await writeFile(layout.executionReceiptsPath, JSON.stringify([
      { id: 'receipt-1', caseId: 'place-order', tool: 'browser_click', kind: 'interaction', status: 'completed', recordedAt: '2026-09-01T00:00:00.000Z' },
      { id: 'receipt-2', caseId: 'inspect-board', tool: 'browser_snapshot', kind: 'observation', status: 'completed', recordedAt: '2026-09-01T00:00:01.000Z' },
    ]))

    // The store layout is the only place the journal landed.
    expect(JSON.parse(await readFile(layout.mutationLedgerPath, 'utf8'))).toHaveLength(1)
    expect(JSON.parse(await readFile(layout.environmentRequirementsPath, 'utf8'))).toHaveLength(1)
    expect(JSON.parse(await readFile(layout.fieldCompositionsPath, 'utf8'))).toHaveLength(1)
    expect(JSON.parse(await readFile(layout.caseResultsPath, 'utf8'))).toHaveLength(1)
    for (const stalePath of ['stale-requirements.json', 'stale-gates.json', 'stale-receipts.json']) {
      expect(await readFile(resolve(run.runRoot, 'agent-workspace', stalePath), 'utf8').catch(() => undefined)).toBeUndefined()
    }

    const ledger = await call(client, 'mutation_list', {})
    expect(ledger).toEqual([expect.objectContaining({ id: 'mutation-order-1', status: 'pending' })])
    expect(await call(client, 'environment_requirements', {})).toHaveLength(1)
    expect(await call(client, 'field_composition_list', {})).toEqual([
      expect.objectContaining({ id: 'place-order:budget-value', status: 'passed' }),
    ])
    const receipts = await call(client, 'execution_receipts', {})
    expect(receipts.scope).toBe('active_run')
    expect(receipts.cases).toEqual([
      expect.objectContaining({ caseId: 'inspect-board', recommendedReceiptIds: ['receipt-2'], interactionCount: 0, observationCount: 1 }),
      expect.objectContaining({ caseId: 'place-order', recommendedReceiptIds: ['receipt-1'], interactionCount: 1, observationCount: 0 }),
    ])
    expect(receipts.excludedReceiptCount).toBe(0)

    // Every consumer reads the same entries back through the same store seam.
    const store = await openRunArtifactStoreForRun(run.runRoot)
    expect((await store.readMutationLedger()).entries).toHaveLength(1)
    expect((await store.readEnvironmentRequirements()).entries).toHaveLength(1)
    expect((await store.readExecutionReceipts()).entries).toHaveLength(2)
    expect((await store.readFieldCompositionGates()).entries).toHaveLength(1)
    expect((await store.readCaseResultDecisions()).entries).toHaveLength(1)
  })

  it('shares the Mutation Ledger transition rules with the MCP tools', async () => {
    const { client, store } = await prepareRun()

    const begun = await call(client, 'mutation_begin', {
      id: 'mutation-order-1',
      caseId: 'place-order',
      description: 'Persist one business order',
      risk: 'write',
    })
    expect(begun).toMatchObject({ id: 'mutation-order-1', status: 'pending', evidence: [] })

    expect(await call(client, 'mutation_begin', {
      id: 'mutation-order-1',
      caseId: 'place-order',
      description: 'Persist one business order',
      risk: 'write',
    })).toEqual(begun)

    const resolved = await call(client, 'mutation_resolve', {
      id: 'mutation-order-1',
      status: 'compensated',
      evidence: ['evidence/live-note.md'],
    })
    expect(resolved).toMatchObject({ status: 'compensated', evidence: ['evidence/live-note.md'] })
    expect(await callFailure(client, 'mutation_begin', {
      id: 'mutation-order-1',
      caseId: 'place-order',
      description: 'Persist one business order again',
      risk: 'write',
    })).toContain('already terminal')
    expect(await callFailure(client, 'mutation_resolve', {
      id: 'mutation-absent',
      status: 'accepted',
      evidence: ['evidence/live-note.md'],
    })).toContain('Unknown mutation id')
    expect(await callFailure(client, 'mutation_begin', {
      id: 'mutation-wipe-1',
      caseId: 'place-order',
      description: 'Wipe every business record',
      risk: 'destructive',
    })).toContain('does not authorize')

    expect((await store.readMutationLedger()).entries).toEqual([
      expect.objectContaining({ id: 'mutation-order-1', status: 'compensated' }),
    ])
  })

  it('refuses a business mutation when the run no longer holds its Mutation Ledger', async () => {
    const { client, store } = await prepareRun()
    await rm(store.layout.mutationLedgerPath, { force: true })

    expect(await callFailure(client, 'mutation_begin', {
      id: 'mutation-order-1',
      caseId: 'place-order',
      description: 'Persist one business order',
      risk: 'write',
    })).toContain('Mutation Ledger is missing')
    expect(await callFailure(client, 'mutation_resolve', {
      id: 'mutation-order-1',
      status: 'compensated',
      evidence: ['evidence/live-note.md'],
    })).toContain('Mutation Ledger is missing')
    // Recreating the ledger would silently drop the mutations this run recorded
    // before it was lost, so the artifact stays absent and both paths refuse.
    expect(await access(store.layout.mutationLedgerPath).then(() => true, () => false)).toBe(false)
    expect(await callFailure(client, 'mutation_list', {})).toContain('Mutation Ledger is missing')
  })

  it('keeps one case result per case and rejects an unknown case', async () => {
    const { client, store } = await prepareRun()

    await call(client, 'case_result_record', {
      caseId: 'inspect-board',
      outcome: 'blocked',
      summary: 'Board could not be inspected',
      blockers: ['The board needs one hardware key plugged in'],
      failureSource: 'environment',
      failureKind: 'environment',
      environmentRequirementIds: ['environment-physical-pending'],
      fieldGateIds: ['inspect-board:budget-value'],
      executionReceiptIds: ['receipt-1'],
    })
    await call(client, 'case_result_record', {
      caseId: 'inspect-board',
      outcome: 'passed',
      summary: 'Board rendered as expected',
    })

    const decisions = (await store.readCaseResultDecisions()).entries
    expect(decisions).toEqual([
      expect.objectContaining({ caseId: 'inspect-board', outcome: 'passed', blockers: [] }),
    ])
    expect(await callFailure(client, 'case_result_record', {
      caseId: 'absent-case',
      outcome: 'passed',
      summary: 'Unknown case',
    })).toContain('Unknown caseId')
    expect(await callFailure(client, 'case_result_record', {
      caseId: 'place-order',
      outcome: 'passed',
      summary: 'Passed with blockers',
      blockers: ['not allowed'],
    })).toContain('cannot include blockers')
  })

  it('records an unregistered origin as a resumable environment requirement instead of granting access', async () => {
    const { client, store } = await prepareRun()

    expect(await call(client, 'request_environment_access', {
      caseId: 'inspect-board',
      origin: 'https://reports.example.test',
      reason: 'The board links to the reports origin',
      evidence: ['evidence/live-note.md'],
    })).toMatchObject({ status: 'allowed', origin: 'https://reports.example.test' })

    const blocked = await call(client, 'request_environment_access', {
      caseId: 'inspect-board',
      origin: 'https://unregistered.example.test',
      reason: 'The board links to an unregistered origin',
      evidence: ['evidence/live-note.md'],
    })
    expect(blocked).toMatchObject({ status: 'blocked', origin: 'https://unregistered.example.test' })
    expect((await store.readEnvironmentRequirements()).entries).toEqual([
      expect.objectContaining({
        kind: 'origin',
        origin: 'https://unregistered.example.test',
        status: 'pending',
        caseIds: ['inspect-board'],
      }),
    ])

    await call(client, 'environment_requirement_satisfy', {
      id: blocked.requirementId,
      evidence: ['evidence/live-note.md'],
    })
    expect((await store.readEnvironmentRequirements()).entries[0]).toMatchObject({ status: 'satisfied' })
  })

  it('refuses to write a case result into a journal the store cannot attribute to this run', async () => {
    const { client, store } = await prepareRun()
    await writeFile(store.layout.caseResultsPath, JSON.stringify([
      { caseId: 'retired-case', outcome: 'passed', summary: 'From another run', blockers: [], productDefects: [], recordedAt: '2026-09-01T00:00:00.000Z' },
    ]))

    expect(await callFailure(client, 'case_result_record', {
      caseId: 'place-order',
      outcome: 'passed',
      summary: 'Cannot attach to an unattributable journal',
    })).toContain('Case results could not be read')
    expect((await store.readCaseResultDecisions()).entries).toEqual([])
    expect(JSON.parse(await readFile(store.layout.caseResultsPath, 'utf8'))).toHaveLength(1)
  })

  it('keeps the journal tools optional recovery and audit records instead of a pass gate', async () => {
    const { client, store } = await prepareRun()

    expect(client.getInstructions()).toContain('These tools are an optional run journal')
    expect(client.getInstructions()).toContain('or final structured delivery')
    expect((await client.listTools()).tools.find((tool) => tool.name === 'case_result_record')?.description)
      .toContain('this tool never gates browser execution')
    expect((await client.listTools()).tools.find((tool) => tool.name === 'test_plan_update')?.description)
      .toContain('Native AgentHost todo lists')

    // A run that never called a journal tool still delivers an empty journal.
    expect((await store.readCaseResultDecisions()).entries).toEqual([])
    expect((await store.readFieldCompositionGates()).entries).toEqual([])
    expect((await store.readMutationLedger()).entries).toEqual([])
    expect((await store.readEnvironmentRequirements()).entries).toEqual([])
  })
})
