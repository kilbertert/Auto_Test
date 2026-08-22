import { describe, expect, it } from 'vitest'
import { buildCodexExecutionEpochs, limitManifestToCases, manifestForExecutionEpoch, splitCodexExecutionEpoch } from '../src/agent/execution-epochs.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'

function manifest(): WorkflowIntakeManifest {
  return {
    version: '1.0', kind: 'workflow-intake', workflowId: 'epoch-fixture',
    source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'a'.repeat(64) },
    targetUrls: ['https://example.test/'], requiredCapabilities: [],
    phases: [1, 2, 3].map((index) => ({
      id: `case-${index}`, title: `Case ${index}`, sourceRow: index + 1, risk: 'read' as const,
      steps: [{ id: `step-${index}`, sourceText: 'x'.repeat(index * 120), confidence: 1 }],
      resources: [], secretBindings: [], imageIds: [`image-${index}`], review: { status: 'draft' as const, ambiguities: [] },
    })),
    embeddedImages: [1, 2, 3].map((index) => ({
      id: `image-${index}`, sheetName: 'Cases', sourceCell: `A${index + 1}`, sourceRow: index + 1,
      fileName: `image-${index}.png`, mediaType: 'image/png', bytes: 10, sha256: String(index).repeat(64), reviewStatus: 'required' as const,
    })),
    supplementalImages: [], review: { status: 'draft', reasons: [] },
  }
}

describe('Codex execution epoch planning', () => {
  it('keeps stable epoch identities when completed cases are removed during resume', () => {
    const capacity = { contextWindowTokens: 1_000, maxOutputTokens: 100, caseOutputTokens: 100, targetContextRatio: 0.5, targetOutputRatio: 0.5 }
    expect(buildCodexExecutionEpochs(manifest(), capacity).map((epoch) => epoch.id)).toEqual(['epoch-0001', 'epoch-0002', 'epoch-0003'])
    expect(buildCodexExecutionEpochs(manifest(), capacity, ['case-1']).map((epoch) => [epoch.id, epoch.caseIds])).toEqual([
      ['epoch-0002', ['case-2']],
      ['epoch-0003', ['case-3']],
    ])
  })

  it('bisects a capacity-exhausted epoch without changing case order or identity', () => {
    const workflow = manifest()
    const [left, right] = splitCodexExecutionEpoch(workflow, {
      id: 'epoch-0001', index: 0, total: 1,
      caseIds: ['case-1', 'case-2', 'case-3'],
      estimatedInputTokens: 1_500, estimatedOutputTokens: 2_700,
    })

    expect(left).toMatchObject({ id: 'epoch-0001-a', caseIds: ['case-1'], estimatedOutputTokens: 900 })
    expect(right).toMatchObject({ id: 'epoch-0001-b', caseIds: ['case-2', 'case-3'], estimatedOutputTokens: 1_800 })
    expect([...left!.caseIds, ...right!.caseIds]).toEqual(workflow.phases.map((phase) => phase.id))
  })

  it('keeps long suites in bounded automatic working sets', () => {
    const workflow = manifest()
    workflow.phases = [...workflow.phases, {
      id: 'case-4', title: 'Case 4', sourceRow: 5, risk: 'read',
      steps: [{ id: 'step-4', sourceText: 'x', confidence: 1 }], resources: [], secretBindings: [], imageIds: [],
      review: { status: 'draft', ambiguities: [] },
    }]
    expect(buildCodexExecutionEpochs(workflow, {
      contextWindowTokens: 1_000_000, maxOutputTokens: 1_000_000, caseOutputTokens: 1,
      maxCasesPerEpoch: 2, targetContextRatio: 0.9, targetOutputRatio: 0.9,
    }).map((epoch) => epoch.caseIds)).toEqual([
      ['case-1', 'case-2'], ['case-3', 'case-4'],
    ])
  })

  it('limits a canary manifest and retains only its referenced images', () => {
    const limited = limitManifestToCases(manifest(), 1)
    expect(limited.phases.map((phase) => phase.id)).toEqual(['case-1'])
    expect(limited.embeddedImages.map((image) => image.id)).toEqual(['image-1'])
    expect(limited.materialIndex?.map((item) => item.caseId)).toEqual(['case-1', 'case-2', 'case-3'])
    expect(limited.source.sha256).toBe('a'.repeat(64))
  })

  it('does not let unselected case references expand a canary target set', () => {
    const input = manifest()
    input.declaredTargetUrls = ['https://app.example.test/']
    input.targetUrls = ['https://app.example.test/', 'https://reference.example.test/']
    input.phases[0]!.resources = [{ sourceCell: 'A2', text: 'https://case-one.example.test/', urls: ['https://case-one.example.test/'] }]
    input.phases[1]!.resources = [{ sourceCell: 'A3', text: 'https://case-two.example.test/', urls: ['https://case-two.example.test/'] }]

    expect(limitManifestToCases(input, 1).targetUrls).toEqual([
      'https://app.example.test/',
      'https://case-one.example.test/',
    ])
  })

  it('rejects epochs that contain case IDs outside the immutable manifest', () => {
    expect(() => manifestForExecutionEpoch(manifest(), {
      id: 'epoch-unknown', index: 0, total: 1, caseIds: ['missing-case'], estimatedInputTokens: 500, estimatedOutputTokens: 900,
    })).toThrow(/outside the immutable manifest/)
  })

  it('keeps only active case details while retaining a compact run-wide material index', () => {
    const scoped = manifestForExecutionEpoch(manifest(), {
      id: 'epoch-0002', index: 1, total: 3, caseIds: ['case-2'], estimatedInputTokens: 500, estimatedOutputTokens: 900,
    })
    expect(scoped.phases.map((phase) => phase.id)).toEqual(['case-2'])
    expect(scoped.materialIndex?.map((item) => item.caseId)).toEqual(['case-1', 'case-2', 'case-3'])
    expect(JSON.stringify(scoped)).not.toContain('image-1.png')
  })
})
