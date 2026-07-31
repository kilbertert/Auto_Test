import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { secretEnvironmentName } from '../src/runtime/data.js'
import { ensureEnvironmentAuthentication } from '../src/workflow/auth-broker.js'
import type { EnvironmentProfile } from '../src/workflow/environment-profile.js'

const temporaryDirectories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<{ profile: EnvironmentProfile; environment: NodeJS.ProcessEnv; storageStatePath: string }> {
  const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-auth-broker-'))
  temporaryDirectories.push(directory)
  const storageStatePath = resolve(directory, 'storage-state.json')
  await writeFile(storageStatePath, '{"cookies":[],"origins":[]}\n', { mode: 0o600 })
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    if (request.url?.startsWith('/index')) {
      response.end('<!doctype html><title>Index</title><h1>Authenticated</h1>')
      return
    }
    response.end(`<!doctype html><title>Login</title>
      <input placeholder="Username"><input type="password" placeholder="Password">
      <label class="agreement"><input type="checkbox">Agree</label><button disabled>Sign in</button>
      <script>
        if (localStorage.getItem('auth') === 'ok') location.replace('/index');
        const inputs = document.querySelectorAll('input'); const button = document.querySelector('button');
        const update = () => button.disabled = !(inputs[0].value && inputs[1].value && inputs[2].checked);
        inputs.forEach((input) => input.addEventListener('input', update)); inputs[2].addEventListener('change', update);
        button.addEventListener('click', () => { localStorage.setItem('auth', 'ok'); location.href = '/index'; });
      </script>`)
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server has no address')
  const origin = `http://127.0.0.1:${address.port}`
  const profile: EnvironmentProfile = {
    id: 'auth-fixture',
    origins: [origin],
    auth: [{
      origin,
      storageStatePath,
      login: {
        loginUrl: `${origin}/login?redirect=/index`,
        successPathname: '/index',
        usernameSecretRef: 'fixture.username',
        passwordSecretRef: 'fixture.password',
        usernameLocator: { strategy: 'placeholder', value: 'Username', source: 'manual' },
        passwordLocator: { strategy: 'placeholder', value: 'Password', source: 'manual' },
        submitLocator: { strategy: 'role', value: 'button', name: 'Sign in', exact: true, source: 'manual' },
        preSubmitChecks: [{
          checkboxLocator: { strategy: 'css', value: '.agreement input', source: 'manual' },
          controlLocator: { strategy: 'css', value: '.agreement', source: 'manual' },
        }],
      },
    }],
    policy: { allowWrite: false, allowDestructive: false },
  }
  return {
    profile,
    storageStatePath,
    environment: {
      [secretEnvironmentName('fixture.username')]: 'synthetic-user',
      [secretEnvironmentName('fixture.password')]: 'synthetic-password',
    },
  }
}

describe('environment authentication broker', () => {
  it('does not mistake a redirect query for success and persists a reusable private session', async () => {
    const { profile, environment, storageStatePath } = await fixture()
    const first = await ensureEnvironmentAuthentication(profile, environment)
    const second = await ensureEnvironmentAuthentication(profile, environment)

    expect(first.refreshedOrigins).toEqual(profile.origins)
    expect(second.refreshedOrigins).toEqual([])
    expect((await stat(storageStatePath)).mode & 0o777).toBe(0o600)
  })
})
