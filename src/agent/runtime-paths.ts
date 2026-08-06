import { createRequire } from 'node:module'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Resolve package-owned runtime files in both source (tsx) and built (node) runs. */
export function packageFilePath(packageName: string, fileName: string): string {
  try {
    const packagePath = import.meta.resolve(`${packageName}/package.json`)
    return resolve(dirname(fileURLToPath(packagePath)), fileName)
  } catch {
    const require = createRequire(import.meta.url)
    return resolve(dirname(require.resolve(`${packageName}/package.json`)), fileName)
  }
}

export function controlServerPath(): string {
  const extension = extname(fileURLToPath(import.meta.url)) === '.ts' ? '.ts' : '.js'
  return resolve(dirname(fileURLToPath(import.meta.url)), `control-server${extension}`)
}
