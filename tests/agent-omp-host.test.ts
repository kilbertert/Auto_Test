import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { ompSessionLaunchArgs } from '../src/agent/omp-host.js'

describe('OMP RPC launch args', () => {
  it('loads the run-scoped config overlay so MCP servers are discovered', () => {
    const args = ompSessionLaunchArgs({
      workspaceDirectory: '/run/agent-workspace',
      sessionDirectory: '/run/.agent-private/omp-home/sessions',
      model: 'provider/model',
    })
    const configIndex = args.indexOf('--config')
    expect(configIndex).toBeGreaterThanOrEqual(0)
    expect(args[configIndex + 1]).toBe(resolve('/run/agent-workspace', '.omp', 'config.yml'))
    expect(args).toContain('--mode')
    expect(args).toContain('rpc')
  })

  it('omits optional flags when their values are absent', () => {
    const args = ompSessionLaunchArgs({
      workspaceDirectory: '/run/agent-workspace',
      sessionDirectory: '/run/.agent-private/omp-home/sessions',
    })
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--thinking')
    expect(args).not.toContain('--service-tier')
    expect(args).not.toContain('--resume')
  })
})
