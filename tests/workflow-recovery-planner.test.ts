import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkflowPlanDraft, WorkflowPlannerProvider } from '../src/workflow/planner-types.js'
import { missingRecoveryPhaseIds, planWorkflowRecoveryContracts } from '../src/workflow/recovery-planner.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function draft(): WorkflowPlanDraft {
  return {
    version: '1.0',
    kind: 'workflow-plan-draft',
    workflowId: 'recovery-fixture',
    sourceSha256: 'a'.repeat(64),
    targets: [{ id: 'app', baseUrl: 'https://app.example.test/', allowedOrigins: ['https://app.example.test/'] }],
    dataBindings: [],
    groups: [{
      id: 'flow',
      phases: [
        {
          id: 'create',
          title: 'create entity',
          targetId: 'app',
          risk: 'destructive',
          contextMode: 'shared',
          sourceRefs: ['cell:A2'],
          steps: [{ id: 'create-click', kind: 'click', target: { description: 'create', candidates: [], sourceRefs: ['cell:A2'] }, sourceRefs: ['cell:A2'] }],
          assertions: [{ id: 'created', kind: 'url', operator: 'contains', expected: { literal: '/created' }, sourceRefs: ['cell:B2'] }],
        },
        {
          id: 'cleanup',
          title: 'cleanup entity',
          targetId: 'app',
          risk: 'destructive',
          contextMode: 'shared',
          sourceRefs: ['cell:A3'],
          steps: [{ id: 'cleanup-click', kind: 'click', target: { description: 'cleanup', candidates: [], sourceRefs: ['cell:A3'] }, sourceRefs: ['cell:A3'] }],
          assertions: [{ id: 'clean', kind: 'url', operator: 'contains', expected: { literal: '/clean' }, sourceRefs: ['cell:B3'] }],
        },
      ],
    }],
    policy: { phaseTimeoutMs: 10_000, destructiveActions: 'requireApproval' },
    review: { status: 'draft', sourceRefs: ['source:fixture'], unresolvedAmbiguities: [] },
    planner: {
      provider: 'fixture',
      model: null,
      generatedAt: '2026-07-29T00:00:00.000Z',
      inputSha256: 'b'.repeat(64),
      imageSha256s: [],
      summary: [],
    },
  }
}

async function workspace(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-recovery-planner-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('workflow recovery planner', () => {
  it('adds recovery contracts without changing protected workflow semantics', async () => {
    const input = draft()
    const candidate = structuredClone(input)
    candidate.groups[0]!.phases[0]!.recovery = {
      strategy: 'compensate',
      phaseIds: ['cleanup'],
      maxAttempts: 1,
      sourceRefs: ['cell:A3', 'policy:owned-cleanup'],
    }
    candidate.groups[0]!.phases[1]!.recovery = {
      strategy: 'retry',
      maxAttempts: 1,
      sourceRefs: ['cell:A3', 'policy:idempotent-cleanup'],
    }
    const provider: WorkflowPlannerProvider = {
      name: 'fixture',
      model: null,
      async generate() { throw new Error('not used') },
      async planRecovery() { return { planJson: JSON.stringify(candidate), summary: ['Added bounded recovery contracts'] } },
    }

    const result = await planWorkflowRecoveryContracts({ draft: input, provider, workspaceDirectory: await workspace() })

    expect(missingRecoveryPhaseIds(result)).toEqual([])
    expect(result.groups[0]!.phases[0]!.recovery).toMatchObject({ strategy: 'compensate', phaseIds: ['cleanup'] })
    expect(result.planner.summary).toContain('Added bounded recovery contracts')
  })

  it('allows recovery to remain absent when the source does not authorize a safe contract', async () => {
    const input = draft()
    const provider: WorkflowPlannerProvider = {
      name: 'fixture',
      model: null,
      async generate() { throw new Error('not used') },
      async planRecovery() {
        return {
          planJson: JSON.stringify(input),
          summary: ['Left unsupported recovery contracts absent for policy review'],
        }
      },
    }

    const result = await planWorkflowRecoveryContracts({ draft: input, provider, workspaceDirectory: await workspace() })

    expect(missingRecoveryPhaseIds(result)).toEqual(['create', 'cleanup'])
    expect(result.planner.summary).toContain('Left unsupported recovery contracts absent for policy review')
  })

  it('preserves protected assertions when a recovery response also changes them', async () => {
    const input = draft()
    const candidate = structuredClone(input)
    candidate.groups[0]!.phases[0]!.assertions[0] = { id: 'created', kind: 'url', operator: 'contains', expected: { literal: '/anything' }, sourceRefs: ['cell:B2'] }
    candidate.groups[0]!.phases[0]!.recovery = { strategy: 'retry', maxAttempts: 1, sourceRefs: ['policy:idempotent'] }
    candidate.groups[0]!.phases[1]!.recovery = { strategy: 'retry', maxAttempts: 1, sourceRefs: ['policy:idempotent'] }
    const provider: WorkflowPlannerProvider = {
      name: 'fixture',
      model: null,
      async generate() { throw new Error('not used') },
      async planRecovery() { return { planJson: JSON.stringify(candidate), summary: [] } },
    }

    const result = await planWorkflowRecoveryContracts({ draft: input, provider, workspaceDirectory: await workspace() })

    expect(result.groups[0]!.phases[0]!.assertions[0]).toEqual(input.groups[0]!.phases[0]!.assertions[0])
    expect(result.groups[0]!.phases[0]!.recovery).toMatchObject({ strategy: 'retry', maxAttempts: 1 })
  })

  it('repairs an invalid recovery response without changing protected workflow semantics', async () => {
    const input = draft()
    const invalid = structuredClone(input)
    invalid.groups[0]!.phases[0]!.recovery = {
      strategy: 'compensate',
      phaseIds: ['cleanup'],
      maxAttempts: 4,
      sourceRefs: ['cell:A3', 'policy:owned-cleanup'],
    }
    invalid.groups[0]!.phases[1]!.recovery = {
      strategy: 'retry',
      maxAttempts: 1,
      sourceRefs: ['cell:A3', 'policy:idempotent-cleanup'],
    }
    const repaired = structuredClone(invalid)
    repaired.groups[0]!.phases[0]!.recovery!.maxAttempts = 1
    let repairError = ''
    const provider: WorkflowPlannerProvider = {
      name: 'fixture',
      model: null,
      async generate() { throw new Error('not used') },
      async planRecovery() { return { planJson: JSON.stringify(invalid), summary: ['Invalid first attempt'] } },
      async repair(_request, _previous, validationError) {
        repairError = validationError
        return { planJson: JSON.stringify(repaired), summary: ['Repaired bounded recovery contracts'] }
      },
    }
    const directory = await workspace()

    const result = await planWorkflowRecoveryContracts({ draft: input, provider, workspaceDirectory: directory })

    expect(repairError).toMatch(/maxAttempts must be from 1 to 3/)
    expect(result.groups[0]!.phases[0]!.recovery?.maxAttempts).toBe(1)
    expect(result.planner.summary).toContain('Repaired bounded recovery contracts')
    await expect(readFile(resolve(directory, 'recovery-planner-response-1.json'), 'utf8')).resolves.toContain('Invalid first attempt')
    await expect(readFile(resolve(directory, 'recovery-planner-response-2.json'), 'utf8')).resolves.toContain('Repaired bounded recovery contracts')
    await expect(readFile(resolve(directory, 'recovery-planner-response.json'), 'utf8')).resolves.toContain('Repaired bounded recovery contracts')
  })
})
