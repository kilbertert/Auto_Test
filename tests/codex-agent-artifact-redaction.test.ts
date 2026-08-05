import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { redactAgentTextArtifacts } from '../src/agent/artifact-redaction.js'

describe('agent artifact redaction', () => {
  it('redacts registered secrets and common authentication material in nested evidence text', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-artifact-redaction-'))
    try {
      const nested = resolve(directory, 'session')
      await mkdir(nested)
      const path = resolve(nested, 'session.md')
      await writeFile(path, [
        'username: fixture-user',
        'password: fixture-password',
        'Authorization: Bearer abcdefghijklmnop',
        'Cookie: session=abcdef1234567890',
        'Set-Cookie: refresh=uvwxyz1234567890',
        'x-api-key: private-api-key-value',
      ].join('\n'))

      const summary = await redactAgentTextArtifacts(directory, ['fixture-password', 'fixture-user'])
      const redacted = await readFile(path, 'utf8')

      expect(summary).toEqual({ scannedFiles: 1, redactedFiles: 1 })
      expect(redacted).not.toContain('fixture-password')
      expect(redacted).not.toContain('fixture-user')
      expect(redacted).not.toContain('abcdefghijklmnop')
      expect(redacted).not.toContain('abcdef1234567890')
      expect(redacted).not.toContain('uvwxyz1234567890')
      expect(redacted).not.toContain('private-api-key-value')
      expect(redacted).toContain('<redacted')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('preserves source inputs while scrubbing generated workspace artifacts', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-workspace-redaction-'))
    try {
      const inputDirectory = resolve(directory, 'input')
      await mkdir(inputDirectory)
      const inputPath = resolve(inputDirectory, 'brief.txt')
      const generatedPath = resolve(directory, 'helper.log')
      await writeFile(inputPath, 'fixture-password')
      await writeFile(generatedPath, 'fixture-password')

      const summary = await redactAgentTextArtifacts(directory, ['fixture-password'], {
        excludedDirectories: [inputDirectory],
      })

      expect(summary).toEqual({ scannedFiles: 1, redactedFiles: 1 })
      expect(await readFile(inputPath, 'utf8')).toBe('fixture-password')
      expect(await readFile(generatedPath, 'utf8')).toBe('<redacted-secret>')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
