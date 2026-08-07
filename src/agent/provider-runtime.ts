import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentHostId, AgentModelApi, AgentModelProviderDescriptor } from './host.js'
import { AgentHostError } from './host.js'

export function forwardedAgentEnvironmentNames(environment: NodeJS.ProcessEnv): Set<string> {
  return new Set((environment.AUTO_TEST_AGENT_FORWARD_ENV ?? '')
    .split(/[,;\s]+/)
    .filter((value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)))
}

export function agentProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  providerEnvironmentName?: string,
  includeForwardedAgentEnvironment = true,
): Record<string, string> {
  const names = process.platform === 'win32'
    ? ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ComSpec']
    : ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']
  if (providerEnvironmentName) names.push(providerEnvironmentName)
  if (includeForwardedAgentEnvironment) {
    for (const name of forwardedAgentEnvironmentNames(environment)) names.push(name)
  }
  const result: Record<string, string> = {}
  for (const name of new Set(names)) {
    const value = environment[name]
    if (value !== undefined) result[name] = value
  }
  return result
}

export function assertProviderApiSupported(
  hostId: AgentHostId,
  displayName: string,
  supportedApis: readonly AgentModelApi[],
  provider: AgentModelProviderDescriptor,
): void {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(provider.providerId)) {
    throw new AgentHostError(hostId, `Model profile ${provider.profileId} has an unsafe providerId`, 'configuration')
  }
  try {
    const url = new URL(provider.baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
    if (url.username || url.password) throw new Error('embedded credentials')
  } catch {
    throw new AgentHostError(hostId, `Model profile ${provider.profileId} has an invalid HTTP(S) base URL`, 'configuration')
  }
  if (supportedApis.includes(provider.api)) return
  throw new AgentHostError(
    hostId,
    `${displayName} does not support model API ${provider.api}; supported APIs: ${supportedApis.join(', ')}`,
    'capability',
  )
}

export function requireProviderCredential(
  hostId: AgentHostId,
  provider: AgentModelProviderDescriptor,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (provider.credential.type === 'none') return undefined
  const name = provider.credential.name
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new AgentHostError(hostId, `Model profile ${provider.profileId} has an invalid credential environment variable`, 'configuration')
  }
  if (!environment[name]) {
    throw new AgentHostError(
      hostId,
      `Model profile ${provider.profileId} requires environment variable ${name}`,
      'configuration',
    )
  }
  return name
}

export function withoutProviderCredential(
  environment: Record<string, string>,
  providerEnvironmentName?: string,
): Record<string, string> {
  const result = { ...environment }
  if (providerEnvironmentName) delete result[providerEnvironmentName]
  return result
}

export async function writePrivateText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, value, { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') await chmod(path, 0o600)
}

export async function copyPrivateFile(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await copyFile(source, destination)
  if (process.platform !== 'win32') await chmod(destination, 0o600)
}
