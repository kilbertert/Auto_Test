import { readFile } from 'node:fs/promises'
import { normalizeAgentEvent } from '../agent/host.js'

export interface ReplayDiagnostic {
  severity: 'error' | 'warning'
  code: string
  message: string
  caseId?: string
  eventId?: string
}

export interface CompiledMcpReplay {
  source: string
  caseIds: string[]
  diagnostics: ReplayDiagnostic[]
}

const ignoredTools = /(?:snapshot|screenshot|network_requests|console_messages|close)$/
const unsafeTools = /(?:run_code|evaluate)/

function resultText(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content.flatMap((item) => item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
    ? [(item as { text: string }).text]
    : []).join('\n')
}

function playwrightCode(text: string): string | undefined {
  return text.match(/### Ran Playwright code\s*```(?:js|javascript|ts|typescript)\s*\n([\s\S]*?)```/)?.[1]?.trim()
}

function environmentExpression(name: string): string {
  return `(process.env.${name} ?? (() => { throw new Error(${JSON.stringify(`Missing ${name}`)}) })())`
}

function makeReplayable(code: string): string {
  return code
    .replace(/(['"])<secret>(AUTO_TEST_VALUE_\d+)<\/secret>\1/g, (_match, _quote, name: string) => environmentExpression(name))
    .replace(/(['"])<redacted-secret>\1/g, () => environmentExpression('AUTO_TEST_REPLAY_SECRET'))
}

export function compileMcpReplay(events: unknown[], passedCaseIds?: ReadonlySet<string>): CompiledMcpReplay {
  const cases = new Map<string, string[]>()
  const diagnostics: ReplayDiagnostic[] = []
  let activeCaseId: string | undefined
  const hasCaseBoundaries = events.some((value) => {
    const event = normalizeAgentEvent(value)
    return event.type === 'tool_completed' && event.server === 'auto-test-control' && (event.tool === 'case_execution_begin' || event.tool === 'case_execution_end')
  })
  if (!hasCaseBoundaries && passedCaseIds && passedCaseIds.size === 1) {
    activeCaseId = [...passedCaseIds][0]
    cases.set(activeCaseId!, [])
  }
  else if (!hasCaseBoundaries && passedCaseIds && passedCaseIds.size > 1) diagnostics.push({ severity: 'error', code: 'case_boundaries_missing', message: 'Multiple passed cases require case_execution_begin/end attribution' })

  for (const value of events) {
    const event = normalizeAgentEvent(value)
    if (event.type !== 'tool_completed' || event.status !== 'completed') continue
    if (event.server === 'auto-test-control' && event.tool === 'case_execution_begin') {
      const caseId = (event.arguments as { caseId?: unknown } | undefined)?.caseId
      activeCaseId = typeof caseId === 'string' ? caseId : undefined
      if (activeCaseId && (!passedCaseIds || passedCaseIds.has(activeCaseId))) cases.set(activeCaseId, cases.get(activeCaseId) ?? [])
      continue
    }
    if (event.server === 'auto-test-control' && event.tool === 'case_execution_end') {
      const endedCaseId = (event.arguments as { caseId?: unknown } | undefined)?.caseId
      if (activeCaseId && endedCaseId !== activeCaseId) diagnostics.push({ severity: 'error', code: 'case_boundary_mismatch', message: 'case_execution_end does not match the active case', caseId: activeCaseId, ...(event.id ? { eventId: event.id } : {}) })
      activeCaseId = undefined
      continue
    }
    if (event.server !== 'playwright' || !event.tool?.startsWith('browser_') || ignoredTools.test(event.tool)) continue
    if (!activeCaseId || (passedCaseIds && !passedCaseIds.has(activeCaseId))) continue
    if (unsafeTools.test(event.tool)) {
      diagnostics.push({ severity: 'error', code: 'unsafe_tool', message: `${event.tool} cannot be replayed deterministically`, caseId: activeCaseId, ...(event.id ? { eventId: event.id } : {}) })
      continue
    }
    const code = playwrightCode(resultText(event.result))
    if (!code) {
      diagnostics.push({ severity: 'error', code: 'generated_code_missing', message: `${event.tool} did not return Playwright code`, caseId: activeCaseId, ...(event.id ? { eventId: event.id } : {}) })
      continue
    }
    cases.get(activeCaseId)!.push(makeReplayable(code))
  }

  for (const caseId of passedCaseIds ?? []) {
    if (!cases.has(caseId)) diagnostics.push({ severity: 'error', code: 'case_events_missing', message: 'Passed case has no replayable execution block', caseId })
  }
  for (const [caseId, code] of cases) {
    if (!code.some((line) => /\bexpect\s*\(/.test(line))) diagnostics.push({ severity: 'error', code: 'assertion_missing', message: 'Passed case has no replayable Playwright assertion', caseId })
  }
  if (diagnostics.some((item) => item.severity === 'error')) return { source: '', caseIds: [...cases.keys()], diagnostics }

  const body = [...cases].map(([caseId, lines]) => [
    `test(${JSON.stringify(caseId)}, async ({ page }) => {`,
    ...lines.flatMap((code) => code.split('\n').map((line) => `  ${line}`)),
    '})',
  ].join('\n')).join('\n\n')
  return {
    source: `import { test, expect } from '@playwright/test'\n\n${body}\n`,
    caseIds: [...cases.keys()],
    diagnostics,
  }
}

export async function readJsonLines(path: string): Promise<unknown[]> {
  return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as unknown } catch { throw new Error(`Invalid JSONL at line ${index + 1}`) }
  })
}
