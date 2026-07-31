import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { workflowExplorationRefinementPrompt, workflowPlannerPrompt, workflowPlannerRepairPrompt, workflowRecoveryPlanningPrompt } from './planner-prompt.js'
import { runStructuredModelWithFallback } from './structured-model-cli.js'
import type {
  WorkflowPlannerModelResponse,
  WorkflowPlannerProvider,
  WorkflowPlannerRequest,
} from './planner-types.js'

export interface CodexCliWorkflowPlannerOptions {
  executable?: string
  fallbackExecutable?: string
  model?: string
  outputSchemaPath?: string
  timeoutMs?: number
}

export class CodexCliWorkflowPlanner implements WorkflowPlannerProvider {
  readonly name = 'codex-cli+claude-cli-fallback'
  readonly model: string | null
  private readonly executable: string
  private readonly fallbackExecutable: string
  private readonly outputSchemaPath: string
  private readonly timeoutMs: number

  constructor(options: CodexCliWorkflowPlannerOptions = {}) {
    this.executable = options.executable ?? 'codex'
    this.fallbackExecutable = options.fallbackExecutable ?? 'claude'
    this.model = options.model ?? null
    this.outputSchemaPath = resolve(options.outputSchemaPath ?? 'schemas/workflow-planner-response.schema.json')
    this.timeoutMs = options.timeoutMs ?? 20 * 60_000
  }

  async generate(request: WorkflowPlannerRequest): Promise<WorkflowPlannerModelResponse> {
    return this.run(request, workflowPlannerPrompt(request), true)
  }

  async repair(
    request: WorkflowPlannerRequest,
    previous: WorkflowPlannerModelResponse,
    validationError: string,
  ): Promise<WorkflowPlannerModelResponse> {
    return this.run(request, workflowPlannerRepairPrompt(request, previous.planJson, validationError), true)
  }

  async refineFromExploration(
    request: WorkflowPlannerRequest,
    draftJson: string,
    explorationFeedback: string,
    pageEvidence: string,
  ): Promise<WorkflowPlannerModelResponse> {
    return this.run(request, workflowExplorationRefinementPrompt(draftJson, explorationFeedback, pageEvidence), true)
  }

  async planRecovery(request: WorkflowPlannerRequest, draftJson: string): Promise<WorkflowPlannerModelResponse> {
    return this.run(request, workflowRecoveryPlanningPrompt(draftJson), true)
  }

  private async run(request: WorkflowPlannerRequest, prompt: string, allowClaudeFallback: boolean): Promise<WorkflowPlannerModelResponse> {
    await mkdir(request.workspaceDirectory, { recursive: true, mode: 0o750 })
    const args = [
      'exec',
      '-',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--ignore-rules',
      '--color', 'never',
      '--output-schema', this.outputSchemaPath,
      '-C', request.workspaceDirectory,
    ]
    if (this.model) args.push('--model', this.model)
    for (const imagePath of request.imagePaths) args.push('--image', imagePath)
    const result = await runStructuredModelWithFallback({
      codexExecutable: this.executable,
      codexArgs: args,
      claudeExecutable: this.fallbackExecutable,
      prompt,
      cwd: request.workspaceDirectory,
      timeoutMs: this.timeoutMs,
      outputSchemaPath: this.outputSchemaPath,
      allowClaudeFallback,
      imagePaths: request.imagePaths,
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(result.output)
    } catch {
      throw new Error(`Planner returned invalid JSON: ${result.output.slice(0, 500)}`)
    }
    if (
      typeof parsed !== 'object' || parsed === null ||
      !('planJson' in parsed) || typeof parsed.planJson !== 'string' ||
      !('summary' in parsed) || !Array.isArray(parsed.summary) || parsed.summary.some((item) => typeof item !== 'string')
    ) {
      throw new Error('Planner response does not match the required outer schema')
    }
    return parsed as WorkflowPlannerModelResponse
  }
}
