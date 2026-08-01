import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverWorkflowInputBundle } from '../src/workflow/input-bundle.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<{ directory: string; workbook: string; sidecar: string }> {
  const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-input-bundle-'))
  temporaryDirectories.push(directory)
  const workbook = resolve(directory, 'workflow.xlsx')
  const sidecar = resolve(directory, 'workflow.auto-test')
  await writeFile(workbook, 'fixture')
  await mkdir(resolve(sidecar, 'images'), { recursive: true })
  return { directory, workbook, sidecar }
}

describe('workflow input bundle discovery', () => {
  it('discovers a same-name brief and deterministically ordered supplemental images', async () => {
    const { workbook, sidecar } = await fixture()
    await writeFile(resolve(sidecar, 'brief.md'), 'Synthetic workflow brief\n')
    await writeFile(resolve(sidecar, 'images', 'b.png'), 'image-b')
    await writeFile(resolve(sidecar, 'images', 'a.jpg'), 'image-a')
    await writeFile(resolve(sidecar, 'images', 'ignored.txt'), 'ignored')

    const result = await discoverWorkflowInputBundle({ filePath: workbook })

    expect(result.brief).toBe('Synthetic workflow brief\n')
    expect(result.imagePaths.map((path) => basename(path))).toEqual(['a.jpg', 'b.png'])
    expect(result.imageSha256s).toHaveLength(2)
  })

  it('lets an explicit brief override sidecar discovery and rejects ambiguous implicit briefs', async () => {
    const { directory, workbook, sidecar } = await fixture()
    await writeFile(resolve(sidecar, 'brief.md'), 'markdown')
    await writeFile(resolve(sidecar, 'brief.txt'), 'text')
    await expect(discoverWorkflowInputBundle({ filePath: workbook })).rejects.toThrow(/multiple brief/i)

    const explicit = resolve(directory, 'explicit.txt')
    await writeFile(explicit, 'explicit')
    const result = await discoverWorkflowInputBundle({ filePath: workbook, briefPath: explicit })
    expect(result.brief).toBe('explicit')
  })
})
