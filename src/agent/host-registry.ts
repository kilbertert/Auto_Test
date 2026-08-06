import type { AgentHost, AgentHostId } from './host.js'
import { CodexAgentHost } from './codex-host.js'
import { OmpAgentHost } from './omp-host.js'

export type BuiltInAgentHostId = 'codex' | 'omp'

export function isBuiltInAgentHostId(value: string | undefined): value is BuiltInAgentHostId {
  return value === 'codex' || value === 'omp'
}

export function availableAgentHosts(): Array<{ id: BuiltInAgentHostId; displayName: string }> {
  return [
    { id: 'codex', displayName: 'Codex CLI' },
    { id: 'omp', displayName: 'oh-my-pi RPC' },
  ]
}

export function createAgentHost(id: AgentHostId = 'codex'): AgentHost {
  switch (id) {
    case 'codex': return new CodexAgentHost()
    case 'omp': return new OmpAgentHost()
    default: throw new Error(`Unsupported agent host: ${id}. Available hosts: codex, omp.`)
  }
}
