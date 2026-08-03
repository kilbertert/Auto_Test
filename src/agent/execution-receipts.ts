import { readFile } from 'node:fs/promises'
import type { ThreadEvent } from '@openai/codex-sdk'
import { writePrivateJson } from './state.js'
import type { CodexTestExecutionReceipt, CodexTestExecutionReceiptKind } from './types.js'

function browserReceiptKind(tool: string): CodexTestExecutionReceiptKind {
  return /(?:snapshot|screenshot|verify|network|console|find|evaluate|run_code)/.test(tool)
    ? 'observation'
    : 'interaction'
}

function controlCaseId(event: ThreadEvent): string | undefined {
  if (event.type !== 'item.completed' || event.item.type !== 'mcp_tool_call') return undefined
  if (event.item.server !== 'auto-test-control' || event.item.status !== 'completed') return undefined
  if (event.item.tool !== 'case_execution_begin') return undefined
  const value = (event.item.arguments as { caseId?: unknown }).caseId
  return typeof value === 'string' ? value : undefined
}

function isCaseExecutionEnd(event: ThreadEvent): boolean {
  return event.type === 'item.completed' &&
    event.item.type === 'mcp_tool_call' &&
    event.item.server === 'auto-test-control' &&
    event.item.status === 'completed' &&
    event.item.tool === 'case_execution_end'
}

function browserReceipt(event: ThreadEvent, caseId: string | undefined): CodexTestExecutionReceipt | undefined {
  if (event.type !== 'item.completed' || event.item.type !== 'mcp_tool_call') return undefined
  if (event.item.server !== 'playwright' || event.item.status !== 'completed' || !event.item.tool.startsWith('browser_')) return undefined
  return {
    id: event.item.id,
    ...(caseId ? { caseId } : {}),
    tool: event.item.tool,
    kind: browserReceiptKind(event.item.tool),
    status: 'completed',
    recordedAt: new Date().toISOString(),
  }
}

export async function readExecutionReceipts(path: string): Promise<CodexTestExecutionReceipt[]> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!Array.isArray(value)) throw new Error('Execution receipts must be an array')
    return value as CodexTestExecutionReceipt[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export class ExecutionReceiptRecorder {
  private activeCaseId: string | undefined
  private readonly knownCaseIds: Set<string>
  private readonly receipts = new Map<string, CodexTestExecutionReceipt>()

  private constructor(private readonly path: string, caseIds: string[], existing: CodexTestExecutionReceipt[]) {
    this.knownCaseIds = new Set(caseIds)
    for (const receipt of existing) this.receipts.set(receipt.id, receipt)
  }

  static async create(path: string, caseIds: string[]): Promise<ExecutionReceiptRecorder> {
    return new ExecutionReceiptRecorder(path, caseIds, await readExecutionReceipts(path))
  }

  async observe(event: ThreadEvent): Promise<void> {
    const startedCaseId = controlCaseId(event)
    if (startedCaseId) {
      if (!this.knownCaseIds.has(startedCaseId)) throw new Error(`Execution receipt references unknown case ${startedCaseId}`)
      this.activeCaseId = startedCaseId
      return
    }
    if (isCaseExecutionEnd(event)) {
      this.activeCaseId = undefined
      return
    }
    const receipt = browserReceipt(event, this.activeCaseId)
    if (!receipt || this.receipts.has(receipt.id)) return
    this.receipts.set(receipt.id, receipt)
    await writePrivateJson(this.path, [...this.receipts.values()])
  }
}
