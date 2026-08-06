import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { redactAgentTextArtifacts, sanitizeAgentDeliveryEvidencePaths } from '../src/agent/artifact-redaction.js'

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

  it('does not rewrite immutable contract files while scrubbing generated text', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-immutable-artifact-redaction-'))
    try {
      const manifestPath = resolve(directory, 'test-manifest.json')
      const evidencePath = resolve(directory, 'evidence.json')
      const manifest = JSON.stringify({ testData: '账号：${secret:fixture.username} 密码：${secret:fixture.password}' })
      const evidence = JSON.stringify({ access_token: 'opaque-runtime-token-value' })
      await writeFile(manifestPath, manifest)
      await writeFile(evidencePath, evidence)

      const summary = await redactAgentTextArtifacts(directory, [], { excludedFiles: [manifestPath] })

      expect(summary).toEqual({ scannedFiles: 1, redactedFiles: 1 })
      expect(await readFile(manifestPath, 'utf8')).toBe(manifest)
      expect(JSON.parse(await readFile(evidencePath, 'utf8'))).toEqual({ access_token: '<redacted>' })
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

  it('scrubs runtime JWTs and opaque tokens from structured events and markdown sessions', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-runtime-token-redaction-'))
    try {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJlMTIzNDU2'
      const opaque = 'opaque-refresh-value-abcdef123456'
      const markdownPath = resolve(directory, 'session.md')
      const jsonlPath = resolve(directory, 'events.jsonl')
      await writeFile(markdownPath, `response={"access_token":"${jwt}","refresh_token":"${opaque}"}\n`)
      await writeFile(jsonlPath, `${JSON.stringify({
        type: 'tool_result',
        result: { accessToken: jwt, refresh_token: opaque },
        text: `localStorage access_token=${jwt}`,
      })}\n`)

      await redactAgentTextArtifacts(directory, [])

      const markdown = await readFile(markdownPath, 'utf8')
      expect(markdown).not.toContain(jwt)
      expect(markdown).not.toContain(opaque)
      const event = JSON.parse((await readFile(jsonlPath, 'utf8')).trim()) as {
        result: { accessToken: string; refresh_token: string }
        text: string
      }
      expect(event.result).toEqual({ accessToken: '<redacted>', refresh_token: '<redacted>' })
      expect(event.text).not.toContain(jwt)
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

  it('renames secret-bearing evidence files and keeps delivery references resolvable', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-evidence-path-redaction-'))
    try {
      const evidenceDirectory = resolve(directory, 'evidence')
      await mkdir(evidenceDirectory)
      const secret = 'fixture-phone-1234'
      const sourcePath = resolve(evidenceDirectory, `round-${secret}.png`)
      const artifactPath = resolve(directory, 'case-results.epoch-0001.json')
      await writeFile(sourcePath, 'png')
      await writeFile(artifactPath, JSON.stringify({
        version: '1.0', kind: 'case-results', cases: [{ evidencePaths: [`evidence/round-${secret}.png`] }],
      }))

      const summary = await sanitizeAgentDeliveryEvidencePaths(directory, [secret])
      const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as { cases: Array<{ evidencePaths: string[] }> }
      const reference = artifact.cases[0]!.evidencePaths[0]!

      expect(summary).toEqual({ scannedArtifacts: 1, rewrittenArtifacts: 1, renamedFiles: 1 })
      expect(reference).not.toContain(secret)
      expect(reference).not.toMatch(/[<>]/)
      expect(await readFile(resolve(directory, reference), 'utf8')).toBe('png')
      await expect(readFile(sourcePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reconciles a previously redacted reference with one unique unsanitized file', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-evidence-path-reconcile-'))
    try {
      const evidenceDirectory = resolve(directory, 'evidence')
      await mkdir(evidenceDirectory)
      const secret = 'fixture-phone-5678'
      await writeFile(resolve(evidenceDirectory, `round-${secret}.png`), 'png')
      const artifactPath = resolve(directory, 'case-results.epoch-0001.json')
      await writeFile(artifactPath, JSON.stringify({
        version: '1.0', kind: 'case-results', cases: [{ evidencePaths: ['evidence/round-<redacted-secret>.png'] }],
      }))

      const summary = await sanitizeAgentDeliveryEvidencePaths(directory, [secret])
      const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as { cases: Array<{ evidencePaths: string[] }> }
      const reference = artifact.cases[0]!.evidencePaths[0]!

      expect(summary.renamedFiles).toBe(1)
      expect(reference).toBe('evidence/round-redacted-secret.png')
      expect(await readFile(resolve(directory, reference), 'utf8')).toBe('png')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('never renames immutable input-package files', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-evidence-input-preservation-'))
    try {
      const inputDirectory = resolve(directory, 'input')
      await mkdir(inputDirectory)
      const secret = 'fixture-phone-9012'
      const inputPath = resolve(inputDirectory, `source-${secret}.png`)
      const artifactPath = resolve(directory, 'case-results.epoch-0001.json')
      await writeFile(inputPath, 'immutable')
      await writeFile(artifactPath, JSON.stringify({
        version: '1.0', kind: 'case-results', cases: [{ evidencePaths: [`input/source-${secret}.png`] }],
      }))

      const summary = await sanitizeAgentDeliveryEvidencePaths(directory, [secret])

      expect(summary.renamedFiles).toBe(0)
      expect(await readFile(inputPath, 'utf8')).toBe('immutable')
      const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as { cases: Array<{ evidencePaths: string[] }> }
      expect(artifact.cases[0]!.evidencePaths).toEqual([`input/source-${secret}.png`])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('uses a deterministic free suffix without overwriting path collisions', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-evidence-path-collision-'))
    try {
      const evidenceDirectory = resolve(directory, 'evidence')
      await mkdir(evidenceDirectory)
      const secret = 'fixture-phone-3456'
      const sourceReference = `evidence/round-${secret}.png`
      const sourcePath = resolve(directory, sourceReference)
      const baseCollision = resolve(evidenceDirectory, 'round-redacted-secret.png')
      const firstSuffix = createHash('sha256').update(sourceReference).digest('hex').slice(0, 8)
      const suffixCollision = resolve(evidenceDirectory, `round-redacted-secret-${firstSuffix}.png`)
      const artifactPath = resolve(directory, 'case-results.epoch-0001.json')
      await writeFile(sourcePath, 'source')
      await writeFile(baseCollision, 'base-collision')
      await writeFile(suffixCollision, 'suffix-collision')
      await writeFile(artifactPath, JSON.stringify({
        version: '1.0', kind: 'case-results', cases: [{ evidencePaths: [sourceReference] }],
      }))

      await sanitizeAgentDeliveryEvidencePaths(directory, [secret])
      const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as { cases: Array<{ evidencePaths: string[] }> }
      const reference = artifact.cases[0]!.evidencePaths[0]!

      expect(reference).not.toContain(secret)
      expect(resolve(directory, reference)).not.toBe(baseCollision)
      expect(resolve(directory, reference)).not.toBe(suffixCollision)
      expect(await readFile(resolve(directory, reference), 'utf8')).toBe('source')
      expect(await readFile(baseCollision, 'utf8')).toBe('base-collision')
      expect(await readFile(suffixCollision, 'utf8')).toBe('suffix-collision')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
