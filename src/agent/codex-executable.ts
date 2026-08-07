import { delimiter } from 'node:path'
import { AgentHostError, resolveHostExecutable } from './host.js'

/** Resolve the exact Codex CLI used for both catalog generation and execution. */
export async function resolveCodexExecutable(
  executable: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const configured = executable || environment.AUTO_TEST_AGENT_BIN || environment.AUTO_TEST_CODEX_BIN ||
    process.env.AUTO_TEST_AGENT_BIN || process.env.AUTO_TEST_CODEX_BIN || 'codex'
  const pathKey = environment.Path !== undefined ? 'Path' : 'PATH'
  const pathValue = environment[pathKey]
  const filteredEnvironment = configured === 'codex' && pathValue
    ? {
        ...environment,
        [pathKey]: pathValue.split(delimiter)
          .filter((entry) => !/[\\/]node_modules[\\/]\.bin(?:[\\/]|$)/i.test(entry))
          .join(delimiter),
      }
    : environment
  const resolved = await resolveHostExecutable(configured, filteredEnvironment)
  if (resolved) return resolved
  if (executable || environment.AUTO_TEST_AGENT_BIN || environment.AUTO_TEST_CODEX_BIN ||
      process.env.AUTO_TEST_AGENT_BIN || process.env.AUTO_TEST_CODEX_BIN) {
    throw new AgentHostError('codex', `Configured Codex CLI executable is unavailable: ${configured}`, 'configuration')
  }
  throw new AgentHostError('codex', 'Current Codex CLI executable was not found. Install Codex CLI or set AUTO_TEST_AGENT_BIN.', 'configuration')
}
