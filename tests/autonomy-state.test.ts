import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AutonomousWorkflowJobStore,
  createAutonomousJobState,
  transitionAutonomousJob,
} from '../src/workflow/autonomy-state.js'

describe('autonomous workflow job store', () => {
  it('compacts oversized diagnostics before persisting private state', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-autonomy-state-'))
    try {
      const path = resolve(directory, 'autonomous-job.state.json')
      const store = new AutonomousWorkflowJobStore(path)
      const state = createAutonomousJobState('a'.repeat(64), '00000000-0000-4000-8000-000000000001')
      const diagnostic = `password: exposed-value\n${'provider payload '.repeat(1_000)}`
      transitionAutonomousJob(state, 'blocked', diagnostic)
      state.error = diagnostic

      await store.save(state)

      const persisted = await readFile(path, 'utf8')
      expect(persisted).not.toContain('exposed-value')
      expect(persisted).not.toContain('provider payload')
      expect(persisted).toContain('diagnostic omitted')
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
