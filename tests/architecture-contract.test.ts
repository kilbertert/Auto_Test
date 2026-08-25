import { readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

interface ArchitectureRule {
  from: string
  forbidden: Set<string>
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path)
  }
  return files
}

function parseArchitecture(source: string): { layers: Map<string, string>, rules: ArchitectureRule[] } {
  const layers = new Map<string, string>()
  const layerPattern = /^  (\w+): \[([^\]]*)\]/gm
  for (const match of source.matchAll(layerPattern)) {
    const layer = match[1]!
    for (const directory of match[2]!.split(',').map((item) => item.trim()).filter(Boolean)) {
      const rootName = directory.slice('src.'.length)
      layers.set(rootName, layer)
    }
  }

  const rules: ArchitectureRule[] = []
  const rulePattern = /  - from: (\w+)\n    cannot_depend_on: \[([^\]]*)\]/g
  for (const match of source.matchAll(rulePattern)) {
    const forbidden = new Set(match[2]!.split(',').map((item) => item.trim()).filter(Boolean))
    rules.push({ from: match[1]!, forbidden })
  }
  return { layers, rules }
}

describe('architecture contract', () => {
  it('declares exactly the current source layers without removed runtime directories', async () => {
    const source = await readFile(resolve(root, 'architecture.yml'), 'utf8')
    const { layers } = parseArchitecture(source)
    const declared = [...layers.entries()].map(([directory, layer]) => `src.${directory}: ${layer}`).sort()
    const actualDirectories = (await readdir(resolve(root, 'src'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    const actual = actualDirectories.map((directory) => `src.${directory}: ${layers.get(directory) ?? 'missing'}`).sort()

    expect(actual.filter((line) => line.endsWith(': missing'))).toEqual([])
    expect(declared).toEqual(actual)
  })

  it('keeps the declared layer rules consistent with current relative imports', async () => {
    const architecture = await readFile(resolve(root, 'architecture.yml'), 'utf8')
    const { layers, rules } = parseArchitecture(architecture)
    const forbidden = new Map(rules.map((rule) => [rule.from, rule.forbidden]))
    const violations: string[] = []

    for (const file of await sourceFiles(resolve(root, 'src'))) {
      const relativeFile = relative(resolve(root, 'src'), file)
      if (!relativeFile.includes(sep)) continue
      const fromLayer = layers.get(relativeFile.split(sep)[0]!)
      const source = await readFile(file, 'utf8')
      for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
        const imported = relative(dirname(file), resolve(dirname(file), match[1]!))
        if (imported.startsWith('..') || !imported.includes(sep)) continue
        const toLayer = layers.get(imported.split(sep)[0]!)
        if (!fromLayer || !toLayer) continue
        if (forbidden.get(fromLayer)?.has(toLayer)) {
          violations.push(`${relativeFile} imports ${toLayer} from ${fromLayer}`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})
