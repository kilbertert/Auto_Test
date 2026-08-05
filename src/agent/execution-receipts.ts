import { readFile } from 'node:fs/promises'
import type { ThreadEvent } from '@openai/codex-sdk'
import { writePrivateJson } from './state.js'
import type { CodexTestExecutionReceipt, CodexTestExecutionReceiptKind } from './types.js'

export interface CodexTestExecutionReceiptSummary {
  scope: 'active_run' | 'active_execution_epoch'
  cases: Array<{
    caseId: string
    recommendedReceiptIds: string[]
    interactionCount: number
    observationCount: number
  }>
  excludedReceiptCount: number
}

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

function browserReceipt(
  event: ThreadEvent,
  caseId: string | undefined,
  receiptId: string,
): CodexTestExecutionReceipt | undefined {
  if (event.type !== 'item.completed' || event.item.type !== 'mcp_tool_call') return undefined
  if (event.item.server !== 'playwright' || event.item.status !== 'completed' || !event.item.tool.startsWith('browser_')) return undefined
  return {
    id: receiptId,
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

/**
 * Keep the full receipt log on disk, but give the agent only compact
 * same-case references when the run has explicit case attribution.
 * The representative IDs are optional audit metadata, not a business verdict.
 */
export function summarizeExecutionReceipts(
  receipts: CodexTestExecutionReceipt[],
  activeCaseIds: Iterable<string>,
  scope: CodexTestExecutionReceiptSummary['scope'] = 'active_execution_epoch',
): CodexTestExecutionReceiptSummary {
  const caseIds = [...new Set(activeCaseIds)]
  const active = new Set(caseIds)
  const grouped = new Map<string, CodexTestExecutionReceipt[]>()
  for (const caseId of caseIds) grouped.set(caseId, [])
  let included = 0
  for (const receipt of receipts) {
    if (!receipt.caseId || !active.has(receipt.caseId)) continue
    grouped.get(receipt.caseId)!.push(receipt)
    included += 1
  }
  return {
    scope,
    cases: caseIds.map((caseId) => {
      const caseReceipts = grouped.get(caseId) ?? []
      const interactions = caseReceipts.filter((receipt) => receipt.kind === 'interaction')
      const observations = caseReceipts.filter((receipt) => receipt.kind === 'observation')
      const recommendedReceiptIds = [interactions.at(-1)?.id, observations.at(-1)?.id]
        .filter((id): id is string => Boolean(id))
      return {
        caseId,
        recommendedReceiptIds: [...new Set(recommendedReceiptIds)],
        interactionCount: interactions.length,
        observationCount: observations.length,
      }
    }),
    excludedReceiptCount: receipts.length - included,
  }
}

export class ExecutionReceiptRecorder {
  private activeCaseId: string | undefined
  private turnOrdinal: number
  private readonly knownCaseIds: Set<string>
  private readonly receipts = new Map<string, CodexTestExecutionReceipt>()

  private constructor(
    private readonly path: string,
    caseIds: string[],
    private readonly namespace: string,
    existing: CodexTestExecutionReceipt[],
  ) {
    this.knownCaseIds = new Set(caseIds)
    for (const receipt of existing) this.receipts.set(receipt.id, receipt)
    this.turnOrdinal = existing.reduce((maximum, receipt) => {
      const prefix = `${namespace}:turn-`
      if (!receipt.id.startsWith(prefix)) return maximum
      const value = Number(receipt.id.slice(prefix.length).split(':', 1)[0])
      return Number.isInteger(value) ? Math.max(maximum, value) : maximum
    }, 0)
  }

  static async create(path: string, caseIds: string[], namespace = 'single-thread'): Promise<ExecutionReceiptRecorder> {
    return new ExecutionReceiptRecorder(path, caseIds, namespace, await readExecutionReceipts(path))
  }

  async observe(event: ThreadEvent): Promise<void> {
    if (event.type === 'turn.started') {
      this.turnOrdinal += 1
      this.activeCaseId = undefined
      return
    }
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
    const receipt = browserReceipt(
      event,
      this.activeCaseId,
      `${this.namespace}:turn-${String(this.turnOrdinal).padStart(4, '0')}:${event.type === 'item.completed' ? event.item.id : 'unknown'}`,
    )
    if (!receipt || this.receipts.has(receipt.id)) return
    this.receipts.set(receipt.id, receipt)
    await writePrivateJson(this.path, [...this.receipts.values()])
  }
}
