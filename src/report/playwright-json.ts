import { basename, relative, resolve } from 'node:path'
import { redactSensitiveText } from '../input/text.js'
import type {
  ParsedPlaywrightCase,
  PlaywrightAttachmentEvidence,
  PlaywrightExecutionEvidence,
  PlaywrightStepEvidence,
} from './types.js'

interface RawError {
  message?: string
  value?: string
  stack?: string
}

interface RawResult {
  status?: string
  duration?: number
  retry?: number
  startTime?: string
  errors?: RawError[]
  steps?: Array<{ title?: string; duration?: number; error?: RawError }>
  attachments?: Array<{ name?: string; contentType?: string; path?: string }>
}

interface RawTest {
  expectedStatus?: string
  projectName?: string
  status?: string
  results?: RawResult[]
}

interface RawSpec {
  title?: string
  file?: string
  line?: number
  tests?: RawTest[]
}

interface RawSuite {
  suites?: RawSuite[]
  specs?: RawSpec[]
}

interface RawPlaywrightReport {
  suites?: RawSuite[]
}

function sanitize(value: string): string {
  let redacted = value
  for (const [name, secret] of Object.entries(process.env)) {
    if (name.startsWith('AUTO_TEST_SECRET_') && secret) redacted = redacted.replaceAll(secret, '[REDACTED]')
  }
  return redactSensitiveText(redacted)
}

function errorText(error: RawError | undefined): string | undefined {
  const value = error?.message ?? error?.value ?? error?.stack
  return value ? sanitize(value) : undefined
}

function attachmentEvidence(attachment: NonNullable<RawResult['attachments']>[number], repositoryRoot: string): PlaywrightAttachmentEvidence {
  let path: string | undefined
  if (attachment.path) {
    const absolute = resolve(attachment.path)
    const candidate = relative(repositoryRoot, absolute)
    path = candidate.startsWith('..') ? basename(absolute) : candidate
  }
  return {
    name: attachment.name ?? 'attachment',
    contentType: attachment.contentType ?? 'application/octet-stream',
    ...(path ? { path } : {}),
  }
}

function stepEvidence(step: NonNullable<RawResult['steps']>[number]): PlaywrightStepEvidence {
  const error = errorText(step.error)
  return {
    title: step.title ?? 'unnamed step',
    durationMs: step.duration ?? 0,
    ...(error ? { error } : {}),
  }
}

function executionStatus(test: RawTest, result: RawResult): PlaywrightExecutionEvidence['status'] {
  if (test.status === 'flaky') return 'flaky'
  if (test.status === 'skipped' || result.status === 'skipped') return 'skipped'
  if (test.status === 'expected' && result.status === 'passed') return 'passed'
  return 'failed'
}

function findCaseId(title: string, caseIds: string[]): string | undefined {
  return caseIds.find((caseId) => title === caseId || title.startsWith(`${caseId} `))
}

function collectSpecs(suites: RawSuite[]): RawSpec[] {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []),
    ...collectSpecs(suite.suites ?? []),
  ])
}

export function parsePlaywrightJsonReport(
  input: unknown,
  caseIds: string[],
  repositoryRoot = process.cwd(),
): ParsedPlaywrightCase[] {
  const raw = input as RawPlaywrightReport
  const cases = new Map<string, ParsedPlaywrightCase>()
  for (const spec of collectSpecs(raw.suites ?? [])) {
    const title = spec.title ?? ''
    const caseId = findCaseId(title, caseIds)
    if (!caseId) continue
    const item = cases.get(caseId) ?? {
      caseId,
      title,
      file: spec.file ?? '',
      line: spec.line ?? 0,
      executions: [],
    }
    for (const test of spec.tests ?? []) {
      for (const result of test.results ?? []) {
        item.executions.push({
          projectName: test.projectName ?? 'default',
          status: executionStatus(test, result),
          expectedStatus: test.expectedStatus ?? 'passed',
          durationMs: result.duration ?? 0,
          retryCount: result.retry ?? 0,
          ...(result.startTime ? { startTime: result.startTime } : {}),
          errors: (result.errors ?? []).map(errorText).filter((value): value is string => Boolean(value)),
          steps: (result.steps ?? []).map(stepEvidence),
          attachments: (result.attachments ?? []).map((attachment) => attachmentEvidence(attachment, repositoryRoot)),
        })
      }
    }
    cases.set(caseId, item)
  }
  return [...cases.values()]
}
