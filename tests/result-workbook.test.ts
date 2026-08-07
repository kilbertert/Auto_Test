import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { read, utils, write } from '@e965/xlsx'
import { afterEach, describe, expect, it } from 'vitest'
import { listOoxmlParts, readOoxmlPart, writeResultWorkbook } from '../src/agent/result-workbook.js'
import type { CodexTestAgentResult } from '../src/agent/types.js'
import type { WorkflowIntakeManifest } from '../src/workflow/types.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function manifest(): WorkflowIntakeManifest {
  return {
    version: '1.0', kind: 'workflow-intake', workflowId: 'result-workbook-fixture',
    source: { format: 'xlsx', fileName: 'cases.xlsx', sheetName: 'Cases', sha256: 'd'.repeat(64) },
    targetUrls: ['https://fixture.example.test'], requiredCapabilities: [],
    phases: [
      { id: 'duplicate-row-2', sourceCaseId: 'same-id', title: 'First duplicate', sourceRow: 2, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
      { id: 'duplicate-row-3', sourceCaseId: 'same-id', title: 'Second duplicate', sourceRow: 3, risk: 'read', steps: [], resources: [], secretBindings: [], imageIds: [], review: { status: 'draft', ambiguities: [] } },
    ],
    embeddedImages: [], supplementalImages: [], review: { status: 'draft', reasons: [] },
  }
}

function result(outcome: CodexTestAgentResult['outcome']): CodexTestAgentResult {
  const firstOutcome = outcome === 'passed' ? 'passed' : outcome
  return {
    version: '1.0', workflowId: 'result-workbook-fixture', sourceSha256: 'd'.repeat(64), outcome,
    summary: 'Fixture result.', startedAt: '2026-08-03T00:00:00.000Z', finishedAt: '2026-08-03T00:01:00.000Z',
    cases: [
      {
        caseId: 'duplicate-row-2', title: 'First duplicate', outcome: firstOutcome,
        summary: outcome === 'passed' ? 'First row passed.' : 'First row was blocked without copying a secret.',
        ...(outcome === 'passed' ? {} : { failureSource: outcome === 'product_failed' ? 'product' as const : 'environment' as const, failureKind: outcome === 'product_failed' ? 'assertion' as const : 'data' as const }),
        ...(outcome === 'blocked' ? { environmentRequirementIds: ['environment-test_data-fixture'] } : {}),
        evidence: [{ kind: 'screenshot', path: 'evidence/first.png', description: 'Private description.' }],
      },
      {
        caseId: 'duplicate-row-3', title: 'Second duplicate', outcome: 'passed', summary: 'Second row passed.',
        evidence: [{ kind: 'observation', path: 'evidence/second.md', description: 'Private description.' }],
      },
    ],
    mutations: [], environmentRequirements: outcome === 'blocked' ? [{
      id: 'environment-test_data-fixture', caseIds: ['duplicate-row-2'], kind: 'test_data', condition: 'Observed fixture data is absent.', evidence: ['evidence/first.png'], status: 'pending', requestedAt: '2026-08-03T00:01:00.000Z',
    }] : [],
    blockers: outcome === 'blocked' ? ['Observed fixture data is absent.'] : [],
    productDefects: outcome === 'product_failed' ? ['Observed mismatch.'] : [], nextActions: [],
  }
}

async function sourceWorkbook(directory: string): Promise<{ path: string; content: Buffer }> {
  const workbook = utils.book_new()
  const sheet = utils.aoa_to_sheet([
    ['用例ID', '测试步骤', '预期结果'],
    ['same-id', '第一条', '通过'],
    ['same-id', '第二条', '通过'],
    ['merged', '', ''],
  ])
  sheet.C2 = { t: 'n', f: '1+1', v: 2 }
  sheet['!merges'] = [utils.decode_range('A4:B4')]
  utils.book_append_sheet(workbook, sheet, 'Cases')
  const auxiliary = utils.aoa_to_sheet([['保留'], ['完全不改写']])
  utils.book_append_sheet(workbook, auxiliary, 'Auxiliary')
  const content = Buffer.from(write(workbook, { type: 'buffer', bookType: 'xlsx' }))
  const path = resolve(directory, 'cases.xlsx')
  await writeFile(path, content)
  return { path, content }
}

async function offsetSourceWorkbook(directory: string): Promise<{ path: string; content: Buffer }> {
  const workbook = utils.book_new()
  const sheet = {
    B2: { t: 's', v: 'same-id' },
    C2: { t: 's', v: 'First duplicate' },
    B3: { t: 's', v: 'same-id' },
    C3: { t: 's', v: 'Second duplicate' },
    '!ref': 'B2:C3',
  }
  utils.book_append_sheet(workbook, sheet, 'Cases')
  const content = Buffer.from(write(workbook, { type: 'buffer', bookType: 'xlsx' }))
  const path = resolve(directory, 'offset-cases.xlsx')
  await writeFile(path, content)
  return { path, content }
}

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

describe('result workbook writeback', () => {
  it.each(['passed', 'product_failed', 'blocked'] as const)('writes %s outcomes to a new workbook without changing source parts', async (outcome) => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-result-workbook-'))
    directories.push(directory)
    const source = await sourceWorkbook(directory)
    const workflow = manifest()
    const targetPart = 'xl/worksheets/sheet1.xml'
    const parts = listOoxmlParts(source.content)
    const originalParts = new Map(parts.map((part) => [part, digest(readOoxmlPart(source.content, part))]))

    const artifact = await writeResultWorkbook({
      sourceFilePath: source.path,
      outputDirectory: directory,
      manifest: workflow,
      result: result(outcome),
    })

    expect(artifact.path).toContain('cases-Auto-Test-结果.xlsx')
    expect(await readFile(source.path)).toEqual(source.content)
    const output = await readFile(artifact.path)
    for (const part of parts) {
      if (part === targetPart) continue
      expect(digest(readOoxmlPart(output, part))).toBe(originalParts.get(part))
    }
    const workbook = read(output, { type: 'buffer', cellFormula: true, cellText: true })
    const sheet = workbook.Sheets.Cases!
    expect(sheet.D1?.v).toBe('Auto-Test 状态')
    expect(sheet.D2?.v).toBe(outcome === 'passed' ? '通过' : outcome === 'product_failed' ? '产品不符合预期' : '阻断')
    expect(sheet.D3?.v).toBe('通过')
    expect(sheet.H2?.v).toBe('evidence/first.png')
    expect(sheet.I2?.v).toBe(outcome === 'blocked' ? 'environment-test_data-fixture' : '')
    expect(sheet.C2?.f).toBe('1+1')
    expect(sheet['!merges']).toContainEqual(utils.decode_range('A4:B4'))
    expect(workbook.Sheets.Auxiliary?.A2?.v).toBe('完全不改写')
  })

  it('extends the worksheet dimension when it inserts a header above the original range', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-result-workbook-offset-'))
    directories.push(directory)
    const source = await offsetSourceWorkbook(directory)

    const artifact = await writeResultWorkbook({
      sourceFilePath: source.path,
      outputDirectory: directory,
      manifest: manifest(),
      result: result('passed'),
    })

    const output = await readFile(artifact.path)
    const workbook = read(output, { type: 'buffer', cellText: true })
    const sheet = workbook.Sheets.Cases!
    expect(sheet['!ref']).toBe('B1:I3')
    expect(sheet.D1?.v).toBe('Auto-Test 状态')
    expect(sheet.D2?.v).toBe('通过')
    expect(sheet.D3?.v).toBe('通过')
  })
})
