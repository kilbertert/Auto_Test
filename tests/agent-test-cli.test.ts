import { describe, expect, it } from 'vitest'
import { mergeAgentSecrets, parseAgentTestArgs, scopeEnvironmentProfile } from '../src/cli/agent-test.js'

describe('Codex agent CLI', () => {
  it('accepts an Excel with URLs supplied by the workbook', () => {
    const options = parseAgentTestArgs(['--file', 'cases.xlsx', '--headed', '--max-iterations', '2', '--slow-mo', '50', '--case-batch-size', '12'])

    expect(options.urls).toEqual([])
    expect(options.headed).toBe(true)
    expect(options.maxIterations).toBe(2)
    expect(options.slowMo).toBe(50)
    expect(options.caseBatchSize).toBe(12)
    expect(options.testDataAccess).toBe('direct')
    expect(options.outputDirectory).toMatch(/artifacts[\\/]runs[\\/].*cases-/)
  })

  it('rejects conflicting browser modes and invalid numeric limits', () => {
    expect(() => parseAgentTestArgs(['--file', 'cases.xlsx', '--headed', '--headless'])).toThrow(/不能同时使用/)
    expect(() => parseAgentTestArgs(['--file', 'cases.xlsx', '--max-iterations', '0'])).toThrow(/正整数/)
    expect(() => parseAgentTestArgs(['--file', 'cases.xlsx', '--case-batch-size', '0'])).toThrow(/正整数/)
  })

  it('accepts explicit recovery of an existing output directory', () => {
    const options = parseAgentTestArgs(['--file', 'cases.xlsx', '--output-dir', 'artifacts/recovery', '--resume'])

    expect(options.resume).toBe(true)
    expect(options.outputDirectory).toMatch(/artifacts[\\/]recovery$/)
  })

  it('supports an explicit opaque test-data mode', () => {
    expect(parseAgentTestArgs(['--file', 'cases.xlsx', '--opaque-test-data']).testDataAccess).toBe('opaque')
  })

  it('parses the model-profile selection and registry path', () => {
    const options = parseAgentTestArgs(['--file', 'cases.xlsx', '--model-profile', 'glm', '--model-profile-registry', '/custom/model-profiles.json'])
    expect(options.modelProfileId).toBe('glm')
    expect(options.modelProfileRegistryPath).toMatch(/[\\/]model-profiles\.json$/)
  })

  it('defaults the model-profile registry path', () => {
    const options = parseAgentTestArgs(['--file', 'cases.xlsx'])
    expect(options.modelProfileId).toBeUndefined()
    expect(options.modelProfileRegistryPath).toMatch(/auto-test[\\/]model-profiles\.json$/)
  })

  it('fails closed when environment and workbook secrets disagree', () => {
    expect(() => mergeAgentSecrets(
      { 'fixture.username': 'environment-user' },
      { 'fixture.username': 'workbook-user' },
    )).toThrow(/不同值/)
    expect(mergeAgentSecrets(
      { 'fixture.username': 'same-user' },
      { 'fixture.username': 'same-user', 'fixture.code': '1234' },
    )).toEqual({ 'fixture.username': 'same-user', 'fixture.code': '1234' })
  })

  it('only forwards secrets referenced by this test or its authentication adapters', () => {
    expect(mergeAgentSecrets(
      { 'fixture.username': 'user', 'unrelated.admin.password': 'must-not-forward' },
      { 'fixture.code': '1234' },
      ['fixture.username', 'fixture.code'],
    )).toEqual({ 'fixture.username': 'user', 'fixture.code': '1234' })
    expect(() => mergeAgentSecrets({}, {}, ['fixture.missing'])).toThrow(/fixture\.missing/)
  })

  it('scopes a reusable environment profile to the origins used by this run', () => {
    const profile = scopeEnvironmentProfile({
      id: 'shared',
      origins: ['https://catalog.example.test', 'https://admin.example.test'],
      auth: [
        { origin: 'https://catalog.example.test', storageStatePath: '/catalog.json' },
        { origin: 'https://admin.example.test', storageStatePath: '/admin.json' },
      ],
      policy: { allowWrite: true, allowDestructive: false },
    }, {
      version: '1.0', kind: 'workflow-intake', workflowId: 'catalog',
      source: { format: 'xlsx', fileName: 'catalog.xlsx', sheetName: 'Cases', sha256: 'a'.repeat(64) },
      targetUrls: ['https://catalog.example.test/products'], requiredCapabilities: [], phases: [],
      embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
    })

    expect(profile.origins).toEqual(['https://catalog.example.test'])
    expect(profile.auth).toHaveLength(1)
  })

  it('retains only explicitly requested additional origins for a resumed run', () => {
    const profile = scopeEnvironmentProfile({
      id: 'shared',
      origins: ['https://catalog.example.test', 'https://admin.example.test', 'https://unrelated.example.test'],
      auth: [
        { origin: 'https://catalog.example.test' },
        { origin: 'https://admin.example.test' },
        { origin: 'https://unrelated.example.test' },
      ],
      policy: { allowWrite: true, allowDestructive: false },
    }, {
      version: '1.0', kind: 'workflow-intake', workflowId: 'catalog',
      source: { format: 'xlsx', fileName: 'catalog.xlsx', sheetName: 'Cases', sha256: 'a'.repeat(64) },
      targetUrls: ['https://catalog.example.test/products'], requiredCapabilities: [], phases: [],
      embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
    }, ['https://admin.example.test/virtual/device'])

    expect(profile.origins).toEqual(['https://catalog.example.test', 'https://admin.example.test'])
    expect(profile.auth.map((adapter) => adapter.origin)).toEqual(profile.origins)
  })
})
