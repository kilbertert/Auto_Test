import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ThreadEvent } from '@openai/codex-sdk'
import type { EnvironmentProfile } from '../src/workflow/environment-profile.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'
import { prepareAgentWorkspace } from '../src/agent/workspace.js'
import { openRunArtifactStore, type RunArtifactStore } from '../src/agent/run-artifact-store.js'
import { summarizeExecutionReceipts } from '../src/agent/execution-receipts.js'

/**
 * The execution receipt journal as seen at the store seam: the store owns where
 * receipts live and which of them may be read back for the current run.
 */
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const manifest: WorkflowIntakeManifest = {
  version: '1.0', kind: 'workflow-intake', workflowId: 'receipts-fixture',
  source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'c'.repeat(64) },
  targetUrls: ['https://example.test/'], requiredCapabilities: [],
  phases: [
    { id: 'case-one', title: 'Case one', sourceRow: 2, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
    { id: 'case-two', title: 'Case two', sourceRow: 3, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
  ],
  embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
}

const profile: EnvironmentProfile = {
  id: 'receipts-fixture',
  origins: ['https://example.test'],
  auth: [],
  policy: { allowWrite: false, allowDestructive: false },
}

async function openStore(): Promise<RunArtifactStore> {
  const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-execution-receipts-'))
  directories.push(directory)
  const runRoot = resolve(directory, 'run')
  await prepareAgentWorkspace({
    outputDirectory: runRoot,
    manifest,
    profile,
    secrets: {},
    headed: false,
    browserExecutablePath: '/verified/chromium',
    environment: { PATH: '/usr/bin' },
  })
  return openRunArtifactStore({ runRoot, manifest })
}

function event(item: Record<string, unknown>): ThreadEvent {
  return { type: 'item.completed', item } as ThreadEvent
}

const turnStarted = { type: 'turn.started' } as ThreadEvent

describe('execution receipts', () => {
  it('tags completed browser calls only while the declared case episode is active', async () => {
    const store = await openStore()
    const recorder = await store.openExecutionReceiptRecorder({ caseIds: ['case-one'] })

    await recorder.observe(turnStarted)
    await recorder.observe(event({ id: 'begin', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'case-one' }, status: 'completed' }))
    await recorder.observe(event({ id: 'click', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_click', arguments: { secret: 'must-not-be-saved' }, result: { secret: 'must-not-be-saved' }, status: 'completed' }))
    await recorder.observe(event({ id: 'snapshot', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_snapshot', arguments: {}, result: {}, status: 'completed' }))
    await recorder.observe(event({ id: 'end', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_end', arguments: { caseId: 'case-one' }, status: 'completed' }))
    await recorder.observe(event({ id: 'unassigned', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_snapshot', arguments: {}, result: {}, status: 'completed' }))

    const receipts = await store.readExecutionReceipts()
    expect(receipts.problems).toEqual([])
    expect(receipts.entries).toMatchObject([
      { id: 'single-thread:turn-0001:click', caseId: 'case-one', tool: 'browser_click', kind: 'interaction' },
      { id: 'single-thread:turn-0001:snapshot', caseId: 'case-one', tool: 'browser_snapshot', kind: 'observation' },
      { id: 'single-thread:turn-0001:unassigned', tool: 'browser_snapshot', kind: 'observation' },
    ])
    expect(await readFile(store.layout.executionReceiptsPath, 'utf8')).not.toContain('must-not-be-saved')
  })

  it('rejects an unknown case episode', async () => {
    const store = await openStore()
    const recorder = await store.openExecutionReceiptRecorder({ caseIds: ['case-one'] })

    await expect(recorder.observe(event({ id: 'begin', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'case-three' }, status: 'completed' })))
      .rejects.toThrow(/unknown case/i)
  })

  it('rejects a stored receipt that names a case outside the immutable run', async () => {
    const store = await openStore()
    const recorder = await store.openExecutionReceiptRecorder({ caseIds: ['case-one'] })
    await recorder.observe(turnStarted)
    await recorder.observe(event({ id: 'click', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_click', arguments: {}, result: {}, status: 'completed' }))
    const stored = JSON.parse(await readFile(store.layout.executionReceiptsPath, 'utf8')) as Array<Record<string, unknown>>
    await writeFile(store.layout.executionReceiptsPath, JSON.stringify([{ ...stored[0], caseId: 'case-three' }]))

    const receipts = await store.readExecutionReceipts()
    expect(receipts.entries).toEqual([])
    expect(receipts.problems).toEqual(['Execution receipt single-thread:turn-0001:click references an unknown case case-three'])
  })

  it('records OMP xd:// MCP executions under the same case attribution contract', async () => {
    const store = await openStore()
    const recorder = await store.openExecutionReceiptRecorder({ caseIds: ['case-one'] })

    await recorder.observe({ type: 'agent_start' })
    await recorder.observe({
      type: 'tool_execution_end', toolCallId: 'begin', toolName: 'write',
      result: { details: { xdev: {
        tool: 'mcp__auto_test_control_case_execution_begin', mode: 'execute', args: { caseId: 'case-one' },
        inner: { serverName: 'auto-test-control', mcpToolName: 'case_execution_begin' },
      } } },
    } as unknown as ThreadEvent)
    await recorder.observe({
      type: 'tool_execution_end', toolCallId: 'click', toolName: 'write',
      result: { details: { xdev: {
        tool: 'mcp__playwright_browser_click', mode: 'execute', args: { secret: 'must-not-be-saved' },
        inner: { serverName: 'playwright', mcpToolName: 'browser_click' },
      } } },
    } as unknown as ThreadEvent)
    await recorder.observe({
      type: 'tool_execution_end', toolCallId: 'snapshot', toolName: 'write',
      result: { details: { xdev: {
        tool: 'mcp__playwright_browser_snapshot', mode: 'execute', args: {},
        inner: { serverName: 'playwright', mcpToolName: 'browser_snapshot' },
      } } },
    } as unknown as ThreadEvent)

    const receipts = await store.readExecutionReceipts()
    expect(receipts.entries).toMatchObject([
      { id: 'single-thread:turn-0001:click', caseId: 'case-one', tool: 'browser_click', kind: 'interaction' },
      { id: 'single-thread:turn-0001:snapshot', caseId: 'case-one', tool: 'browser_snapshot', kind: 'observation' },
    ])
    expect(await readFile(store.layout.executionReceiptsPath, 'utf8')).not.toContain('must-not-be-saved')
  })

  it('summarizes only active-window receipts and keeps one same-case pair per case', () => {
    const summary = summarizeExecutionReceipts([
      { id: 'old-click', caseId: 'old-case', tool: 'browser_click', kind: 'interaction', status: 'completed', recordedAt: '2026-01-01T00:00:00Z' },
      { id: 'current-click', caseId: 'current-case', tool: 'browser_click', kind: 'interaction', status: 'completed', recordedAt: '2026-01-01T00:00:01Z' },
      { id: 'current-snapshot', caseId: 'current-case', tool: 'browser_snapshot', kind: 'observation', status: 'completed', recordedAt: '2026-01-01T00:00:02Z' },
      { id: 'current-latest', caseId: 'current-case', tool: 'browser_evaluate', kind: 'observation', status: 'completed', recordedAt: '2026-01-01T00:00:03Z' },
    ], ['current-case', 'empty-case'])

    expect(summary).toEqual({
      scope: 'active_execution_epoch',
      cases: [
        { caseId: 'current-case', recommendedReceiptIds: ['current-click', 'current-latest'], interactionCount: 1, observationCount: 2 },
        { caseId: 'empty-case', recommendedReceiptIds: [], interactionCount: 0, observationCount: 0 },
      ],
      excludedReceiptCount: 1,
    })
  })

  it('namespaces repeated item IDs across windows and resumed turns', async () => {
    const store = await openStore()

    const firstWindow = await store.openExecutionReceiptRecorder({ caseIds: ['case-one'], namespace: 'batch-0001' })
    await firstWindow.observe(turnStarted)
    await firstWindow.observe(event({ id: 'begin-one', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'case-one' }, status: 'completed' }))
    await firstWindow.observe(event({ id: 'item_1', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_click', arguments: {}, result: {}, status: 'completed' }))

    const secondWindow = await store.openExecutionReceiptRecorder({ caseIds: ['case-two'], namespace: 'batch-0002' })
    await secondWindow.observe(turnStarted)
    await secondWindow.observe(event({ id: 'begin-two', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'case-two' }, status: 'completed' }))
    await secondWindow.observe(event({ id: 'item_1', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_click', arguments: {}, result: {}, status: 'completed' }))

    const resumedSecondWindow = await store.openExecutionReceiptRecorder({ caseIds: ['case-two'], namespace: 'batch-0002' })
    await resumedSecondWindow.observe(turnStarted)
    await resumedSecondWindow.observe(event({ id: 'begin-two-resumed', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'case-two' }, status: 'completed' }))
    await resumedSecondWindow.observe(event({ id: 'item_1', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_snapshot', arguments: {}, result: {}, status: 'completed' }))

    expect((await store.readExecutionReceipts()).entries.map((receipt) => receipt.id)).toEqual([
      'batch-0001:turn-0001:item_1',
      'batch-0002:turn-0001:item_1',
      'batch-0002:turn-0002:item_1',
    ])
  })
})
