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

interface ReplayAttempt { caseId: string; code: string[]; diagnostics: ReplayDiagnostic[]; complete: boolean }

// These tools inspect evidence but do not represent a deterministic page action.
// Their MCP responses intentionally have no generated Playwright source.
const ignoredTools = /(?:snapshot|screenshot|network_requests?|console_messages|find|storage_state|set_storage_state|close)$/
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
    .replace(/(['"])<secret>(AUTO_TEST_VALUE_\d+(?:_\d+)?)<\/secret>\1/g, (_match, _quote, name: string) => environmentExpression(name))
}

function replayCode(attempt: ReplayAttempt): string[] | undefined {
  if (attempt.diagnostics.length > 0) return undefined
  const navigationIndex = attempt.code.findIndex((line) => /\bpage\.goto\s*\(/.test(line))
  if (navigationIndex < 0) {
    attempt.diagnostics.push({ severity: 'error', code: 'navigation_missing', message: 'Replay attempt must start from a deterministic page.goto navigation', caseId: attempt.caseId })
    return undefined
  }
  if (attempt.code.slice(0, navigationIndex).some((line) => !/^\s*await expect\s*\(/.test(line))) {
    attempt.diagnostics.push({ severity: 'error', code: 'action_before_navigation', message: 'Replay attempt contains a business action before its first page.goto navigation', caseId: attempt.caseId })
    return undefined
  }
  const code = attempt.code.slice(navigationIndex)
  return code.some((line) => /\bexpect\s*\(/.test(line)) ? code : undefined
}

export function compileMcpReplay(events: unknown[], passedCaseIds?: ReadonlySet<string>): CompiledMcpReplay {
  const attempts = new Map<string, ReplayAttempt[]>()
  const diagnostics: ReplayDiagnostic[] = []
  let activeCaseId: string | undefined
  let activeAttempt: ReplayAttempt | undefined
  const hasCaseBoundaries = events.some((value) => {
    const event = normalizeAgentEvent(value)
    return event.type === 'tool_completed' && event.server === 'auto-test-control' && (event.tool === 'case_execution_begin' || event.tool === 'case_execution_end')
  })
  if (!hasCaseBoundaries && passedCaseIds && passedCaseIds.size === 1) {
    activeCaseId = [...passedCaseIds][0]
    activeAttempt = { caseId: activeCaseId!, code: [], diagnostics: [], complete: true }
    attempts.set(activeCaseId!, [activeAttempt])
  }
  else if (!hasCaseBoundaries && passedCaseIds && passedCaseIds.size > 1) diagnostics.push({ severity: 'error', code: 'case_boundaries_missing', message: 'Multiple passed cases require case_execution_begin/end attribution' })

  for (const value of events) {
    const event = normalizeAgentEvent(value)
    if (event.type !== 'tool_completed') continue
    if (event.status !== 'completed') {
      if (activeCaseId && (!passedCaseIds || passedCaseIds.has(activeCaseId)) &&
          event.server === 'playwright' && event.tool?.startsWith('browser_') && !ignoredTools.test(event.tool)) {
        activeAttempt?.diagnostics.push({ severity: 'error', code: 'tool_failed', message: `${event.tool} did not complete successfully`, caseId: activeCaseId, ...(event.id ? { eventId: event.id } : {}) })
      }
      continue
    }
    if (event.server === 'auto-test-control' && event.tool === 'case_execution_begin') {
      const caseId = (event.arguments as { caseId?: unknown } | undefined)?.caseId
      activeCaseId = typeof caseId === 'string' ? caseId : undefined
      activeAttempt = activeCaseId && (!passedCaseIds || passedCaseIds.has(activeCaseId))
        ? { caseId: activeCaseId, code: [], diagnostics: [], complete: false }
        : undefined
      if (activeAttempt) attempts.set(activeCaseId!, [...(attempts.get(activeCaseId!) ?? []), activeAttempt])
      continue
    }
    if (event.server === 'auto-test-control' && event.tool === 'case_execution_end') {
      const endedCaseId = (event.arguments as { caseId?: unknown } | undefined)?.caseId
      if (activeCaseId && endedCaseId !== activeCaseId) activeAttempt?.diagnostics.push({ severity: 'error', code: 'case_boundary_mismatch', message: 'case_execution_end does not match the active case', caseId: activeCaseId, ...(event.id ? { eventId: event.id } : {}) })
      else if (activeAttempt) activeAttempt.complete = true
      activeCaseId = undefined
      activeAttempt = undefined
      continue
    }
    if (event.server !== 'playwright' || !event.tool?.startsWith('browser_') || ignoredTools.test(event.tool)) continue
    if (!activeCaseId || (passedCaseIds && !passedCaseIds.has(activeCaseId))) continue
    if (unsafeTools.test(event.tool)) {
      activeAttempt?.diagnostics.push({ severity: 'error', code: 'unsafe_tool', message: `${event.tool} cannot be replayed deterministically`, caseId: activeCaseId, ...(event.id ? { eventId: event.id } : {}) })
      continue
    }
    const code = playwrightCode(resultText(event.result))
    if (!code) {
      activeAttempt?.diagnostics.push({ severity: 'error', code: 'generated_code_missing', message: `${event.tool} did not return Playwright code`, caseId: activeCaseId, ...(event.id ? { eventId: event.id } : {}) })
      continue
    }
    const replayable = makeReplayable(code)
    if (/<(?:\/?secret|redacted(?:-[^>]+)?)>/i.test(replayable)) {
      activeAttempt?.diagnostics.push({ severity: 'error', code: 'redacted_runtime_value', message: `${event.tool} contains a runtime value that cannot be recovered from redacted events`, caseId: activeCaseId, ...(event.id ? { eventId: event.id } : {}) })
      continue
    }
    activeAttempt?.code.push(replayable)
  }

  const cases = new Map<string, string[]>()
  for (const caseId of passedCaseIds ?? []) {
    const candidates = (attempts.get(caseId) ?? []).filter((attempt) => attempt.complete)
    const selected = candidates.map((attempt) => replayCode(attempt)).findLast((code) => code !== undefined)
    if (selected) cases.set(caseId, selected)
    else {
      diagnostics.push(...(candidates.at(-1)?.diagnostics ?? []))
      diagnostics.push({ severity: 'error', code: candidates.length ? 'replayable_attempt_missing' : 'case_events_missing', message: candidates.length ? 'Passed case has no complete replayable attempt with an assertion' : 'Passed case has no complete execution attempt', caseId })
    }
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
