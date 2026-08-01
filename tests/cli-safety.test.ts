import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkflowPlanExplorationReport } from '../src/workflow/plan-exploration.js'
import type { WorkflowPlanDraft } from '../src/workflow/planner-types.js'
import { validateWorkflowPlanDraft, workflowDraftSha256 } from '../src/workflow/planner-validation.js'

const temporaryDirectories: string[] = []
const tsxCli = resolve(import.meta.dirname, '../node_modules/tsx/dist/cli.mjs')

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function runCli(script: string, args: string[], cwd: string) {
  return spawnSync(process.execPath, [tsxCli, script, ...args], { cwd, encoding: 'utf8' })
}

function approvalFixtures(): { draft: WorkflowPlanDraft; exploration: WorkflowPlanExplorationReport } {
  const draft = validateWorkflowPlanDraft({
    version: '1.0',
    kind: 'workflow-plan-draft',
    workflowId: 'approval-fixture',
    sourceSha256: 'a'.repeat(64),
    targets: [{ id: 'app', baseUrl: 'https://app.example.test/', allowedOrigins: ['https://app.example.test/'] }],
    dataBindings: [],
    groups: [{
      id: 'single',
      phases: [{
        id: 'open', title: 'open', targetId: 'app', risk: 'read', contextMode: 'shared',
        steps: [{ id: 'navigate', kind: 'navigate', sourceRefs: ['phase:open'] }],
        assertions: [{ id: 'url', kind: 'url', operator: 'contains', expected: { literal: 'app.example.test' }, sourceRefs: ['phase:open'] }],
        sourceRefs: ['phase:open'],
      }],
    }],
    policy: { phaseTimeoutMs: 10_000, destructiveActions: 'requireApproval' },
    review: { status: 'draft', sourceRefs: ['source:fixture'], unresolvedAmbiguities: [] },
    planner: {
      provider: 'fixture', model: null, generatedAt: '2026-07-31T00:00:00.000Z',
      inputSha256: 'b'.repeat(64), imageSha256s: [], summary: [],
    },
  } satisfies WorkflowPlanDraft)
  return {
    draft,
    exploration: {
      version: '1.0',
      kind: 'workflow-plan-exploration',
      workflowId: draft.workflowId,
      sourceSha256: draft.sourceSha256,
      draftSha256: workflowDraftSha256(draft),
      startedAt: '2026-07-31T00:00:00.000Z',
      finishedAt: '2026-07-31T00:00:01.000Z',
      status: 'passed',
      runtimeResult: {
        version: '1.0', workflowId: draft.workflowId, sourceSha256: draft.sourceSha256,
        planSha256: 'c'.repeat(64), runId: 'fixture-run', startedAt: '2026-07-31T00:00:00.000Z',
        finishedAt: '2026-07-31T00:00:01.000Z', status: 'passed', phases: [], steps: [], assertions: [],
        entityCaptures: [], mutations: [], recoveries: [], entities: {},
      },
      locatorResolutions: [],
      tableResolutions: [],
      unresolvedTargetIds: [],
      unresolvedTableIds: [],
    },
  }
}

describe('CLI output safety', () => {
  it('derives a distinct source-map path for extensionless compile output', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-cli-compile-'))
    temporaryDirectories.push(directory)
    const input = resolve(directory, 'suite.json')
    const output = resolve(directory, 'compiled-suite')
    await copyFile(resolve(import.meta.dirname, '../examples/local-login-suite.ir.json'), input)

    const result = runCli(resolve(import.meta.dirname, '../src/cli/compile-ir.ts'), [
      '--ir', input,
      '--output', output,
    ], directory)

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(output, 'utf8')).toContain("import { expect, test }")
    expect(JSON.parse(await readFile(`${output}.map.json`, 'utf8'))).toMatchObject({ version: '1.0' })
  })

  it('rejects compile path collisions and missing option values', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-cli-collision-'))
    temporaryDirectories.push(directory)
    const input = resolve(directory, 'suite.json')
    const output = resolve(directory, 'suite.spec.ts')
    await copyFile(resolve(import.meta.dirname, '../examples/local-login-suite.ir.json'), input)

    const collision = runCli(resolve(import.meta.dirname, '../src/cli/compile-ir.ts'), [
      '--ir', input,
      '--output', output,
      '--map', output,
    ], directory)
    const missing = runCli(resolve(import.meta.dirname, '../src/cli/compile-ir.ts'), [
      '--ir', '--output', output,
    ], directory)

    expect(collision.status).toBe(1)
    expect(collision.stderr).toContain('不能使用同一路径')
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('--ir 必须提供取值')
  })

  it('rejects approval output that would overwrite source evidence', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-cli-approval-'))
    temporaryDirectories.push(directory)
    const draft = resolve(directory, 'draft.json')
    const exploration = resolve(directory, 'exploration.json')
    await writeFile(draft, '{}')
    await writeFile(exploration, '{}')

    const result = runCli(resolve(import.meta.dirname, '../src/cli/approve-workflow.ts'), [
      '--draft', draft,
      '--exploration', exploration,
      '--reviewer', 'fixture',
      '--approve',
      '--output', draft,
    ], directory)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('不能覆盖')
  })

  it('tightens permissions when approval overwrites an existing output file', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-cli-approval-mode-'))
    temporaryDirectories.push(directory)
    const draftPath = resolve(directory, 'draft.json')
    const explorationPath = resolve(directory, 'exploration.json')
    const output = resolve(directory, 'approved.json')
    const fixtures = approvalFixtures()
    await writeFile(draftPath, JSON.stringify(fixtures.draft))
    await writeFile(explorationPath, JSON.stringify(fixtures.exploration))
    await writeFile(output, 'stale')
    await chmod(output, 0o644)

    const result = runCli(resolve(import.meta.dirname, '../src/cli/approve-workflow.ts'), [
      '--draft', draftPath,
      '--exploration', explorationPath,
      '--reviewer', 'fixture',
      '--approve',
      '--output', output,
    ], directory)

    expect(result.status, result.stderr).toBe(0)
    if (process.platform !== 'win32') expect((await stat(output)).mode & 0o777).toBe(0o640)
  })

  it('rejects missing planner option values and invalid exploration iteration bounds', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-cli-args-'))
    temporaryDirectories.push(directory)
    const draftPath = resolve(directory, 'draft.json')
    await writeFile(draftPath, JSON.stringify(approvalFixtures().draft))

    const planning = runCli(resolve(import.meta.dirname, '../src/cli/plan-workflow.ts'), [
      '--intake', '--media-dir', directory,
    ], directory)
    const recovery = runCli(resolve(import.meta.dirname, '../src/cli/plan-recovery-workflow.ts'), [
      '--draft', '--output', resolve(directory, 'output.json'),
    ], directory)
    const exploration = runCli(resolve(import.meta.dirname, '../src/cli/explore-workflow.ts'), [
      '--draft', draftPath,
      '--max-iterations', 'NaN',
    ], directory)

    expect(planning.stderr).toContain('--intake 必须提供取值')
    expect(recovery.stderr).toContain('--draft 必须提供取值')
    expect(exploration.stderr).toContain('--max-iterations 必须是正整数')
  })

  it('validates workflow browser visibility options before reading the source workbook', () => {
    const script = resolve(import.meta.dirname, '../src/cli/workflow-pipeline.ts')
    const conflict = runCli(script, [
      '--file', 'missing.xlsx',
      '--headed',
      '--headless',
    ], process.cwd())
    const invalidSlowMo = runCli(script, [
      '--file', 'missing.xlsx',
      '--slow-mo', '-1',
    ], process.cwd())
    const missingSlowMo = runCli(script, [
      '--file', 'missing.xlsx',
      '--slow-mo',
    ], process.cwd())

    expect(conflict.stderr).toContain('--headed 与 --headless 不能同时使用')
    expect(invalidSlowMo.stderr).toContain('--slow-mo 必须是非负整数')
    expect(missingSlowMo.stderr).toContain('--slow-mo 必须提供取值')
  })
})
