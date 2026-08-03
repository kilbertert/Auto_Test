import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { blockedNavigationOriginsFromEvents, normalizeEnvironmentOrigin, readEnvironmentRequirements, reconcileEnvironmentRequirements, recordEnvironmentRequirement, requestEnvironmentAccess, satisfyEnvironmentRequirement } from '../src/agent/environment-requirements.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('environment access requirements', () => {
  it('normalizes allowed origin checks without allowing unregistered navigation', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-origin-gate-'))
    directories.push(directory)
    const requirementsPath = resolve(directory, 'environment-requirements.json')

    expect(normalizeEnvironmentOrigin('https://app.example.test/path?next=1')).toBe('https://app.example.test')
    await expect(requestEnvironmentAccess({
      allowedOrigins: ['https://app.example.test'],
      requirementsPath,
      origin: 'https://app.example.test/path',
      reason: 'same registered application',
      evidence: [],
      caseIds: ['case-allowed'],
    })).resolves.toMatchObject({ status: 'allowed', origin: 'https://app.example.test' })

    const blocked = await requestEnvironmentAccess({
      allowedOrigins: ['https://app.example.test'],
      requirementsPath,
      origin: 'https://admin.example.test/virtual/device',
      reason: 'page evidence linked to an admin console',
      evidence: ['image:device-route'],
      caseIds: ['case-blocked'],
    })
    expect(blocked).toMatchObject({ status: 'blocked', origin: 'https://admin.example.test' })
    expect(await readEnvironmentRequirements(requirementsPath)).toHaveLength(1)
    expect(await readFile(requirementsPath, 'utf8')).not.toContain('/virtual/device')

    const reconciled = await reconcileEnvironmentRequirements(requirementsPath, ['https://app.example.test', 'https://admin.example.test'])
    expect(reconciled[0]).toMatchObject({ origin: 'https://admin.example.test', status: 'satisfied' })
    expect((await readEnvironmentRequirements(requirementsPath))[0]?.status).toBe('satisfied')
  })

  it('infers only blocked navigation origins, not blocked third-party resources', () => {
    const events = [
      JSON.stringify({ type: 'item.completed', item: {
        type: 'mcp_tool_call', tool: 'browser_navigate',
        result: { content: [{ type: 'text', text: 'ERR_BLOCKED_BY_CLIENT at https://unregistered.example.test/path' }] },
      } }),
      JSON.stringify({ type: 'item.completed', item: {
        type: 'mcp_tool_call', tool: 'browser_console_messages',
        result: { content: [{ type: 'text', text: 'ERR_BLOCKED_BY_CLIENT at https://static-cdn.example.test/map.js' }] },
      } }),
    ].join('\n')

    expect(blockedNavigationOriginsFromEvents(events, ['https://app.example.test'])).toEqual(['https://unregistered.example.test'])
  })

  it('records generic environment prerequisites with case linkage and evidence', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-environment-evidence-'))
    directories.push(directory)
    const requirementsPath = resolve(directory, 'environment-requirements.json')

    const requirement = await recordEnvironmentRequirement({
      requirementsPath,
      requirement: {
        caseIds: ['case-filter'],
        kind: 'test_data',
        condition: 'The requested historical record was absent after the available read-only controls were applied.',
        evidence: ['evidence/filter-state.png'],
      },
    })

    expect(requirement).toMatchObject({
      id: expect.stringMatching(/^environment-test_data-/),
      caseIds: ['case-filter'], kind: 'test_data', status: 'pending', evidence: ['evidence/filter-state.png'],
    })
    await expect(recordEnvironmentRequirement({
      requirementsPath,
      requirement: { caseIds: ['case-filter'], kind: 'test_data', condition: 'Missing evidence', evidence: [] },
    })).rejects.toThrow(/saved evidence/)
    await expect(satisfyEnvironmentRequirement({
      requirementsPath,
      id: requirement.id,
      evidence: ['evidence/resolved.png'],
    })).resolves.toMatchObject({ status: 'satisfied', evidence: ['evidence/filter-state.png', 'evidence/resolved.png'] })
  })
})
