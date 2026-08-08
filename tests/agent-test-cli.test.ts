import { describe, expect, it, vi } from 'vitest'
import {
  createPreExecutionBlockedResult,
  mergeAgentSecrets,
  parseAgentTestArgs,
  parseRecordedModelSelection,
  scopeEnvironmentProfile,
} from '../src/cli/agent-test.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'
import { environmentTargetUrls } from '../src/workflow/target-urls.js'

function fixtureManifest(): WorkflowIntakeManifest {
  return {
    version: '1.0',
    kind: 'workflow-intake',
    workflowId: 'provider-fixture',
    source: {
      format: 'xlsx',
      fileName: 'provider-fixture.xlsx',
      sheetName: 'Cases',
      sha256: 'a'.repeat(64),
    },
    targetUrls: ['https://example.test'],
    declaredTargetUrls: ['https://example.test'],
    requiredCapabilities: [],
    phases: [{
      id: 'case-1',
      title: 'Provider fixture',
      sourceRow: 2,
      risk: 'read',
      steps: [],
      resources: [],
      secretBindings: [],
      imageIds: [],
      review: { status: 'draft', ambiguities: [] },
    }],
    embeddedImages: [],
    supplementalImages: [],
    review: { status: 'draft', reasons: [] },
  }
}

describe('Codex agent CLI', () => {
  it('requires an explicit environment URL for a new run', () => {
    expect(() => parseAgentTestArgs(['--file', 'cases.xlsx'])).toThrow(/至少提供一个 --url/)
    const options = parseAgentTestArgs([
      '--file', 'cases.xlsx', '--url', 'https://app.example.test/', '--headed',
      '--max-iterations', '2', '--slow-mo', '50', '--case-limit', '12',
    ])

    expect(options.urls).toEqual(['https://app.example.test/'])
    expect(options.headed).toBe(true)
    expect(options.maxIterations).toBe(2)
    expect(options.slowMo).toBe(50)
    expect(options.caseLimit).toBe(12)
    expect(options.testDataAccess).toBe('direct')
    expect(options.outputDirectory).toMatch(/artifacts[\\/]runs[\\/].*cases-/)
  })

  it('rejects conflicting browser modes and invalid numeric limits', () => {
    expect(() => parseAgentTestArgs(['--file', 'cases.xlsx', '--headed', '--headless'])).toThrow(/不能同时使用/)
    expect(() => parseAgentTestArgs(['--file', 'cases.xlsx', '--max-iterations', '0'])).toThrow(/正整数/)
    expect(() => parseAgentTestArgs(['--file', 'cases.xlsx', '--case-limit', '0'])).toThrow(/正整数/)
    expect(() => parseAgentTestArgs(['--file', 'cases.xlsx', '--one', '--case-limit', '1'])).toThrow(/不能同时使用/)
  })

  it('maps --one to one frozen manifest case', () => {
    expect(parseAgentTestArgs(['--file', 'cases.xlsx', '--url', 'https://app.example.test/', '--one']).caseLimit).toBe(1)
  })

  it('accepts explicit recovery of an existing output directory', () => {
    const options = parseAgentTestArgs(['--file', 'cases.xlsx', '--output-dir', 'artifacts/recovery', '--resume'])

    expect(options.resume).toBe(true)
    expect(options.outputDirectory).toMatch(/artifacts[\\/]recovery$/)
  })

  it('leaves the host unspecified on resume so the frozen run state selects it', () => {
    const previous = process.env.AUTO_TEST_AGENT_HOST
    delete process.env.AUTO_TEST_AGENT_HOST
    try {
      expect(parseAgentTestArgs(['--file', 'cases.xlsx', '--output-dir', 'artifacts/recovery', '--resume']).agentHostId).toBeUndefined()
      expect(parseAgentTestArgs(['--file', 'cases.xlsx', '--output-dir', 'artifacts/recovery', '--resume', '--agent-host', 'omp']).agentHostId).toBe('omp')
    } finally {
      if (previous === undefined) delete process.env.AUTO_TEST_AGENT_HOST
      else process.env.AUTO_TEST_AGENT_HOST = previous
    }
  })

  it('does not let an ambient host default switch a resumed run', () => {
    const previous = process.env.AUTO_TEST_AGENT_HOST
    process.env.AUTO_TEST_AGENT_HOST = 'codex'
    try {
      expect(parseAgentTestArgs(['--file', 'cases.xlsx', '--output-dir', 'artifacts/recovery', '--resume']).agentHostId).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.AUTO_TEST_AGENT_HOST
      else process.env.AUTO_TEST_AGENT_HOST = previous
    }
  })

  it('selects OMP for OMP-specific configuration and rejects mixed host arguments', () => {
    vi.stubEnv('AUTO_TEST_AGENT_HOST', '')
    try {
      const options = parseAgentTestArgs(['--file', 'cases.xlsx', '--url', 'https://app.example.test/', '--omp-home', '/private/omp-agent'])
      expect(options.agentHostId).toBe('omp')
      expect(options.agentSourceHome).toMatch(/[\\/]private[\\/]omp-agent$/)
      expect(() => parseAgentTestArgs(['--file', 'cases.xlsx', '--url', 'https://app.example.test/', '--agent-host', 'codex', '--omp-home', '/private/omp-agent'])).toThrow(/不一致/)
      expect(() => parseAgentTestArgs(['--file', 'cases.xlsx', '--url', 'https://app.example.test/', '--codex-bin', '/bin/codex', '--omp-home', '/private/omp-agent'])).toThrow(/不能与.*同时使用/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('normalizes generic and legacy host runtime flags before entering Core', () => {
    const generic = parseAgentTestArgs([
      '--file', 'cases.xlsx', '--agent-host', 'omp',
      '--url', 'https://app.example.test/',
      '--agent-bin', '/opt/agent/bin', '--agent-home', '/opt/agent/home',
    ])
    expect(generic).toMatchObject({
      agentHostId: 'omp',
      agentExecutable: expect.stringMatching(/[\\/]opt[\\/]agent[\\/]bin$/),
      agentSourceHome: expect.stringMatching(/[\\/]opt[\\/]agent[\\/]home$/),
    })

    const legacy = parseAgentTestArgs([
      '--file', 'cases.xlsx', '--url', 'https://app.example.test/', '--codex-bin', '/opt/codex/bin', '--codex-home', '/opt/codex/home',
    ])
    expect(legacy).toMatchObject({
      agentHostId: 'codex',
      agentExecutable: expect.stringMatching(/[\\/]opt[\\/]codex[\\/]bin$/),
      agentSourceHome: expect.stringMatching(/[\\/]opt[\\/]codex[\\/]home$/),
    })
    expect(legacy).not.toHaveProperty('codexExecutable')
    expect(legacy).not.toHaveProperty('codexHome')
  })

  it('supports an explicit opaque test-data mode', () => {
    expect(parseAgentTestArgs(['--file', 'cases.xlsx', '--url', 'https://app.example.test/', '--opaque-test-data']).testDataAccess).toBe('opaque')
  })

  it('parses the model-profile selection and registry path', () => {
    const options = parseAgentTestArgs(['--file', 'cases.xlsx', '--url', 'https://app.example.test/', '--model-profile', 'glm', '--model-profile-registry', '/custom/model-profiles.json'])
    expect(options.modelProfileId).toBe('glm')
    expect(options.modelProfileRegistryPath).toMatch(/[\\/]model-profiles\.json$/)
  })

  it('defaults the model-profile registry path', () => {
    const options = parseAgentTestArgs(['--file', 'cases.xlsx', '--url', 'https://app.example.test/'])
    expect(options.modelProfileId).toBeUndefined()
    expect(options.modelProfileRegistryPath).toMatch(/auto-test[\\/]model-profiles\.json$/)
  })

  it('classifies model-provider readiness failures as execution infrastructure', () => {
    const result = createPreExecutionBlockedResult(
      fixtureManifest(),
      'model provider is unavailable',
      { failureSource: 'infrastructure', failureKind: 'execution' },
    )

    expect(result.summary).toContain('执行基础设施')
    expect(result.cases[0]).toMatchObject({
      outcome: 'blocked',
      failureSource: 'infrastructure',
      failureKind: 'execution',
      summary: 'model provider is unavailable',
    })
    expect(result.nextActions[0]).toContain('Provider')
    expect(result.nextActions[0]).not.toContain('权限')
  })

  it('keeps intake-readiness failures distinct from target-environment failures', () => {
    const result = createPreExecutionBlockedResult(
      fixtureManifest(),
      'the input contract is incomplete',
      { failureSource: 'input', failureKind: 'validation' },
    )

    expect(result.summary).toContain('输入资料')
    expect(result.cases[0]).toMatchObject({
      failureSource: 'input',
      failureKind: 'validation',
    })
  })

  it('fails closed on malformed recorded model selection data', () => {
    expect(parseRecordedModelSelection('{"id":"volcengine","model":"glm-5.2"}'))
      .toEqual({ id: 'volcengine', model: 'glm-5.2' })
    expect(() => parseRecordedModelSelection('null')).toThrow(/必须是对象/)
    expect(() => parseRecordedModelSelection('{}')).toThrow(/缺少 id 或 model/)
    expect(() => parseRecordedModelSelection('{"id":123}')).toThrow(/id 无效/)
  })

  it('restores a complete provider snapshot without depending on the current registry', () => {
    expect(parseRecordedModelSelection(JSON.stringify({
      version: '2.0',
      id: 'volcengine',
      model: 'glm-5.2',
      profile: {
        id: 'volcengine',
        model: 'glm-5.2',
        providerId: 'volcengine_coding',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
        api: 'openai-responses',
        envKey: 'ARK_API_KEY',
      },
    }))).toMatchObject({
      id: 'volcengine',
      model: 'glm-5.2',
      profile: { providerId: 'volcengine_coding', api: 'openai-responses' },
    })
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
      targetUrls: ['https://catalog.example.test/products'], declaredTargetUrls: ['https://catalog.example.test/'], requiredCapabilities: [], phases: [],
      embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
    })

    expect(profile.origins).toEqual(['https://catalog.example.test'])
    expect(profile.auth).toHaveLength(1)
  })

  it('does not promote workbook reference links into pre-execution environment targets', () => {
    const manifest = fixtureManifest()
    manifest.targetUrls = ['https://app.example.test/', 'https://reference.example.test/']
    manifest.declaredTargetUrls = ['https://app.example.test/']
    const profile = scopeEnvironmentProfile({
      id: 'app',
      origins: ['https://app.example.test', 'https://reference.example.test'],
      auth: [],
      policy: { allowWrite: false, allowDestructive: false },
    }, manifest)

    expect(environmentTargetUrls(manifest)).toEqual(['https://app.example.test/'])
    expect(profile.origins).toEqual(['https://app.example.test'])
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
      targetUrls: ['https://catalog.example.test/products'], declaredTargetUrls: ['https://catalog.example.test/'], requiredCapabilities: [], phases: [],
      embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
    }, ['https://admin.example.test/virtual/device'])

    expect(profile.origins).toEqual(['https://catalog.example.test', 'https://admin.example.test'])
    expect(profile.auth.map((adapter) => adapter.origin)).toEqual(profile.origins)
  })
})
