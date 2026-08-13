import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateReplayAssets } from '../src/agent/replay-assets.js'
import type { CodexTestAgentResult } from '../src/agent/types.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'

function event(id: string, server: string, tool: string, arguments_: object, text = ''): object {
  return { type: 'item.completed', item: { id, type: 'mcp_tool_call', server, tool, arguments: arguments_, result: { content: [{ type: 'text', text }] }, status: 'completed' } }
}

describe('replay assets', () => {
  it('writes one candidate spec and private-context config per passed case', async () => {
    const outputDirectory = await mkdtemp(resolve(tmpdir(), 'auto-test-replay-assets-'))
    const eventsPath = resolve(outputDirectory, 'codex-agent.events.jsonl')
    const events = [
      event('1', 'auto-test-control', 'case_execution_begin', { caseId: 'case-one' }),
      event('2', 'playwright', 'browser_navigate', {}, "### Ran Playwright code\n```js\nawait page.goto('https://example.test');\n```"),
      event('3', 'playwright', 'browser_verify_text_visible', {}, "### Ran Playwright code\n```js\nawait expect(page.getByText('Ready')).toBeVisible();\n```"),
      event('4', 'auto-test-control', 'case_execution_end', { caseId: 'case-one' }),
    ]
    const jsonl = events.map((item) => JSON.stringify(item)).join('\n') + '\n'
    await writeFile(eventsPath, jsonl)
    const result = {
      version: '1.0', workflowId: 'fixture', sourceSha256: 'a'.repeat(64), outcome: 'passed', summary: 'passed',
      startedAt: '', finishedAt: '', cases: [{ caseId: 'case-one', title: 'one', outcome: 'passed', summary: 'passed', evidence: [{ kind: 'observation', description: 'ready' }] }],
      mutations: [], environmentRequirements: [], blockers: [], productDefects: [], nextActions: [],
    } satisfies CodexTestAgentResult
    const manifest = {
      version: '1.0', kind: 'workflow-intake', workflowId: 'fixture', source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'a'.repeat(64) },
      targetUrls: [], requiredCapabilities: [], phases: [], embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
    } satisfies WorkflowIntakeManifest
    const assets = await generateReplayAssets({
      outputDirectory, eventsPath, result, manifest,
      storageStatePath: resolve(outputDirectory, '.agent-private/state.json'),
      initPagePath: resolve(outputDirectory, '.agent-private/init-page.cjs'),
      secretsPath: resolve(outputDirectory, '.agent-private/secrets.env'),
    })

    expect(assets.cases).toMatchObject([{ caseId: 'case-one', status: 'candidate' }])
    const spec = await readFile(assets.cases[0]!.specPath!, 'utf8')
    const config = await readFile(assets.cases[0]!.configPath!, 'utf8')
    expect(spec).toContain('test.beforeEach')
    expect(config).toContain('storageState')
    expect(config).toContain('secrets.env')
  })
})
