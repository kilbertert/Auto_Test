import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ThreadEvent } from '@openai/codex-sdk'
import { ExecutionReceiptRecorder, readExecutionReceipts } from '../src/agent/execution-receipts.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function event(item: Record<string, unknown>): ThreadEvent {
  return { type: 'item.completed', item } as ThreadEvent
}

describe('execution receipts', () => {
  it('tags completed browser calls only while the declared case episode is active', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-execution-receipts-'))
    directories.push(directory)
    const path = resolve(directory, 'execution-receipts.json')
    const recorder = await ExecutionReceiptRecorder.create(path, ['case-one'])

    await recorder.observe(event({ id: 'begin', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'case-one' }, status: 'completed' }))
    await recorder.observe(event({ id: 'click', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_click', arguments: { secret: 'must-not-be-saved' }, result: { secret: 'must-not-be-saved' }, status: 'completed' }))
    await recorder.observe(event({ id: 'snapshot', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_snapshot', arguments: {}, result: {}, status: 'completed' }))
    await recorder.observe(event({ id: 'end', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_end', arguments: { caseId: 'case-one' }, status: 'completed' }))
    await recorder.observe(event({ id: 'unassigned', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_snapshot', arguments: {}, result: {}, status: 'completed' }))

    const receipts = await readExecutionReceipts(path)
    expect(receipts).toMatchObject([
      { id: 'click', caseId: 'case-one', tool: 'browser_click', kind: 'interaction' },
      { id: 'snapshot', caseId: 'case-one', tool: 'browser_snapshot', kind: 'observation' },
      { id: 'unassigned', tool: 'browser_snapshot', kind: 'observation' },
    ])
    expect(await readFile(path, 'utf8')).not.toContain('must-not-be-saved')
  })

  it('rejects an unknown case episode', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-execution-receipts-unknown-'))
    directories.push(directory)
    const recorder = await ExecutionReceiptRecorder.create(resolve(directory, 'execution-receipts.json'), ['case-one'])

    await expect(recorder.observe(event({ id: 'begin', type: 'mcp_tool_call', server: 'auto-test-control', tool: 'case_execution_begin', arguments: { caseId: 'case-two' }, status: 'completed' }))).rejects.toThrow(/unknown case/i)
  })
})
