import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ThreadEvent } from '@openai/codex-sdk'
import { ExecutionReceiptRecorder, readExecutionReceipts, summarizeExecutionReceipts } from '../src/agent/execution-receipts.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function event(item: Record<string, unknown>): ThreadEvent {
  return { type: 'item.completed', item } as ThreadEvent
}

const turnStarted = { type: 'turn.started' } as ThreadEvent

describe('execution receipts', () => {
  it('tags completed browser calls only while the declared case episode is active', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-execution-receipts-'))
    directories.push(directory)
    const path = resolve(directory, 'execution-receipts.json')
    const recorder = await ExecutionReceiptRecorder.create(path, ['case-one'])

    await recorder.observe(turnStarted)
    await recorder.observe(event({ id: 'begin', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'case-one' }, status: 'completed' }))
    await recorder.observe(event({ id: 'click', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_click', arguments: { secret: 'must-not-be-saved' }, result: { secret: 'must-not-be-saved' }, status: 'completed' }))
    await recorder.observe(event({ id: 'snapshot', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_snapshot', arguments: {}, result: {}, status: 'completed' }))
    await recorder.observe(event({ id: 'end', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_end', arguments: { caseId: 'case-one' }, status: 'completed' }))
    await recorder.observe(event({ id: 'unassigned', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_snapshot', arguments: {}, result: {}, status: 'completed' }))

    const receipts = await readExecutionReceipts(path)
    expect(receipts).toMatchObject([
      { id: 'single-thread:turn-0001:click', caseId: 'case-one', tool: 'browser_click', kind: 'interaction' },
      { id: 'single-thread:turn-0001:snapshot', caseId: 'case-one', tool: 'browser_snapshot', kind: 'observation' },
      { id: 'single-thread:turn-0001:unassigned', tool: 'browser_snapshot', kind: 'observation' },
    ])
    expect(await readFile(path, 'utf8')).not.toContain('must-not-be-saved')
  })

  it('rejects an unknown case episode', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-execution-receipts-unknown-'))
    directories.push(directory)
    const recorder = await ExecutionReceiptRecorder.create(resolve(directory, 'execution-receipts.json'), ['case-one'])

    await expect(recorder.observe(event({ id: 'begin', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'case-two' }, status: 'completed' }))).rejects.toThrow(/unknown case/i)
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
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-execution-receipts-windows-'))
    directories.push(directory)
    const path = resolve(directory, 'execution-receipts.json')

    const firstWindow = await ExecutionReceiptRecorder.create(path, ['case-one'], 'batch-0001')
    await firstWindow.observe(turnStarted)
    await firstWindow.observe(event({ id: 'begin-one', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'case-one' }, status: 'completed' }))
    await firstWindow.observe(event({ id: 'item_1', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_click', arguments: {}, result: {}, status: 'completed' }))

    const secondWindow = await ExecutionReceiptRecorder.create(path, ['case-two'], 'batch-0002')
    await secondWindow.observe(turnStarted)
    await secondWindow.observe(event({ id: 'begin-two', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'case-two' }, status: 'completed' }))
    await secondWindow.observe(event({ id: 'item_1', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_click', arguments: {}, result: {}, status: 'completed' }))

    const resumedSecondWindow = await ExecutionReceiptRecorder.create(path, ['case-two'], 'batch-0002')
    await resumedSecondWindow.observe(turnStarted)
    await resumedSecondWindow.observe(event({ id: 'begin-two-resumed', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'case-two' }, status: 'completed' }))
    await resumedSecondWindow.observe(event({ id: 'item_1', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_snapshot', arguments: {}, result: {}, status: 'completed' }))

    expect((await readExecutionReceipts(path)).map((receipt) => receipt.id)).toEqual([
      'batch-0001:turn-0001:item_1',
      'batch-0002:turn-0001:item_1',
      'batch-0002:turn-0002:item_1',
    ])
  })
})
