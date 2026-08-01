import { Codex, type Input, type Thread, type ThreadEvent } from '@openai/codex-sdk'
import { chromium } from '@playwright/test'
import { constants as fsConstants } from 'node:fs'
import { access, chmod, readFile, writeFile } from 'node:fs/promises'
import { delimiter, dirname, extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EnvironmentProfile } from '../workflow/environment-profile.js'
import type { WorkflowIntakeManifest } from '../workflow/types.js'
import { codexTestAgentPrompt } from './prompt.js'
import { redactAgentValue, secretValues } from './redact.js'
import { enforceMutationLedger } from './result.js'
import { initialCodexTestState, updateCodexTestState, writePrivateJson } from './state.js'
import type { CodexTestAgentResult, CodexTestAgentState, CodexTestCaseDecision, CodexTestMutationLedgerEntry } from './types.js'
import { prepareCodexAgentWorkspace } from './workspace.js'

export interface CodexTestAgentOptions {
  outputDirectory: string
  manifest: WorkflowIntakeManifest
  profile: EnvironmentProfile
  secrets: Record<string, string | string[]>
  environmentContext: string
  imagePaths: string[]
  headed: boolean
  slowMo?: number
  maxIterations?: number
  model?: string
  codexExecutable?: string
  codexHome?: string
  maxFinalizationTurns?: number
}

export interface CodexTestAgentRun {
  state: CodexTestAgentState
  result?: CodexTestAgentResult
}

interface AgentThread {
  readonly id: string | null
  runStreamed(input: Input, options?: { outputSchema?: unknown }): Promise<{ events: AsyncGenerator<ThreadEvent> }>
}

interface AgentEvidenceNote {
  caseId: string
  kind: CodexTestAgentResult['cases'][number]['evidence'][number]['kind']
  description: string
  path?: string
}

interface AgentPlan {
  steps?: Array<{ id: string; status: 'pending' | 'in_progress' | 'passed' | 'failed' | 'blocked' }>
}

export interface CodexTestAgentDependencies {
  startThread?: (options: { workspaceDirectory: string; agentHome: string; model?: string; codexExecutable: string; playwrightConfigPath: string; playwrightSecretsPath: string; controlConfigPath: string; codexEnvironment: Record<string, string>; mcpEnvironment: Record<string, string> }) => AgentThread
  browserExecutablePath?: string
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))

function packageFilePath(packageName: string, fileName: string): string {
  const packagePath = import.meta.resolve(`${packageName}/package.json`)
  return resolve(dirname(fileURLToPath(packagePath)), fileName)
}

function controlServerPath(): string {
  const extension = extname(fileURLToPath(import.meta.url)) === '.ts' ? '.ts' : '.js'
  return resolve(moduleDirectory, `control-server${extension}`)
}

function executableNames(command: string, environment: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32' || extname(command)) return [command]
  const extensions = (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)]
}

async function executableFromPath(command: string, environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const pathValue = environment.Path ?? environment.PATH ?? ''
  const directories = pathValue.split(delimiter).filter((directory) => {
    if (!directory) return false
    return !/[\\/]node_modules[\\/]\.bin(?:[\\/]|$)/i.test(directory)
  })
  for (const directory of directories) {
    for (const name of executableNames(command, environment)) {
      const candidate = resolve(directory, name)
      try {
        await access(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        // Continue searching the user PATH.
      }
    }
  }
  return undefined
}

async function resolveCodexExecutable(options: CodexTestAgentOptions): Promise<string> {
  const configured = options.codexExecutable || process.env.AUTO_TEST_CODEX_BIN
  if (configured) {
    const candidate = isAbsolute(configured) ? configured : resolve(configured)
    await access(candidate, fsConstants.X_OK).catch(() => {
      throw new Error(`Configured Codex CLI executable is unavailable: ${candidate}`)
    })
    return candidate
  }
  const candidate = await executableFromPath('codex', process.env)
  if (!candidate) {
    throw new Error('Current Codex CLI executable was not found outside dependency node_modules/.bin directories. Install Codex CLI or set AUTO_TEST_CODEX_BIN.')
  }
  return candidate
}

function startSdkThread(options: {
  workspaceDirectory: string
  agentHome: string
  model?: string
  codexExecutable: string
  playwrightConfigPath: string
  playwrightSecretsPath: string
  controlConfigPath: string
  codexEnvironment: Record<string, string>
  mcpEnvironment: Record<string, string>
}): Thread {
  const playwrightCli = packageFilePath('@playwright/mcp', 'cli.js')
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'))
  const controlServer = controlServerPath()
  const codex = new Codex({
    codexPathOverride: options.codexExecutable,
    env: {
      ...options.codexEnvironment,
      CODEX_HOME: options.agentHome,
    },
    config: {
      developer_instructions: 'Operate only as the Auto-Test web testing agent. Follow the workspace AGENTS.md and configured MCP instructions. Do not modify source code.',
      features: {
        shell_tool: false,
        apps: false,
        multi_agent: false,
        remote_plugin: false,
        hooks: false,
        memories: false,
      },
      tools: { web_search: false },
      mcp_servers: {
        playwright: {
          command: process.execPath,
          args: [playwrightCli, '--config', options.playwrightConfigPath, '--secrets', options.playwrightSecretsPath],
          cwd: options.workspaceDirectory,
          env: options.mcpEnvironment,
          required: true,
          startup_timeout_sec: 30,
          tool_timeout_sec: 180,
          default_tools_approval_mode: 'approve',
          enabled_tools: [
            'browser_click',
            'browser_check',
            'browser_close',
            'browser_console_messages',
            'browser_drag',
            'browser_drop',
            'browser_file_upload',
            'browser_fill_form',
            'browser_find',
            'browser_handle_dialog',
            'browser_hover',
            'browser_navigate',
            'browser_navigate_back',
            'browser_navigate_forward',
            'browser_network_request',
            'browser_network_requests',
            'browser_press_key',
            'browser_reload',
            'browser_resize',
            'browser_select_option',
            'browser_snapshot',
            'browser_tabs',
            'browser_take_screenshot',
            'browser_type',
            'browser_uncheck',
            'browser_verify_element_visible',
            'browser_verify_list_visible',
            'browser_verify_text_visible',
            'browser_verify_value',
            'browser_wait_for',
            'browser_cookie_clear',
            'browser_localstorage_clear',
            'browser_sessionstorage_clear',
            'browser_set_storage_state',
          ],
        },
        'auto-test-control': {
          command: process.execPath,
          args: [tsxCli, controlServer, options.controlConfigPath],
          cwd: options.workspaceDirectory,
          env: options.mcpEnvironment,
          required: true,
          startup_timeout_sec: 20,
          tool_timeout_sec: 60,
          default_tools_approval_mode: 'approve',
        },
      },
    },
  })
  return codex.startThread({
    ...(options.model ? { model: options.model } : {}),
    sandboxMode: 'read-only',
    workingDirectory: options.workspaceDirectory,
    skipGitRepoCheck: true,
    modelReasoningEffort: 'xhigh',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
    approvalPolicy: 'never',
  })
}

async function appendEvent(path: string, event: ThreadEvent, secrets: string[]): Promise<void> {
  const serialized = redactAgentValue(JSON.stringify(event), secrets)
  await writeFile(path, `${serialized}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 })
  if (process.platform !== 'win32') await chmod(path, 0o600)
}

async function runTurn(
  thread: AgentThread,
  input: Input,
  eventsPath: string,
  secrets: string[],
): Promise<string> {
  const streamed = await thread.runStreamed(input)
  let finalResponse = ''
  for await (const event of streamed.events) {
    await appendEvent(eventsPath, event, secrets)
    if (event.type === 'item.completed' && event.item.type === 'agent_message') finalResponse = event.item.text
    if (event.type === 'turn.failed') throw new Error(event.error.message)
    if (event.type === 'error' && !/^Reconnecting\.\.\. \d+\/\d+/i.test(event.message)) throw new Error(event.message)
  }
  if (!finalResponse) throw new Error('Codex test agent returned no final response')
  return finalResponse
}

function decisionProblems(
  decisions: CodexTestCaseDecision[],
  manifest: WorkflowIntakeManifest,
  evidence: AgentEvidenceNote[],
  ledger: CodexTestMutationLedgerEntry[],
  plan?: AgentPlan,
): string[] {
  const requiredCases = new Set(manifest.phases.map((phase) => phase.id))
  const returnedCases = new Set(decisions.map((item) => item.caseId))
  const evidenceCases = new Set(evidence.map((item) => item.caseId))
  const problems: string[] = []
  if (returnedCases.size !== decisions.length) problems.push('duplicate case decisions are not allowed')
  for (const caseId of requiredCases) if (!returnedCases.has(caseId)) problems.push(`missing final case decision for ${caseId}`)
  for (const caseId of returnedCases) if (!requiredCases.has(caseId)) problems.push(`unexpected case decision for ${caseId}`)
  for (const caseId of requiredCases) if (!evidenceCases.has(caseId)) problems.push(`case ${caseId} has no Control MCP evidence`)
  for (const phase of manifest.phases) {
    if (phase.risk !== 'read' && !ledger.some((entry) => entry.caseId === phase.id)) {
      problems.push(`non-read case ${phase.id} has no Mutation Ledger entry`)
    }
  }
  if (!plan?.steps?.length) problems.push('dynamic execution plan is missing')
  else if (plan.steps.some((step) => ['pending', 'in_progress'].includes(step.status))) problems.push('dynamic execution plan contains unfinished steps')
  if (decisions.length > 0 && decisions.every((item) => item.outcome === 'passed') && plan?.steps?.some((step) => step.status !== 'passed')) {
    problems.push('passed case decisions conflict with a non-passed execution plan step')
  }
  for (const decision of decisions) {
    if (decision.outcome === 'passed' && (decision.blockers.length > 0 || decision.productDefects.length > 0)) {
      problems.push(`passed case decision ${decision.caseId} contains blockers or product defects`)
    }
    if (decision.outcome === 'blocked' && decision.blockers.length === 0) problems.push(`blocked case decision ${decision.caseId} has no blocker`)
    if (decision.outcome === 'product_failed' && decision.productDefects.length === 0) problems.push(`product-failed case decision ${decision.caseId} has no product defect`)
  }
  if (ledger.some((entry) => entry.status === 'pending')) problems.push('Mutation Ledger contains pending entries')
  return problems
}

function outcomeFor(decisions: CodexTestCaseDecision[]): CodexTestAgentResult['outcome'] {
  if (decisions.some((item) => item.outcome === 'blocked')) return 'blocked'
  if (decisions.some((item) => item.outcome === 'product_failed')) return 'product_failed'
  return 'passed'
}

function resultFromDecisions(options: {
  manifest: WorkflowIntakeManifest
  state: CodexTestAgentState
  decisions: CodexTestCaseDecision[]
  evidence: AgentEvidenceNote[]
  ledger: CodexTestMutationLedgerEntry[]
  problems: string[]
}): CodexTestAgentResult {
  const decisionByCase = new Map(options.decisions.map((item) => [item.caseId, item]))
  const evidenceByCase = new Map<string, AgentEvidenceNote[]>()
  for (const note of options.evidence) evidenceByCase.set(note.caseId, [...(evidenceByCase.get(note.caseId) ?? []), note])
  const missingMessage = options.problems.length > 0
    ? `The execution delivery contract is incomplete: ${options.problems.join('; ')}`
    : 'The execution agent did not record a final case decision.'
  const cases = options.manifest.phases.map((phase) => {
    const decision = decisionByCase.get(phase.id)
    return {
      caseId: phase.id,
      title: phase.title,
      outcome: decision?.outcome ?? 'blocked' as const,
      summary: decision?.summary ?? missingMessage,
      evidence: (evidenceByCase.get(phase.id) ?? []).map((note) => ({
        kind: note.kind,
        description: note.description,
        ...(note.path ? { path: note.path } : {}),
      })),
    }
  })
  const blockers = [...new Set([
    ...options.decisions.flatMap((item) => item.blockers),
    ...options.problems,
  ])]
  const productDefects = [...new Set(options.decisions.flatMap((item) => item.productDefects))]
  const decisionOutcome = outcomeFor(options.decisions)
  const outcome = options.problems.length > 0 ? 'blocked' : decisionOutcome
  const result: CodexTestAgentResult = {
    version: '1.0',
    workflowId: options.manifest.workflowId,
    sourceSha256: options.manifest.source.sha256,
    outcome,
    summary: outcome === 'passed'
      ? 'All immutable test cases and final safety assertions passed.'
      : outcome === 'product_failed'
        ? 'The test execution completed and verified one or more product defects.'
        : 'The test execution could not satisfy the complete delivery contract.',
    startedAt: options.state.startedAt,
    finishedAt: new Date().toISOString(),
    cases,
    mutations: [],
    blockers,
    productDefects,
    nextActions: outcome === 'blocked'
      ? ['Resolve the recorded blockers or incomplete execution evidence, then rerun the same input.']
      : outcome === 'product_failed'
        ? ['Triage the verified product defects and rerun after the product fix.']
        : [],
  }
  return enforceMutationLedger(result, options.ledger)
}

function isOperationalBlock(message: string): boolean {
  return /usage limit|quota|credit|rate.?limit|\b429\b|\b5\d\d\b|bad gateway|upstream|reconnect|timed? out|timeout|connection|network|dns|certificate|tls|unauthorized|forbidden|\b401\b|\b403\b|mcp|chromium executable|spawn .*enoent|no final response|schema validation/i.test(message)
}

function blockedResult(
  manifest: WorkflowIntakeManifest,
  state: CodexTestAgentState,
  message: string,
  ledger: CodexTestMutationLedgerEntry[],
): CodexTestAgentResult {
  const result: CodexTestAgentResult = {
    version: '1.0',
    workflowId: manifest.workflowId,
    sourceSha256: manifest.source.sha256,
    outcome: 'blocked',
    summary: 'The test agent could not complete because a required execution dependency became unavailable.',
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    cases: manifest.phases.map((phase) => ({
      caseId: phase.id,
      title: phase.title,
      outcome: 'blocked',
      summary: message,
      evidence: [{ kind: 'observation', description: 'Execution dependency failure recorded in codex-agent.events.jsonl.' }],
    })),
    mutations: [],
    blockers: [message],
    productDefects: [],
    nextActions: ['Restore the unavailable model, browser, MCP, network, or authorization dependency and rerun the same input.'],
  }
  return enforceMutationLedger(result, ledger)
}

async function readMutationLedger(path: string): Promise<CodexTestMutationLedgerEntry[]> {
  return JSON.parse(await readFile(path, 'utf8')) as CodexTestMutationLedgerEntry[]
}

async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

export async function runCodexTestAgent(
  options: CodexTestAgentOptions,
  dependencies: CodexTestAgentDependencies = {},
): Promise<CodexTestAgentRun> {
  const outputDirectory = resolve(options.outputDirectory)
  const statePath = resolve(outputDirectory, 'codex-agent.state.json')
  const resultPath = resolve(outputDirectory, 'codex-agent.result.json')
  const eventsPath = resolve(outputDirectory, 'codex-agent.events.jsonl')
  for (const path of [statePath, resolve(outputDirectory, '.agent-private', 'mutation-ledger.json')]) {
    await access(path).then(
      () => { throw new Error(`Output directory already contains Codex agent state: ${path}. Use a new output directory.`) },
      (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error },
    )
  }
  let state = initialCodexTestState(options.manifest.workflowId, options.manifest.source.sha256)
  let mutationLedgerPath: string | undefined
  let activeThread: AgentThread | undefined
  await writePrivateJson(statePath, state)
  const redactionSecrets = secretValues(options.secrets)
  try {
    const browserExecutablePath = dependencies.browserExecutablePath ?? chromium.executablePath()
    await access(browserExecutablePath).catch(() => {
      throw new Error(`Chromium executable is unavailable: ${browserExecutablePath}. Run Playwright browser installation first.`)
    })
    const workspace = await prepareCodexAgentWorkspace({
      outputDirectory,
      manifest: options.manifest,
      profile: options.profile,
      secrets: options.secrets,
      headed: options.headed,
      browserExecutablePath,
      ...(options.slowMo !== undefined ? { slowMo: options.slowMo } : {}),
      sourceCodexHome: options.codexHome ?? process.env.CODEX_HOME ?? process.env.AUTO_TEST_CODEX_HOME ?? resolve(process.env.HOME ?? '.', '.codex'),
      environment: process.env,
    })
    mutationLedgerPath = workspace.mutationLedgerPath
    const activeCodexExecutable = await resolveCodexExecutable(options)
    const startThread = dependencies.startThread ?? ((input) => startSdkThread(input))
    const thread = startThread({
      workspaceDirectory: workspace.workspaceDirectory,
      agentHome: workspace.agentHome,
      ...(options.model ? { model: options.model } : {}),
      codexExecutable: activeCodexExecutable,
      playwrightConfigPath: workspace.playwrightConfigPath,
      playwrightSecretsPath: workspace.playwrightSecretsPath,
      controlConfigPath: workspace.controlConfigPath,
      codexEnvironment: workspace.codexEnvironment,
      mcpEnvironment: workspace.mcpEnvironment,
    })
    activeThread = thread
    state = updateCodexTestState(state, { stage: 'executing' })
    await writePrivateJson(statePath, state)
    const prompt = codexTestAgentPrompt({
      manifest: options.manifest,
      environmentContext: options.environmentContext,
      secretAliases: workspace.secretAliases,
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
    })
    const input: Input = [
      { type: 'text', text: prompt },
      ...options.imagePaths.map((path) => ({ type: 'local_image' as const, path })),
    ]
    await runTurn(thread, input, eventsPath, redactionSecrets)
    state = updateCodexTestState(state, { ...(thread.id ? { threadId: thread.id } : {}), stage: 'finalizing' })
    await writePrivateJson(statePath, state)
    let ledger = await readMutationLedger(workspace.mutationLedgerPath)
    let evidence = await readJsonOr<AgentEvidenceNote[]>(workspace.evidenceIndexPath, [])
    let plan = await readJsonOr<AgentPlan | undefined>(workspace.planPath, undefined)
    let decisions = await readJsonOr<CodexTestCaseDecision[]>(workspace.caseResultsPath, [])
    const maxFinalizationTurns = options.maxFinalizationTurns ?? 2
    for (let turn = 0; turn < maxFinalizationTurns; turn++) {
      const problems = decisionProblems(decisions, options.manifest, evidence, ledger, plan)
      if (problems.length === 0) break
      await runTurn(thread, [{
        type: 'text',
        text: `The execution delivery contract is incomplete:\n- ${problems.join('\n- ')}\nContinue the same browser session. Repair missing final assertions, evidence, plan status, case_result_record entries, or pending mutation recovery without weakening expected results. Do not repeat already verified business mutations. Finish with a short plain-text summary.`,
      }], eventsPath, redactionSecrets)
      ledger = await readMutationLedger(workspace.mutationLedgerPath)
      evidence = await readJsonOr<AgentEvidenceNote[]>(workspace.evidenceIndexPath, [])
      plan = await readJsonOr<AgentPlan | undefined>(workspace.planPath, undefined)
      decisions = await readJsonOr<CodexTestCaseDecision[]>(workspace.caseResultsPath, [])
    }
    ledger = await readMutationLedger(workspace.mutationLedgerPath)
    evidence = await readJsonOr<AgentEvidenceNote[]>(workspace.evidenceIndexPath, [])
    plan = await readJsonOr<AgentPlan | undefined>(workspace.planPath, undefined)
    decisions = await readJsonOr<CodexTestCaseDecision[]>(workspace.caseResultsPath, [])
    const finalProblems = decisionProblems(decisions, options.manifest, evidence, ledger, plan)
    const result = resultFromDecisions({
      manifest: options.manifest,
      state,
      decisions,
      evidence,
      ledger,
      problems: finalProblems,
    })
    await writePrivateJson(resultPath, result)
    state = updateCodexTestState(state, {
      status: 'completed',
      stage: 'completed',
      outcome: result.outcome,
      resultPath,
      ...(thread.id ? { threadId: thread.id } : {}),
    })
    await writePrivateJson(statePath, state)
    return { state, result }
  } catch (error) {
    const message = redactAgentValue(error instanceof Error ? error.message : String(error), redactionSecrets)
    if (isOperationalBlock(message)) {
      const ledger = mutationLedgerPath ? await readMutationLedger(mutationLedgerPath).catch(() => []) : []
      const result = blockedResult(options.manifest, state, message, ledger)
      await writePrivateJson(resultPath, result)
      state = updateCodexTestState(state, {
        status: 'completed', stage: 'completed', outcome: 'blocked', resultPath,
        ...(activeThread?.id ? { threadId: activeThread.id } : {}),
      })
      await writePrivateJson(statePath, state)
      return { state, result }
    }
    state = updateCodexTestState(state, {
      status: 'failed', stage: 'failed', error: message,
      ...(activeThread?.id ? { threadId: activeThread.id } : {}),
    })
    await writePrivateJson(statePath, state)
    return { state }
  }
}
