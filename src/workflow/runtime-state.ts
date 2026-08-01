import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  WorkflowAssertionEvent,
  WorkflowCapturedEntity,
  WorkflowEntityEvent,
  WorkflowMutationEvent,
  WorkflowPhaseEvent,
  WorkflowRecoveryPhaseEvent,
  WorkflowStepEvent,
} from './runtime-types.js'

export interface WorkflowRunCursor {
  groupIndex: number
  iterationIndex: number
  phaseIndex: number
  nextStepIndex: number
  nextAssertionIndex: number
  activeTarget?: {
    kind: 'step' | 'assertion'
    id: string
  }
}

export interface WorkflowRunState {
  version: '1.0'
  workflowId: string
  sourceSha256: string
  planSha256: string
  runId: string
  maxIterationsPerGroup: number | null
  iterationOffsetPerGroup: number
  status: 'running' | 'interrupted'
  startedAt: string
  cursor: WorkflowRunCursor
  recoveryResumeTarget?: string
  entities: Record<string, WorkflowCapturedEntity>
  phases: WorkflowPhaseEvent[]
  steps: WorkflowStepEvent[]
  assertions: WorkflowAssertionEvent[]
  entityCaptures: WorkflowEntityEvent[]
  mutations: WorkflowMutationEvent[]
  recoveries: WorkflowRecoveryPhaseEvent[]
  error?: string
  updatedAt: string
}

export class WorkflowStateStore {
  constructor(readonly path: string) {}

  async load(): Promise<WorkflowRunState | undefined> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as WorkflowRunState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async save(state: WorkflowRunState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.path)
    await chmod(this.path, 0o600)
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
