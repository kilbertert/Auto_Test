import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  diagnosticErrorDetails,
  runWithWorkflowProgress,
  WorkflowProgressRecorder,
  type WorkflowDiagnosticEventInput,
  type WorkflowProgressSink,
} from '../src/workflow/diagnostics.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('workflow diagnostics', () => {
  it('extracts an indexed draft location from validation failures', () => {
    expect(diagnosticErrorDetails(new Error(
      'Invalid workflow plan draft: groups[0].phases[1].steps[3].sourceRefs must contain source references',
    ))).toMatchObject({
      location: 'groups[0].phases[1].steps[3].sourceRefs',
    })
  })

  it('emits heartbeats while a model-like operation is still running', async () => {
    const events: WorkflowDiagnosticEventInput[] = []
    const sink: WorkflowProgressSink = { async emit(event) { events.push(event) } }

    const result = await runWithWorkflowProgress(sink, {
      stage: 'planning',
      operation: 'planner.generate',
      attempt: 1,
      maxAttempts: 3,
      heartbeatIntervalMs: 5,
      startMessage: 'start',
      heartbeatMessage: () => 'heartbeat',
      successMessage: () => 'success',
    }, async () => {
      await new Promise((done) => setTimeout(done, 18))
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(events[0]).toMatchObject({ kind: 'operation_started', attempt: 1, maxAttempts: 3 })
    expect(events.some((event) => event.kind === 'heartbeat')).toBe(true)
    expect(events.at(-1)).toMatchObject({ kind: 'operation_succeeded' })
  })

  it('appends redacted private JSONL events with monotonic sequence numbers', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-diagnostics-'))
    temporaryDirectories.push(directory)
    const path = resolve(directory, 'run-events.jsonl')
    const printed: string[] = []
    const first = await WorkflowProgressRecorder.open(path, (message) => printed.push(message))
    await first.emit({
      kind: 'information',
      stage: 'planning',
      operation: 'fixture',
      message: 'password: synthetic-secret',
    })
    const resumed = await WorkflowProgressRecorder.open(path, (message) => printed.push(message))
    await resumed.emit({
      kind: 'information',
      stage: 'planning',
      operation: 'fixture',
      message: 'resumed',
    })

    const events = (await readFile(path, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { sequence: number; message: string })
    expect(events.map((event) => event.sequence)).toEqual([1, 2])
    expect(JSON.stringify(events)).not.toContain('synthetic-secret')
    expect(printed.join('\n')).not.toContain('synthetic-secret')
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o077).toBe(0)
  })
})
