import { access, chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'
import type { EnvironmentProfile } from '../src/workflow/environment-profile.js'
import { prepareCodexAgentWorkspace } from '../src/agent/workspace.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function manifest(origins: string[]): WorkflowIntakeManifest {
  return {
    version: '1.0',
    kind: 'workflow-intake',
    workflowId: 'workspace-fixture',
    source: { format: 'xlsx', fileName: 'fixture.xlsx', sheetName: 'Cases', sha256: 'b'.repeat(64) },
    targetUrls: origins.map((origin) => `${origin}/app`),
    requiredCapabilities: ['multiOrigin'],
    phases: [{
      id: 'inspect-board',
      title: 'Inspect board',
      sourceRow: 2,
      risk: 'read',
      steps: [{ id: 'step-1', sourceText: 'Open the board', confidence: 1 }],
      resources: [],
      secretBindings: [{ name: 'accessCode', secretRef: 'fixture.accessCode', purpose: 'Access code', sourceCell: 'D2' }],
      imageIds: [],
      review: { status: 'draft', ambiguities: [] },
    }],
    embeddedImages: [],
    supplementalImages: [],
    review: { status: 'draft', reasons: [] },
  }
}

describe('Codex agent workspace', () => {
  it('stages raw run inputs and enables the complete Playwright capability set without copying provider secrets', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-workspace-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), [
      'model = "fixture-model"',
      'model_provider = "fixture"',
      'model_context_window = 400000',
      '',
      '[model_providers.fixture]',
      'name = "Fixture"',
      'base_url = "https://model.example.test/v1"',
      'wire_api = "responses"',
      'env_key = "FIXTURE_MODEL_KEY"',
      'requires_openai_auth = false',
      '',
      '[mcp_servers.unrelated]',
      'command = "must-not-copy"',
    ].join('\n'), { mode: 0o600 })
    const firstState = resolve(directory, 'first-state.json')
    const secondState = resolve(directory, 'second-state.json')
    await writeFile(firstState, JSON.stringify({
      cookies: [{ name: 'session-a', value: 'one', domain: 'one.example.test', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
      origins: [{ origin: 'https://one.example.test', localStorage: [{ name: 'theme', value: 'light' }] }],
    }), { mode: 0o600 })
    await writeFile(secondState, JSON.stringify({
      cookies: [{ name: 'session-b', value: 'two', domain: 'two.example.test', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
      origins: [{ origin: 'https://two.example.test', localStorage: [{ name: 'locale', value: 'en' }], indexedDB: [{ name: 'auth', data: [] }] }],
    }), { mode: 0o600 })
    const sessionPath = resolve(directory, 'session.json')
    await writeFile(sessionPath, JSON.stringify({ origin: 'https://two.example.test', entries: { panel: 'open' } }), { mode: 0o600 })
    const profile: EnvironmentProfile = {
      id: 'workspace-fixture',
      origins: ['https://one.example.test', 'https://two.example.test'],
      auth: [
        { origin: 'https://one.example.test', storageStatePath: firstState },
        { origin: 'https://two.example.test', storageStatePath: secondState, sessionStoragePath: sessionPath },
      ],
      policy: { allowWrite: false, allowDestructive: false },
    }
    const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
    const homeValue = process.platform === 'win32' ? 'C:\\Users\\fixture' : '/home/fixture'
    const sourceFilePath = resolve(directory, 'fixture.xlsx')
    const briefFilePath = resolve(directory, 'brief.md')
    const imagePath = resolve(directory, 'screen.png')
    await writeFile(sourceFilePath, 'raw-workbook')
    await writeFile(briefFilePath, 'raw-brief')
    await writeFile(imagePath, 'raw-image')

    const workspace = await prepareCodexAgentWorkspace({
      outputDirectory: resolve(directory, 'run'),
      manifest: manifest(profile.origins),
      profile,
      secrets: { 'fixture.accessCode': 'sensitive-value' },
      sourceFilePath,
      briefFilePath,
      inputImagePaths: [imagePath],
      headed: false,
      browserExecutablePath: '/verified/chromium',
      sourceCodexHome: sourceHome,
      environment: {
        PATH: '/usr/bin',
        [homeKey]: homeValue,
        FIXTURE_MODEL_KEY: 'provider-key',
        AUTO_TEST_AGENT_FORWARD_ENV: 'FIXTURE_FORWARD',
        FIXTURE_FORWARD: 'agent-only-secret',
        UNRELATED_SERVER_SECRET: 'must-not-forward',
      },
    })

    const config = await readFile(resolve(workspace.agentHome, 'config.toml'), 'utf8')
    const playwrightConfig = JSON.parse(await readFile(workspace.playwrightConfigPath, 'utf8'))
    const mergedState = JSON.parse(await readFile(resolve(workspace.privateDirectory, 'merged-storage-state.json'), 'utf8'))
    const secrets = await readFile(workspace.playwrightSecretsPath, 'utf8')
    const serializedWorkspace = [
      await readFile(workspace.manifestPath, 'utf8'),
      await readFile(resolve(workspace.workspaceDirectory, 'AGENTS.md'), 'utf8'),
      JSON.stringify(playwrightConfig),
    ].join('\n')

    expect(config).toContain('[model_providers.fixture]')
    expect(config).toContain('model_context_window = 400000')
    expect(config).not.toContain('mcp_servers.unrelated')
    expect(playwrightConfig.browser.launchOptions.executablePath).toBe('/verified/chromium')
    expect(playwrightConfig.network).toBeUndefined()
    expect(playwrightConfig.capabilities).toEqual(expect.arrayContaining(['core', 'network', 'testing', 'vision', 'devtools']))
    expect(playwrightConfig.codegen).toBe('typescript')
    const controlConfig = JSON.parse(await readFile(workspace.controlConfigPath, 'utf8'))
    expect(controlConfig.evidenceDirectory).toBe(workspace.evidenceDirectory)
    expect(controlConfig.caseResultsPath).toBe(workspace.caseResultsPath)
    expect(controlConfig.allowedOrigins).toEqual(profile.origins)
    expect(controlConfig.environmentRequirementsPath).toBe(workspace.environmentRequirementsPath)
    expect(controlConfig.executionReceiptsPath).toBe(workspace.executionReceiptsPath)
    expect(controlConfig.fieldCompositionPath).toBe(workspace.fieldCompositionPath)
    expect(controlConfig.secretValuesPath).toBe(workspace.playwrightSecretsPath)
    expect(controlConfig.testDataAccess).toBe('direct')
    expect(controlConfig.caseRisks).toBeUndefined()
    expect(JSON.parse(await readFile(workspace.caseResultsPath, 'utf8'))).toEqual([])
    expect(JSON.parse(await readFile(workspace.executionReceiptsPath, 'utf8'))).toEqual([])
    expect(JSON.parse(await readFile(workspace.fieldCompositionPath, 'utf8'))).toEqual([])
    expect(mergedState.cookies).toHaveLength(2)
    expect(mergedState.origins).toHaveLength(2)
    expect(mergedState.origins.find((item: { origin: string }) => item.origin === 'https://two.example.test').indexedDB).toHaveLength(1)
    expect(secrets).toContain('AUTO_TEST_VALUE_001="sensitive-value"')
    expect(workspace.secretAliases[0]?.aliases).toEqual(['AUTO_TEST_VALUE_001'])
    expect(await readFile(workspace.sourceFilePath!, 'utf8')).toBe('raw-workbook')
    expect(await readFile(workspace.briefFilePath!, 'utf8')).toBe('raw-brief')
    expect(await readFile(workspace.inputImagePaths[0]!, 'utf8')).toBe('raw-image')
    expect(JSON.parse(await readFile(workspace.runValuesPath!, 'utf8'))).toContainEqual(expect.objectContaining({
      secretRef: 'fixture.accessCode', alias: 'AUTO_TEST_VALUE_001', value: 'sensitive-value',
    }))
    expect(await readFile(resolve(workspace.workspaceDirectory, 'AGENTS.md'), 'utf8')).toContain('primary test engineer')
    expect(workspace.codexEnvironment).toMatchObject({ PATH: '/usr/bin', [homeKey]: homeValue, FIXTURE_MODEL_KEY: 'provider-key', FIXTURE_FORWARD: 'agent-only-secret' })
    expect(workspace.codexEnvironment).not.toHaveProperty('UNRELATED_SERVER_SECRET')
    expect(workspace.mcpEnvironment).toMatchObject({ PATH: '/usr/bin', [homeKey]: homeValue })
    expect(workspace.mcpEnvironment.FIXTURE_MODEL_KEY).toBe('')
    expect(workspace.mcpEnvironment).not.toHaveProperty('FIXTURE_FORWARD')
    expect(serializedWorkspace).not.toContain('sensitive-value')
    expect(await readFile(workspace.runValuesPath!, 'utf8')).not.toContain('provider-key')
    expect(workspace.runValuesPath).toBe(resolve(workspace.privateDirectory, 'run-values.json'))
    await expect(access(resolve(workspace.inputDirectory, 'run-values.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (process.platform !== 'win32') {
      expect((await stat(workspace.playwrightSecretsPath)).mode & 0o777).toBe(0o600)
      await chmod(workspace.playwrightSecretsPath, 0o600)
    }
  })

  it('refreshes ephemeral browser configuration without resetting persisted recovery state', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-workspace-resume-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const profile: EnvironmentProfile = {
      id: 'workspace-fixture',
      origins: ['https://one.example.test'],
      auth: [],
      policy: { allowWrite: false, allowDestructive: false },
    }
    const options = {
      outputDirectory: resolve(directory, 'run'),
      manifest: manifest(profile.origins),
      profile,
      secrets: { 'fixture.accessCode': 'first-value' },
      headed: false,
      browserExecutablePath: '/verified/chromium',
      sourceCodexHome: sourceHome,
    }
    const initial = await prepareCodexAgentWorkspace(options)
    const ledger = [{
      id: 'pending-action', caseId: 'inspect-board', description: 'Pending recovery', risk: 'write', status: 'pending',
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', evidence: [],
    }]
    const evidence = [{ caseId: 'inspect-board', kind: 'observation', description: 'Prior evidence' }]
    const decisions = [{ caseId: 'inspect-board', outcome: 'blocked', summary: 'Interrupted', blockers: ['network'], productDefects: [], recordedAt: '2026-08-01T00:00:00.000Z' }]
    const plan = { summary: 'Recover', steps: [{ id: 'recover', status: 'in_progress' }] }
    const fieldGates = [{ id: 'inspect-board:value', caseId: 'inspect-board', fieldId: 'value', status: 'passed' }]
    await writeFile(initial.mutationLedgerPath, JSON.stringify(ledger))
    await writeFile(initial.evidenceIndexPath, JSON.stringify(evidence))
    await writeFile(initial.caseResultsPath, JSON.stringify(decisions))
    await writeFile(initial.planPath, JSON.stringify(plan))
    await writeFile(initial.fieldCompositionPath, JSON.stringify(fieldGates))
    const legacyRunValuesPath = resolve(initial.inputDirectory, 'run-values.json')
    await writeFile(legacyRunValuesPath, 'legacy-plaintext-value')

    const resumed = await prepareCodexAgentWorkspace({ ...options, secrets: { 'fixture.accessCode': 'rotated-value' }, resume: true })

    expect(JSON.parse(await readFile(resumed.mutationLedgerPath, 'utf8'))).toEqual(ledger)
    expect(JSON.parse(await readFile(resumed.evidenceIndexPath, 'utf8'))).toEqual(evidence)
    expect(JSON.parse(await readFile(resumed.caseResultsPath, 'utf8'))).toEqual(decisions)
    expect(JSON.parse(await readFile(resumed.planPath, 'utf8'))).toEqual(plan)
    expect(JSON.parse(await readFile(resumed.fieldCompositionPath, 'utf8'))).toEqual(fieldGates)
    expect(await readFile(resumed.playwrightSecretsPath, 'utf8')).toContain('rotated-value')
    expect(await readFile(resumed.runValuesPath!, 'utf8')).toContain('rotated-value')
    await expect(access(legacyRunValuesPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows an append-only registered origin during resume', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-workspace-origins-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const firstProfile: EnvironmentProfile = {
      id: 'workspace-fixture',
      origins: ['https://one.example.test'],
      auth: [],
      policy: { allowWrite: false, allowDestructive: false },
    }
    const options = {
      outputDirectory: resolve(directory, 'run'),
      manifest: manifest(firstProfile.origins),
      profile: firstProfile,
      secrets: {},
      headed: false,
      browserExecutablePath: '/verified/chromium',
      sourceCodexHome: sourceHome,
    }
    await prepareCodexAgentWorkspace(options)
    const resumed = await prepareCodexAgentWorkspace({
      ...options,
      profile: { ...firstProfile, origins: [...firstProfile.origins, 'https://two.example.test'] },
      resume: true,
    })

    const control = JSON.parse(await readFile(resumed.controlConfigPath, 'utf8')) as { allowedOrigins: string[] }
    expect(control.allowedOrigins).toEqual(['https://one.example.test', 'https://two.example.test'])
  })

  it('preserves the legacy restricted workspace when opaque test data is requested', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-workspace-restricted-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), 'model = "fixture"\n', { mode: 0o600 })
    const sourceFilePath = resolve(directory, 'fixture.xlsx')
    await writeFile(sourceFilePath, 'raw-workbook')
    const profile: EnvironmentProfile = {
      id: 'workspace-fixture', origins: ['https://one.example.test'], auth: [],
      policy: { allowWrite: false, allowDestructive: false },
    }

    const workspace = await prepareCodexAgentWorkspace({
      outputDirectory: resolve(directory, 'run'),
      manifest: manifest(profile.origins),
      profile,
      secrets: { 'fixture.accessCode': 'sensitive-value' },
      sourceFilePath,
      headed: false,
      browserExecutablePath: '/verified/chromium',
      sourceCodexHome: sourceHome,
      testDataAccess: 'opaque',
    })

    const playwrightConfig = JSON.parse(await readFile(workspace.playwrightConfigPath, 'utf8'))
    expect(workspace.sourceFilePath).toBeUndefined()
    expect(workspace.runValuesPath).toBeUndefined()
    expect(playwrightConfig.capabilities).toEqual(['core', 'storage'])
    expect(playwrightConfig.network.allowedOrigins).toEqual(profile.origins)
    expect(playwrightConfig.codegen).toBe('none')
    expect(await readFile(resolve(workspace.workspaceDirectory, 'AGENTS.md'), 'utf8')).toContain('Restricted Workspace')
  })

  it('writes the selected model profile into the isolated Codex config and forwards its API key env', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-workspace-model-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), [
      'model = "fixture-model"',
      'model_provider = "fixture"',
      '',
      '[model_providers.fixture]',
      'base_url = "https://model.example.test/v1"',
      'wire_api = "responses"',
      'env_key = "FIXTURE_MODEL_KEY"',
    ].join('\n'), { mode: 0o600 })
    const profile: EnvironmentProfile = {
      id: 'workspace-fixture',
      origins: ['https://app.example.test'],
      auth: [],
      policy: { allowWrite: false, allowDestructive: false },
    }

    const workspace = await prepareCodexAgentWorkspace({
      outputDirectory: resolve(directory, 'run'),
      manifest: manifest(profile.origins),
      profile,
      secrets: {},
      headed: false,
      browserExecutablePath: '/verified/chromium',
      sourceCodexHome: sourceHome,
      environment: { GLM_API_KEY: 'glm-secret', FIXTURE_MODEL_KEY: 'fixture-secret' },
      modelProfile: {
        id: 'glm', model: 'glm-4.6', providerId: 'glm_api',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4', wireApi: 'chat', envKey: 'GLM_API_KEY', reasoningEffort: 'xhigh',
      },
    })

    const config = await readFile(resolve(workspace.agentHome, 'config.toml'), 'utf8')
    expect(config).toContain('model = "glm-4.6"')
    expect(config).toContain('model_provider = "glm_api"')
    expect(config).toContain('[model_providers.glm_api]')
    expect(config).toContain('base_url = "https://open.bigmodel.cn/api/paas/v4"')
    expect(config).toContain('wire_api = "chat"')
    expect(config).toContain('env_key = "GLM_API_KEY"')
    expect(config).toContain('model_reasoning_effort = "xhigh"')
    expect(config).not.toContain('fixture-model')
    expect(config).not.toContain('FIXTURE_MODEL_KEY')
    expect(workspace.codexEnvironment).toMatchObject({ GLM_API_KEY: 'glm-secret' })
    expect(workspace.codexEnvironment).not.toHaveProperty('FIXTURE_MODEL_KEY')
  })

  it('isolates OMP provider state and never inherits a user MCP definition', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-workspace-omp-'))
    directories.push(directory)
    const ompHome = resolve(directory, 'omp-agent')
    await mkdir(ompHome)
    await writeFile(resolve(ompHome, 'models.yml'), 'providers:\n  fixture:\n    baseUrl: https://model.example.test\n', { mode: 0o600 })
    await writeFile(resolve(ompHome, 'agent.db'), 'sqlite-auth-fixture', { mode: 0o600 })
    await writeFile(resolve(ompHome, 'auth.json'), '{"fixture":"legacy-private"}', { mode: 0o600 })
    await writeFile(resolve(ompHome, 'mcp.json'), '{"mcpServers":{"unrelated":{}}}', { mode: 0o600 })
    const profile: EnvironmentProfile = {
      id: 'workspace-omp-fixture',
      origins: ['https://app.example.test'],
      auth: [],
      policy: { allowWrite: false, allowDestructive: false },
    }

    const workspace = await prepareCodexAgentWorkspace({
      outputDirectory: resolve(directory, 'run'),
      manifest: manifest(profile.origins),
      profile,
      secrets: {},
      headed: false,
      browserExecutablePath: '/verified/chromium',
      sourceCodexHome: resolve(directory, 'unused-codex-home'),
      sourceAgentHome: ompHome,
      agentHostId: 'omp',
      environment: {
        HOME: resolve(directory, 'user-home'),
        PATH: '/usr/bin',
        AUTO_TEST_AGENT_FORWARD_ENV: 'OMP_API_KEY',
        OMP_API_KEY: 'agent-provider-secret',
      },
    })

    expect(await readFile(resolve(workspace.agentHome, 'models.yml'), 'utf8')).toContain('fixture')
    expect(await readFile(resolve(workspace.agentHome, 'agent.db'), 'utf8')).toBe('sqlite-auth-fixture')
    expect(await readFile(resolve(workspace.agentHome, 'auth.json'), 'utf8')).toContain('legacy-private')
    await expect(access(resolve(workspace.agentHome, 'mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(workspace.environment).toMatchObject({ PI_CODING_AGENT_DIR: workspace.agentHome, OMP_API_KEY: 'agent-provider-secret' })
    expect(workspace.environment.HOME).toBe(resolve(workspace.privateDirectory, 'omp-home'))
    expect(workspace.mcpEnvironment).not.toHaveProperty('OMP_API_KEY')
    expect(workspace.mcpEnvironment.HOME).toBe(resolve(workspace.privateDirectory, 'omp-mcp-home'))
    expect(workspace.mcpEnvironment.HOME).not.toBe(resolve(directory, 'user-home'))
    const mcpConfig = JSON.parse(await readFile(workspace.ompMcpConfigPath, 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(mcpConfig.mcpServers).sort()).toEqual(['auto-test-control', 'playwright'])
    const ompConfig = await readFile(workspace.ompConfigPath, 'utf8')
    expect(ompConfig).toContain('enabled: false')
    expect(ompConfig).toContain('backend: off')

    await writeFile(resolve(ompHome, 'agent.db'), 'rotated-sqlite-auth-fixture', { mode: 0o600 })
    const resumed = await prepareCodexAgentWorkspace({
      outputDirectory: resolve(directory, 'run'),
      manifest: manifest(profile.origins),
      profile,
      secrets: {},
      headed: false,
      browserExecutablePath: '/verified/chromium',
      sourceCodexHome: resolve(directory, 'unused-codex-home'),
      sourceAgentHome: ompHome,
      agentHostId: 'omp',
      environment: {
        HOME: resolve(directory, 'user-home'),
        PATH: '/usr/bin',
      },
      resume: true,
    })
    expect(await readFile(resolve(resumed.agentHome, 'agent.db'), 'utf8')).toBe('rotated-sqlite-auth-fixture')

    const ambientHome = resolve(directory, 'ambient-home')
    await mkdir(resolve(ambientHome, '.omp', 'agent'), { recursive: true })
    await writeFile(resolve(ambientHome, '.omp', 'agent', 'agent.db'), 'ambient-must-not-replace-run-auth', { mode: 0o600 })
    const preserved = await prepareCodexAgentWorkspace({
      outputDirectory: resolve(directory, 'run'),
      manifest: manifest(profile.origins),
      profile,
      secrets: {},
      headed: false,
      browserExecutablePath: '/verified/chromium',
      agentHostId: 'omp',
      environment: {
        HOME: ambientHome,
        PATH: '/usr/bin',
      },
      resume: true,
    })
    expect(await readFile(resolve(preserved.agentHome, 'agent.db'), 'utf8')).toBe('rotated-sqlite-auth-fixture')
  })
})
