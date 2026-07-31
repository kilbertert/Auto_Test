import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { refineWorkflowDraftFromExploration, readSanitizedPageEvidence, validateLiveLocatorTextOracleChanges } from '../src/workflow/plan-refinement.js'
import type { CodexCliWorkflowPlanner } from '../src/workflow/planner-provider.js'
import type { WorkflowPlanDraft } from '../src/workflow/planner-types.js'

const temporaryDirectories: string[] = []

function draftWithOracle(expected: string): WorkflowPlanDraft {
  return {
    version: '1.0',
    kind: 'workflow-plan-draft',
    workflowId: 'oracle-fixture',
    sourceSha256: 'a'.repeat(64),
    targets: [{ id: 'app', baseUrl: 'https://app.example.test/', allowedOrigins: ['https://app.example.test/'] }],
    dataBindings: [],
    groups: [{
      id: 'single',
      phases: [{
        id: 'switch-state',
        title: 'switch state',
        targetId: 'app',
        risk: 'read',
        contextMode: 'shared',
        steps: [{ id: 'open', kind: 'navigate', sourceRefs: ['cell:A2'] }],
        assertions: [{
          id: 'state-text',
          kind: 'locatorText',
          target: { description: 'state text', candidates: [], sourceRefs: ['cell:B2'] },
          operator: 'contains',
          expected: { literal: expected },
          sourceRefs: ['cell:B2'],
        }],
        sourceRefs: ['cell:A2'],
      }],
    }],
    policy: { phaseTimeoutMs: 10_000, destructiveActions: 'requireApproval' },
    review: { status: 'draft', sourceRefs: ['source:fixture'], unresolvedAmbiguities: [] },
    planner: {
      provider: 'fixture', model: null, generatedAt: '2026-07-29T00:00:00.000Z',
      inputSha256: 'b'.repeat(64), imageSha256s: [], summary: [],
    },
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('workflow plan refinement evidence', () => {
  it('keeps newest evidence first and removes duplicate page snapshots', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-refinement-evidence-'))
    temporaryDirectories.push(directory)
    const newest = resolve(directory, 'round-2.json')
    const duplicate = resolve(directory, 'round-1.json')
    const older = resolve(directory, 'round-0.json')
    await writeFile(newest, '{"page":"current"}')
    await writeFile(duplicate, '{"page":"current"}')
    await writeFile(older, '{"page":"older"}')

    const evidence = await readSanitizedPageEvidence([newest, duplicate, older])

    expect(evidence).toContain(`FILE ${newest}`)
    expect(evidence).not.toContain(`FILE ${duplicate}`)
    expect(evidence).toContain(`FILE ${older}`)
    expect(evidence.indexOf(newest)).toBeLessThan(evidence.indexOf(older))
  })

  it('allows a locatorText literal correction only when exact live evidence supports it', () => {
    const before = draftWithOracle('已拔')
    const supported = draftWithOracle('未插')
    const unsupported = draftWithOracle('Disconnected')

    expect(() => validateLiveLocatorTextOracleChanges(before, supported, '{"ariaSnapshot":"- text: 未插"}')).not.toThrow()
    expect(() => validateLiveLocatorTextOracleChanges(before, unsupported, '{"ariaSnapshot":"- text: 未插"}')).toThrow(/without exact live-page evidence/i)
  })

  it('merges protected capture semantics before validating an incomplete refiner candidate', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-refinement-merge-'))
    temporaryDirectories.push(directory)
    const before = draftWithOracle('stable')
    before.groups[0]!.phases[0]!.steps.push({
      id: 'capture-device',
      kind: 'captureTableRow',
      entityName: 'device',
      table: { headerLabels: ['Device ID'], bodyOffset: 0 },
      match: [{ literal: 'DEVICE-1' }],
      idPattern: '\\b(DEVICE-1)\\b',
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      sourceRefs: ['cell:C2'],
    })
    const candidate = structuredClone(before) as unknown as Record<string, unknown>
    const candidateCapture = ((candidate.groups as Array<{ phases: Array<{ steps: Array<Record<string, unknown>> }> }>)[0]!.phases[0]!.steps)
      .find((step) => step.id === 'capture-device')!
    delete candidateCapture.idPattern
    const provider = {
      async refineFromExploration() {
        return { planJson: JSON.stringify(candidate), summary: ['fixture refinement'] }
      },
    } as unknown as CodexCliWorkflowPlanner

    const refined = await refineWorkflowDraftFromExploration({
      draft: before,
      exploration: {
        status: 'failed',
        runtimeResult: { status: 'failed', phases: [], steps: [], assertions: [] },
      } as never,
      pageEvidence: '{"ariaSnapshot":"stable"}',
      provider,
      workspaceDirectory: directory,
    })

    expect(refined.groups[0]!.phases[0]!.steps.find((step) => step.id === 'capture-device')).toMatchObject({
      idPattern: '\\b(DEVICE-1)\\b',
    })
  })
})
