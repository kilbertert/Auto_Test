import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { blockedNavigationOriginsFromEvents, normalizeEnvironmentOrigin, readEnvironmentRequirements, reconcileEnvironmentRequirementCaseLinks, reconcileEnvironmentRequirements, recordEnvironmentRequirement, requestEnvironmentAccess, satisfyEnvironmentRequirement } from '../src/agent/environment-requirements.js'

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

  it('removes stale case links from a shared pending requirement after explicit non-environment results', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-environment-case-links-'))
    directories.push(directory)
    const requirementsPath = resolve(directory, 'environment-requirements.json')
    const requirement = await recordEnvironmentRequirement({
      requirementsPath,
      requirement: {
        caseIds: ['case-environment', 'case-product', 'case-input'],
        kind: 'test_data',
        condition: 'The shared fixture is unavailable.',
        evidence: ['evidence/shared-fixture.md'],
      },
    })

    const reconciled = await reconcileEnvironmentRequirementCaseLinks(requirementsPath, [
      {
        caseId: 'case-environment',
        failureSource: 'environment',
        environmentRequirementIds: [requirement.id],
      },
      { caseId: 'case-product', failureSource: 'product' },
      { caseId: 'case-input', failureSource: 'input' },
    ])

    expect(reconciled[0]).toMatchObject({ id: requirement.id, status: 'pending', caseIds: ['case-environment'] })
    expect((await readEnvironmentRequirements(requirementsPath))[0]?.caseIds).toEqual(['case-environment'])
  })

  it('supersedes an orphaned requirement but preserves an environment case missing its reference', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-environment-case-links-guard-'))
    directories.push(directory)
    const requirementsPath = resolve(directory, 'environment-requirements.json')
    const requirement = await recordEnvironmentRequirement({
      requirementsPath,
      requirement: {
        caseIds: ['case-a', 'case-b'],
        kind: 'test_data',
        condition: 'The fixture is unavailable.',
        evidence: ['evidence/fixture.md'],
      },
    })

    await expect(reconcileEnvironmentRequirementCaseLinks(requirementsPath, [
      { caseId: 'case-a', failureSource: 'product' },
      { caseId: 'case-b', failureSource: 'input' },
    ])).resolves.toEqual([{ ...requirement, status: 'superseded' }])
    await recordEnvironmentRequirement({
      requirementsPath,
      requirement: {
        caseIds: ['case-a', 'case-b'],
        kind: 'test_data',
        condition: 'The fixture is unavailable.',
        evidence: ['evidence/fixture-again.md'],
      },
    })
    await expect(reconcileEnvironmentRequirementCaseLinks(requirementsPath, [
      { caseId: 'case-a', failureSource: 'environment', environmentRequirementIds: [] },
      { caseId: 'case-b', failureSource: 'product' },
    ])).resolves.toEqual([{ ...requirement, caseIds: ['case-a'], evidence: ['evidence/fixture.md', 'evidence/fixture-again.md'], requestedAt: expect.any(String) }])
  })

  it('supersedes an older shared requirement when environment cases cite newer requirement ids', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-environment-case-links-superseded-'))
    directories.push(directory)
    const requirementsPath = resolve(directory, 'environment-requirements.json')
    const requirement = await recordEnvironmentRequirement({
      requirementsPath,
      requirement: {
        caseIds: ['case-a', 'case-b'],
        kind: 'test_data',
        condition: 'The broad fixture is unavailable.',
        evidence: ['evidence/broad.md'],
      },
    })

    await expect(reconcileEnvironmentRequirementCaseLinks(requirementsPath, [
      { caseId: 'case-a', failureSource: 'environment', environmentRequirementIds: ['environment-test_data-new-a'] },
      { caseId: 'case-b', failureSource: 'environment', environmentRequirementIds: ['environment-test_data-new-b'] },
    ])).resolves.toEqual([{ ...requirement, status: 'superseded' }])
  })
})
