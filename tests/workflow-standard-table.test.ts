import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { utils, write } from '@e965/xlsx'
import { afterEach, describe, expect, it } from 'vitest'
import { intakeWorkflowXlsx } from '../src/workflow/intake.js'

const root = resolve(import.meta.dirname, '..')

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function standardWorkbook(name: string, rows: unknown[][]): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-standard-table-'))
  temporaryDirectories.push(directory)
  const filePath = resolve(directory, name)
  const workbook = utils.book_new()
  utils.book_append_sheet(workbook, utils.aoa_to_sheet(rows), 'Cases')
  await writeFile(filePath, write(workbook, { type: 'buffer', bookType: 'xlsx' }))
  return filePath
}

describe('native standard-table intake', () => {
  it('parses standard tables without importing the legacy importer or IR modules', async () => {
    const legacyModule = /^(\.\.\/)?(importer|ir\/|validation\/schema)(\/|\.js$)/
    for (const source of ['src/workflow/intake.ts', 'src/workflow/standard-table.ts']) {
      const specifiers = [...(await readFile(resolve(root, source), 'utf8')).matchAll(/from '([^']+)'/g)]
        .map((match) => match[1] ?? '')
      expect(specifiers.filter((specifier) => legacyModule.test(specifier)), source).toEqual([])
    }
  })

  it('redacts neutral module-path and dependency fields before they reach manifest resources', async () => {
    const filePath = await standardWorkbook('neutral-fields.xlsx', [
      ['用例ID', '项目', '模块', '依赖用例', '用例标题', '前置条件', '测试步骤', '预期结果', '优先级', '风险等级'],
      ['case-1', '充电平台 dev@example.test', '用户管理 > 列表', 'case-0, ops@example.test', '查询用户', '已登录', '1.进入用户管理页面', '页面显示用户列表', 'P1', 'read'],
    ])

    const result = await intakeWorkflowXlsx({ filePath, additionalUrls: ['https://app.example.test/'] })
    const serialized = JSON.stringify(result.manifest)

    expect(result.manifest.phases[0]?.resources.find((resource) => resource.text.startsWith('模块路径：'))?.text)
      .toBe('模块路径：充电平台 <redacted-email> > 用户管理 > 列表')
    expect(result.manifest.phases[0]?.resources.find((resource) => resource.text.startsWith('依赖用例：'))?.text)
      .toBe('依赖用例：case-0, <redacted-email>')
    expect(serialized).not.toContain('dev@example.test')
    expect(serialized).not.toContain('ops@example.test')
  })

  it('maps the historical 16-column workbook and keeps the source identity formula', async () => {
    const filePath = resolve(root, 'tests/fixtures/historical-16.xlsx')
    const sha256 = createHash('sha256').update(await readFile(filePath)).digest('hex')

    const result = await intakeWorkflowXlsx({ filePath, additionalUrls: ['https://legacy16.example.test/'] })

    expect(result.manifest.phases[0]).toMatchObject({ id: 'old-001', title: '查询用户列表', summary: '已登录' })
    expect(result.manifest.phases[0]?.resources.some((resource) => resource.text === '模块路径：充电平台 > PC后台 > 系统 > 用户管理 > 列表')).toBe(true)
    expect(result.manifest.workflowId).toBe(`historical-16-${sha256.slice(0, 8)}`)
    expect(result.manifest.source).toMatchObject({
      format: 'xlsx',
      fileName: 'historical-16.xlsx',
      sheetName: '测试用例',
      sha256,
    })
    expect(result.report.summary.errors).toBe(0)
  })

  it('keeps plaintext test-data secrets out of the intake report and manifest', async () => {
    const filePath = await standardWorkbook('plaintext-secret.xlsx', [
      ['用例ID', '用例标题', '测试步骤', '预期结果', '测试数据'],
      ['case-1', '登录检查', '1.打开登录页面', '页面显示欢迎', '密码=super-secret'],
    ])

    const result = await intakeWorkflowXlsx({ filePath, additionalUrls: ['https://app.example.test/'] })

    expect(result.report.diagnostics.some((item) => item.code === 'plaintext_secret')).toBe(false)
    expect(result.report.summary.errors).toBe(0)
    expect(result.manifest.phases[0]?.resources.find((resource) => resource.text.startsWith('测试数据：'))?.text)
      .toBe('测试数据：密码=<redacted>')
    expect(JSON.stringify(result)).not.toContain('super-secret')
  })

  it('keeps the valid-case cap and lets overflow rows fall back for Codex judgement', async () => {
    const rows = [
      ['用例ID', '用例标题', '测试步骤', '预期结果'],
      ...Array.from({ length: 10_005 }, (_, index) => [`case-${index}`, `读取 ${index}`, '1.打开页面', '显示数据']),
    ]
    const filePath = await standardWorkbook('cap.xlsx', rows)

    const result = await intakeWorkflowXlsx({ filePath, additionalUrls: ['https://app.example.test/'] })

    expect(result.manifest.phases).toHaveLength(10_005)
    expect(result.manifest.phases[0]?.steps[0]?.confidence).toBe(0.85)
    expect(result.manifest.phases.at(-1)?.steps[0]?.confidence).toBe(0.5)
    expect(result.report.diagnostics.some((item) => item.code === 'case_limit_applied')).toBe(true)
    expect(result.report.summary.errors).toBe(0)
  })
})
