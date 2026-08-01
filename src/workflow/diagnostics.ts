import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { redactSensitiveContent } from '../input/text.js'

export type WorkflowDiagnosticStage =
  | 'intake'
  | 'environment'
  | 'planning'
  | 'recovery_planning'
  | 'exploring'
  | 'refining'
  | 'policy_gate'
  | 'executing'
  | 'reporting'

export type WorkflowDiagnosticEventKind =
  | 'operation_started'
  | 'heartbeat'
  | 'operation_succeeded'
  | 'operation_failed'
  | 'validation_failed'
  | 'normalization_applied'
  | 'information'

export interface WorkflowDiagnosticEvent {
  version: '1.0'
  sequence: number
  at: string
  kind: WorkflowDiagnosticEventKind
  stage: WorkflowDiagnosticStage
  operation: string
  message: string
  attempt?: number
  maxAttempts?: number
  elapsedMs?: number
  code?: string
  location?: string
  artifactPath?: string
  details?: Record<string, unknown>
}

export type WorkflowDiagnosticEventInput = Omit<WorkflowDiagnosticEvent, 'version' | 'sequence' | 'at'>

export interface WorkflowProgressSink {
  emit(event: WorkflowDiagnosticEventInput): Promise<void>
}

export interface WorkflowProgressOperation {
  stage: WorkflowDiagnosticStage
  operation: string
  attempt?: number
  maxAttempts?: number
  startMessage: string
  heartbeatMessage: (elapsedMs: number) => string
  successMessage: (elapsedMs: number) => string
  failureMessage?: (elapsedMs: number, error: unknown) => string
  heartbeatIntervalMs?: number
}

function safeMessage(value: string): string {
  return redactSensitiveContent(value).slice(0, 8_000)
}

function safeDetails(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined
  try {
    return JSON.parse(redactSensitiveContent(JSON.stringify(value))) as Record<string, unknown>
  } catch {
    return { omitted: 'Diagnostic details could not be safely serialized.' }
  }
}

function existingSequence(content: string): number {
  return content.split(/\r?\n/).filter(Boolean).reduce((maximum, line) => {
    try {
      const event = JSON.parse(line) as { sequence?: unknown }
      return typeof event.sequence === 'number' ? Math.max(maximum, event.sequence) : maximum
    } catch {
      return maximum
    }
  }, 0)
}

export class WorkflowProgressRecorder implements WorkflowProgressSink {
  private writeQueue: Promise<void> = Promise.resolve()

  private constructor(
    readonly path: string,
    private sequence: number,
    private readonly print: (message: string) => void,
  ) {}

  static async open(path: string, print: (message: string) => void = console.log): Promise<WorkflowProgressRecorder> {
    const content = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    return new WorkflowProgressRecorder(path, existingSequence(content), print)
  }

  async emit(input: WorkflowDiagnosticEventInput): Promise<void> {
    const details = safeDetails(input.details)
    const { details: _details, ...rest } = input
    const event: WorkflowDiagnosticEvent = {
      ...rest,
      version: '1.0',
      sequence: ++this.sequence,
      at: new Date().toISOString(),
      message: safeMessage(input.message),
      ...(details ? { details } : {}),
    }
    this.print(event.message)
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await appendFile(this.path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
      await chmod(this.path, 0o600)
    })
    await this.writeQueue.catch(() => {
      this.print('[Diagnostics] 运行诊断写入失败；测试流程将继续。')
    })
  }
}

export function diagnosticErrorDetails(error: unknown): { code: string; location?: string; message: string } {
  const input = error as { code?: unknown; location?: unknown; message?: unknown }
  const message = safeMessage(error instanceof Error ? error.message : String(error))
  const parsedLocation = /^Invalid workflow plan draft: (groups\[\d+\](?:\.[^ ]+)*) /.exec(message)?.[1]
  return {
    code: typeof input?.code === 'string' ? input.code : 'workflow_operation_failed',
    ...(typeof input?.location === 'string' ? { location: input.location } : parsedLocation ? { location: parsedLocation } : {}),
    message,
  }
}

export async function runWithWorkflowProgress<T>(
  sink: WorkflowProgressSink | undefined,
  progress: WorkflowProgressOperation,
  operation: () => Promise<T>,
): Promise<T> {
  if (!sink) return operation()
  const startedAt = Date.now()
  await sink.emit({
    kind: 'operation_started',
    stage: progress.stage,
    operation: progress.operation,
    message: progress.startMessage,
    ...(progress.attempt !== undefined ? { attempt: progress.attempt } : {}),
    ...(progress.maxAttempts !== undefined ? { maxAttempts: progress.maxAttempts } : {}),
  })
  const heartbeatIntervalMs = progress.heartbeatIntervalMs ?? 15_000
  const timer = setInterval(() => {
    const elapsedMs = Date.now() - startedAt
    void sink.emit({
      kind: 'heartbeat',
      stage: progress.stage,
      operation: progress.operation,
      message: progress.heartbeatMessage(elapsedMs),
      elapsedMs,
      ...(progress.attempt !== undefined ? { attempt: progress.attempt } : {}),
      ...(progress.maxAttempts !== undefined ? { maxAttempts: progress.maxAttempts } : {}),
    }).catch(() => undefined)
  }, heartbeatIntervalMs)
  timer.unref?.()
  try {
    const result = await operation()
    const elapsedMs = Date.now() - startedAt
    await sink.emit({
      kind: 'operation_succeeded',
      stage: progress.stage,
      operation: progress.operation,
      message: progress.successMessage(elapsedMs),
      elapsedMs,
      ...(progress.attempt !== undefined ? { attempt: progress.attempt } : {}),
      ...(progress.maxAttempts !== undefined ? { maxAttempts: progress.maxAttempts } : {}),
    })
    return result
  } catch (error) {
    const elapsedMs = Date.now() - startedAt
    const details = diagnosticErrorDetails(error)
    await sink.emit({
      kind: 'operation_failed',
      stage: progress.stage,
      operation: progress.operation,
      message: progress.failureMessage?.(elapsedMs, error) ?? `${progress.operation} failed: ${details.message}`,
      elapsedMs,
      code: details.code,
      ...(details.location ? { location: details.location } : {}),
      ...(progress.attempt !== undefined ? { attempt: progress.attempt } : {}),
      ...(progress.maxAttempts !== undefined ? { maxAttempts: progress.maxAttempts } : {}),
    })
    throw error
  } finally {
    clearInterval(timer)
  }
}

export function elapsedSeconds(elapsedMs: number): string {
  return `${Math.max(1, Math.round(elapsedMs / 1_000))} 秒`
}
