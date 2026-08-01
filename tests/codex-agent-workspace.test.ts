import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
  it('isolates Codex configuration, merges multi-origin state, and exposes only secret aliases', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-workspace-'))
    directories.push(directory)
    const sourceHome = resolve(directory, 'source-home')
    await mkdir(sourceHome)
    await writeFile(resolve(sourceHome, 'config.toml'), [
      'model = "fixture-model"',
      'model_provider = "fixture"',
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

    const workspace = await prepareCodexAgentWorkspace({
      outputDirectory: resolve(directory, 'run'),
      manifest: manifest(profile.origins),
      profile,
      secrets: { 'fixture.accessCode': 'sensitive-value' },
      headed: false,
      browserExecutablePath: '/verified/chromium',
      sourceCodexHome: sourceHome,
      environment: {
        PATH: '/usr/bin',
        HOME: '/home/fixture',
        FIXTURE_MODEL_KEY: 'provider-key',
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
    expect(config).not.toContain('mcp_servers.unrelated')
    expect(playwrightConfig.browser.launchOptions.executablePath).toBe('/verified/chromium')
    expect(playwrightConfig.network.allowedOrigins).toEqual(profile.origins)
    const controlConfig = JSON.parse(await readFile(workspace.controlConfigPath, 'utf8'))
    expect(controlConfig.evidenceDirectory).toBe(workspace.evidenceDirectory)
    expect(controlConfig.caseResultsPath).toBe(workspace.caseResultsPath)
    expect(controlConfig.caseRisks).toEqual({ 'inspect-board': 'read' })
    expect(JSON.parse(await readFile(workspace.caseResultsPath, 'utf8'))).toEqual([])
    expect(mergedState.cookies).toHaveLength(2)
    expect(mergedState.origins).toHaveLength(2)
    expect(mergedState.origins.find((item: { origin: string }) => item.origin === 'https://two.example.test').indexedDB).toHaveLength(1)
    expect(secrets).toContain('AUTO_TEST_VALUE_001="sensitive-value"')
    expect(workspace.secretAliases[0]?.aliases).toEqual(['AUTO_TEST_VALUE_001'])
    expect(workspace.codexEnvironment).toMatchObject({ PATH: '/usr/bin', HOME: '/home/fixture', FIXTURE_MODEL_KEY: 'provider-key' })
    expect(workspace.codexEnvironment).not.toHaveProperty('UNRELATED_SERVER_SECRET')
    expect(workspace.mcpEnvironment).toMatchObject({ PATH: '/usr/bin', HOME: '/home/fixture' })
    expect(workspace.mcpEnvironment.FIXTURE_MODEL_KEY).toBe('')
    expect(serializedWorkspace).not.toContain('sensitive-value')
    if (process.platform !== 'win32') {
      expect((await stat(workspace.playwrightSecretsPath)).mode & 0o777).toBe(0o600)
      await chmod(workspace.playwrightSecretsPath, 0o600)
    }
  })
})
