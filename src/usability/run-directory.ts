import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

export function defaultRunRoot(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  const pathApi = platform === 'win32' ? win32 : posix
  if (platform !== 'win32') return pathApi.resolve('artifacts', 'runs')
  const localData = environment.LOCALAPPDATA || pathApi.resolve(homeDirectory, 'AppData', 'Local')
  return pathApi.resolve(localData, 'auto-test', 'runs')
}

export function defaultRunDirectory(
  filePath: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
  now = new Date(),
): string {
  const pathApi = platform === 'win32' ? win32 : posix
  const stem = pathApi.basename(filePath, pathApi.extname(filePath)).replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 48) || 'workflow'
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  return pathApi.resolve(defaultRunRoot(environment, platform, homeDirectory), `${timestamp}-${stem}-${now.getTime().toString(36).slice(-5)}`)
}
