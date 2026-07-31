import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { LocatorIR } from '../core/types.js'
import type { WorkflowDraftLocatorTarget } from './planner-types.js'
import type { WorkflowLocatorInspection, WorkflowPageEvidence } from './runtime-types.js'
import { runStructuredModelWithFallback } from './structured-model-cli.js'

export interface WorkflowLocatorResolutionRequest {
  targetId: string
  operation: 'click' | 'fill' | 'press' | 'check' | 'ensureChecked' | 'select' | 'assertion' | 'refresh'
  target: WorkflowDraftLocatorTarget
  page: WorkflowPageEvidence
  workspaceDirectory: string
  attempt?: number
  rejections?: Array<{ locator: LocatorIR; inspection: WorkflowLocatorInspection }>
}

export interface WorkflowLocatorResolution {
  locator: LocatorIR
  reasoning: string
}

export interface WorkflowLocatorResolver {
  readonly name: string
  resolve(request: WorkflowLocatorResolutionRequest): Promise<WorkflowLocatorResolution>
}

export class CodexCliWorkflowLocatorResolver implements WorkflowLocatorResolver {
  readonly name = 'codex-cli+claude-cli-fallback'

  constructor(
    private readonly options: {
      executable?: string
      fallbackExecutable?: string
      model?: string
      timeoutMs?: number
      outputSchemaPath?: string
    } = {},
  ) {}

  async resolve(request: WorkflowLocatorResolutionRequest): Promise<WorkflowLocatorResolution> {
    const prompt = [
      'You resolve exactly one Playwright locator for a controlled web-test exploration step.',
      'Return only the structured response. Do not call tools. Do not output or infer field values, credentials, phone numbers, codes, or row data.',
      'Prefer role/name, label, placeholder, testId, text, then a unique CSS selector from the supplied inventory. XPath is last resort.',
      'The locator must identify the described element on the current page, not a nearby label or container.',
      'For click/fill/press/check/select/refresh, only choose an element shown in the ARIA snapshot or interactiveElements with visible=true and enabled=true.',
      'For ensureChecked, choose a stable visible switch control or wrapper that remains locatable in both checked states. Never use state-dependent selectors such as .is-checked, :checked, [checked], or [aria-checked=true/false].',
      'Never repeat a locator listed in Rejected live candidates. Treat its Playwright inspection as authoritative.',
      '',
      `Operation: ${request.operation}`,
      `Target ID: ${request.targetId}`,
      `Description: ${request.target.description}`,
      `Source refs: ${request.target.sourceRefs.join(', ')}`,
      `Existing candidates: ${JSON.stringify(request.target.candidates)}`,
      `Rejected live candidates: ${JSON.stringify(request.rejections ?? [])}`,
      '',
      'Sanitized page evidence:',
      JSON.stringify(request.page, null, 2),
      '',
      'locatorJson must encode LocatorIR: {strategy,value,optional name,optional exact,source:"aiSuggested"}.',
    ].join('\n')
    const args = [
      'exec', '-', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-rules',
      '--color', 'never', '--output-schema', resolve(this.options.outputSchemaPath ?? 'schemas/workflow-locator-response.schema.json'),
      '-C', request.workspaceDirectory,
    ]
    if (this.options.model) args.push('--model', this.options.model)
    const result = await runStructuredModelWithFallback({
      codexExecutable: this.options.executable ?? 'codex',
      codexArgs: args,
      claudeExecutable: this.options.fallbackExecutable ?? 'claude',
      prompt,
      cwd: request.workspaceDirectory,
      timeoutMs: this.options.timeoutMs ?? 5 * 60_000,
      outputSchemaPath: resolve(this.options.outputSchemaPath ?? 'schemas/workflow-locator-response.schema.json'),
      allowClaudeFallback: true,
    })
    const output = result.output
    await mkdir(request.workspaceDirectory, { recursive: true, mode: 0o750 })
    const safeTargetId = request.targetId.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 128)
    await writeFile(resolve(request.workspaceDirectory, `${safeTargetId}.locator-response-${request.attempt ?? 1}.json`), `${output.trim()}\n`, { encoding: 'utf8', mode: 0o640 })
    const response = JSON.parse(output) as { locatorJson?: unknown; reasoning?: unknown }
    if (typeof response.locatorJson !== 'string' || typeof response.reasoning !== 'string') throw new Error('Locator resolver response is invalid')
    if (!response.locatorJson.trim()) throw new Error(`Locator resolver found no valid live element: ${response.reasoning}`)
    const locator = JSON.parse(response.locatorJson) as LocatorIR | null
    if (locator === null || (
      typeof locator === 'object' && locator !== null && Object.keys(locator).length === 0
    )) throw new Error(`Locator resolver found no valid live element: ${response.reasoning}`)
    if (
      !locator || !['role', 'testId', 'label', 'placeholder', 'text', 'css', 'xpath'].includes(locator.strategy) ||
      typeof locator.value !== 'string' || !locator.value.trim()
    ) throw new Error('Locator resolver returned an invalid LocatorIR')
    return { locator: { ...locator, source: 'aiSuggested' }, reasoning: response.reasoning }
  }
}
