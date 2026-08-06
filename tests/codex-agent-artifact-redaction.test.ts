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

  it('keeps JSON and JSONL parseable when numeric values resemble sensitive identifiers', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-structured-artifact-redaction-'))
    try {
      const jsonPath = resolve(directory, 'event.json')
      const jsonlPath = resolve(directory, 'events.jsonl')
      await writeFile(jsonPath, JSON.stringify({ cost: 0.09356, message: 'fixture-password' }))
      await writeFile(jsonlPath, `${JSON.stringify({ cost: 0.09356, message: 'fixture-password' })}\n`)

      await redactAgentTextArtifacts(directory, ['fixture-password'])

      expect(JSON.parse(await readFile(jsonPath, 'utf8'))).toEqual({ cost: 0.09356, message: '<redacted-secret>' })
      const lines = (await readFile(jsonlPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      expect(lines).toEqual([{ cost: 0.09356, message: '<redacted-secret>' }])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not rewrite structured artifacts when no value changed', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-structured-artifact-unchanged-'))
    try {
      const jsonPath = resolve(directory, 'compact.json')
      const jsonlPath = resolve(directory, 'windows.jsonl')
      const json = '{"message":"visible","count":1}'
      const jsonl = '{"message":"visible"}\r\n{"message":"also-visible"}\r\n'
      await writeFile(jsonPath, json)
      await writeFile(jsonlPath, jsonl)
      const summary = await redactAgentTextArtifacts(directory, ['secret-not-present'])
      expect(summary.redactedFiles).toBe(0)
      expect(await readFile(jsonPath, 'utf8')).toBe(json)
      expect(await readFile(jsonlPath, 'utf8')).toBe(jsonl)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('redacts structured object keys as well as string leaves', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-structured-artifact-keys-'))
    try {
      const path = resolve(directory, 'event.json')
      await writeFile(path, JSON.stringify({ 'fixture-password': 'fixture-password' }))
      await redactAgentTextArtifacts(directory, ['fixture-password'])
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, string>
      expect(value).toEqual({ '<redacted-secret>': '<redacted-secret>' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
