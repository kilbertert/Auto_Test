import type { AgentHost, AgentHostId } from './host.js'
import { CodexAgentHost } from './codex-host.js'
import { OmpAgentHost } from './omp-host.js'
import { DshAgentHost } from './dsh-host.js'

export type BuiltInAgentHostId = 'codex' | 'omp' | 'dsh'

export function isBuiltInAgentHostId(value: string | undefined): value is BuiltInAgentHostId {
  return value === 'codex' || value === 'omp' || value === 'dsh'
}

export function availableAgentHosts(): Array<{ id: BuiltInAgentHostId; displayName: string }> {
  return [
    { id: 'codex', displayName: 'Codex CLI' },
    { id: 'omp', displayName: 'oh-my-pi RPC' },
    { id: 'dsh', displayName: 'DeepSeek Harness RPC (experimental)' },
  ]
}

export function createAgentHost(id: AgentHostId = 'codex'): AgentHost {
  switch (id) {
    case 'codex': return new CodexAgentHost()
    case 'omp': return new OmpAgentHost()
    case 'dsh': return new DshAgentHost()
    default: throw new Error(`Unsupported agent host: ${id}. Available hosts: codex, omp, dsh.`)
  }
}
