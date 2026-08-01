import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { redactSensitiveContent } from '../input/text.js'
import type { AutonomousWorkflowJobState, AutonomousWorkflowStage } from './autonomy-types.js'

const MAX_RETAINED_DIAGNOSTIC_LENGTH = 8_000

function retainedMessage(message: string): string {
  const redacted = redactSensitiveContent(message)
  if (redacted.length <= MAX_RETAINED_DIAGNOSTIC_LENGTH) return redacted
  return `Autonomous diagnostic omitted because it exceeded the ${MAX_RETAINED_DIAGNOSTIC_LENGTH}-character retention limit.`
}

export class AutonomousWorkflowJobStore {
  constructor(readonly path: string) {}

  async load(): Promise<AutonomousWorkflowJobState | undefined> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as AutonomousWorkflowJobState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async save(state: AutonomousWorkflowJobState): Promise<void> {
    state.updatedAt = new Date().toISOString()
    state.events = state.events.map((event) => ({ ...event, message: retainedMessage(event.message) }))
    if (state.error) state.error = retainedMessage(state.error)
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.path)
    await chmod(this.path, 0o600)
  }
}

export function createAutonomousJobState(requestSha256: string, jobId = randomUUID()): AutonomousWorkflowJobState {
  const now = new Date().toISOString()
  return {
    version: '1.0',
    jobId,
    requestSha256,
    status: 'running',
    stage: 'planning',
    round: 0,
    environmentRetries: 0,
    executionAttempts: 0,
    events: [{ sequence: 1, at: now, stage: 'planning', message: 'Autonomous workflow job created' }],
    createdAt: now,
    updatedAt: now,
  }
}

export function transitionAutonomousJob(
  state: AutonomousWorkflowJobState,
  stage: AutonomousWorkflowStage,
  message: string,
): void {
  state.stage = stage
  state.events.push({
    sequence: state.events.length + 1,
    at: new Date().toISOString(),
    stage,
    message: retainedMessage(message),
  })
}
