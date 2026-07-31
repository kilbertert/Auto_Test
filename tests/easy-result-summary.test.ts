import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { friendlyRunSummary } from '../src/usability/result-summary.js'
import type { AutonomousWorkflowJobState, WorkflowHumanInputRequest } from '../src/workflow/autonomy-types.js'

function state(overrides: Partial<AutonomousWorkflowJobState>): AutonomousWorkflowJobState {
  return {
    version: '1.0',
    jobId: 'fixture-job',
    requestSha256: 'a'.repeat(64),
    status: 'completed',
    stage: 'completed',
    round: 2,
    environmentRetries: 0,
    executionAttempts: 1,
    events: [],
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:01:00.000Z',
    ...overrides,
  }
}

describe('friendly autonomous result summary', () => {
  it('summarizes a passed job without exposing internal state fields', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-result-'))
    try {
      const path = resolve(directory, 'state.json')
      await writeFile(path, JSON.stringify(state({ outcome: 'passed', runtimeResultPath: resolve(directory, 'runtime.json') })))

      const result = await friendlyRunSummary(path)

      expect(result.title).toBe('测试通过')
      expect(result.lines.join(' ')).toContain('1 次正式执行')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('turns structured human-input questions into concise Chinese actions', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-blocked-'))
    try {
      const requestPath = resolve(directory, 'request.json')
      const statePath = resolve(directory, 'state.json')
      const request: WorkflowHumanInputRequest = {
        version: '1.0', kind: 'workflow-human-input-request', requestId: 'request', jobId: 'fixture-job',
        status: 'pending', createdAt: '2026-07-31T00:00:00.000Z', blockedBy: 'missing data',
        questions: [{
          id: 'test-data.private-input', kind: 'test_data', prompt: 'internal prompt', reasons: [], sourceRefs: [],
        }],
        responseInstructions: [],
      }
      await writeFile(requestPath, JSON.stringify(request))
      await writeFile(resolve(directory, 'run-events.jsonl'), '{}\n')
      await writeFile(statePath, JSON.stringify(state({
        status: 'blocked', stage: 'blocked', outcome: 'blocked', humanInputRequestPath: requestPath,
      })))

      const result = await friendlyRunSummary(statePath)

      expect(result.title).toBe('测试暂时无法继续')
      expect(result.lines).toContain('缺少账号、验证码来源或其他私有测试数据。')
      expect(result.lines.some((line) => line.includes('run-events.jsonl'))).toBe(true)
      expect(result.lines).not.toContain('internal prompt')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
