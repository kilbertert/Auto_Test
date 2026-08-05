import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { CodexTestAgentState } from './types.js'

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') await chmod(temporary, 0o600)
  await rename(temporary, path)
  if (process.platform !== 'win32') await chmod(path, 0o600)
}

export function initialCodexTestState(workflowId: string, sourceSha256: string): CodexTestAgentState {
  const now = new Date().toISOString()
  return {
    version: '2.0',
    status: 'running',
    stage: 'preparing',
    workflowId,
    sourceSha256,
    startedAt: now,
    updatedAt: now,
    threadGeneration: 0,
    completedCaseIds: [],
  }
}

export function updateCodexTestState(
  state: CodexTestAgentState,
  patch: Partial<CodexTestAgentState>,
): CodexTestAgentState {
  return { ...state, ...patch, updatedAt: new Date().toISOString() }
}
