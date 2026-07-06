import { OpenMultiAgent } from '@open-multi-agent/core'
import type { OrchestratorEvent, TraceEvent, StreamEvent, SupportedProvider } from '@open-multi-agent/core'
import { browserPool } from '../browser/pool.js'
import { makeBrowserTools } from '../browser/tools.js'
import { makeExecutor, reporter } from '../agents/roster.js'
import { buildLoginTasks } from '../cases/login.case.js'
import { config } from '../config.js'
import { broadcast } from '../ws-bus.js'
import { randomUUID } from 'node:crypto'

/**
 * Agent 模式:用 open-multi-agent runTasks 跑登录用例 DAG(executor → reporter),
 * 三套进度回调转发到 WS。需要 LLM 凭据。
 */
export async function runAgentMode(runId: string): Promise<void> {
  broadcast(runId, { type: 'run_start', runId })

  const session = await browserPool.acquire(runId)
  const browserTools = makeBrowserTools(session)
  const executor = makeExecutor(browserTools)

  const orchestrator = new OpenMultiAgent({
    defaultModel: config.OMA_MODEL,
    defaultProvider: config.OMA_PROVIDER as SupportedProvider,
    defaultBaseURL: config.OMA_BASE_URL,
    defaultApiKey: config.OMA_API_KEY,
    maxConcurrency: config.BROWSER_POOL_SIZE,
    defaultToolPreset: 'readonly',
    onProgress: (e: OrchestratorEvent) => broadcast(runId, { type: 'progress', event: e }),
    onTrace: (e: TraceEvent) => broadcast(runId, { type: 'trace', event: e }),
    onAgentStream: (agent: string, e: StreamEvent) => broadcast(runId, { type: 'stream', agent, event: e }),
  })

  const team = orchestrator.createTeam('p0-team-' + runId.slice(0, 8), {
    name: 'p0-team',
    agents: [executor, reporter],
    sharedMemory: true,
  })

  const tasks = buildLoginTasks()
  broadcast(runId, {
    type: 'tasks_ready',
    tasks: tasks.map(t => ({ title: t.title, assignee: t.assignee, dependsOn: t.dependsOn })),
  })

  try {
    const result = await orchestrator.runTasks(team, tasks)
    broadcast(runId, {
      type: 'run_complete',
      runId,
      output: (result as { output?: string }).output ?? '',
    })
  } catch (e) {
    broadcast(runId, { type: 'run_complete', runId, error: String(e) })
    throw e
  } finally {
    browserPool.release(session)
  }
}

export function newRunId(): string {
  return randomUUID()
}
