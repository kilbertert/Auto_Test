import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveEvidenceArtifact } from '../src/agent/evidence-artifact.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Codex agent evidence artifacts', () => {
  it('accepts Playwright artifacts relative to either the workspace or evidence directory', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'auto-test-evidence-'))
    directories.push(workspace)
    const evidence = resolve(workspace, 'evidence')
    await mkdir(evidence)
    await writeFile(resolve(workspace, 'named.png'), 'image')
    await writeFile(resolve(evidence, 'page.yml'), 'snapshot')

    await expect(resolveEvidenceArtifact(evidence, 'named.png')).resolves.toBe('named.png')
    await expect(resolveEvidenceArtifact(evidence, 'page.yml')).resolves.toBe('evidence/page.yml')
    await expect(resolveEvidenceArtifact(evidence, 'evidence/page.yml')).resolves.toBe('evidence/page.yml')
  })

  it('rejects traversal and internal structured state files', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'auto-test-evidence-reject-'))
    directories.push(workspace)
    const evidence = resolve(workspace, 'evidence')
    await mkdir(evidence)
    await writeFile(resolve(workspace, 'case-results.json'), '[]')
    await writeFile(resolve(workspace, '..', 'outside.txt'), 'outside')

    await expect(resolveEvidenceArtifact(evidence, 'case-results.json')).rejects.toThrow(/supported evidence file/i)
    await expect(resolveEvidenceArtifact(evidence, '../outside.txt')).rejects.toThrow(/inside the configured agent workspace/i)
  })
})
