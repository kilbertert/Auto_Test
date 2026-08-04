import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { utils, write } from '@e965/xlsx'
import { afterEach, describe, expect, it } from 'vitest'
import { assessAgentIntakeReadiness } from '../src/agent/intake-readiness.js'
import { intakeWorkflowXlsx } from '../src/workflow/intake.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Codex-native intake readiness', () => {
  it('keeps every source row, remaps duplicate IDs, and does not make row-local gaps a startup gate', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-agent-intake-'))
    directories.push(directory)
    const filePath = resolve(directory, 'large-cases.xlsx')
    const rows = [
      ['用例ID', '用例标题', '测试步骤', '预期结果', '测试数据'],
      ['case-001', '登录', '打开页面', '显示首页', '账号密码：tester，secret-pass'],
      ['case-001', '重复登录', '再次打开页面', '仍显示首页', ''],
      ['case-003', '缺步骤', '', '', ''],
      ['', '无编号来源行', '查看页面', '显示数据', ''],
      ...Array.from({ length: 22 }, (_, index) => [`case-${String(index + 4).padStart(3, '0')}`, `读取 ${index}`, '查看页面', '显示数据', '']),
    ]
    const workbook = utils.book_new()
    utils.book_append_sheet(workbook, utils.aoa_to_sheet(rows), 'Cases')
    await writeFile(filePath, write(workbook, { type: 'buffer', bookType: 'xlsx' }))

    const result = await intakeWorkflowXlsx({ filePath, additionalUrls: ['https://app.example.test/'] })
    const ids = result.manifest.phases.map((phase) => phase.id)
    const serialized = JSON.stringify(result.manifest)

    expect(result.manifest.phases).toHaveLength(rows.length - 1)
    expect(new Set(ids).size).toBe(rows.length - 1)
    expect(result.manifest.phases.find((phase) => phase.sourceRow === 3)?.id).toBe('case-001-row-3')
    expect(result.manifest.phases.find((phase) => phase.sourceRow === 4)?.steps).toEqual([])
    expect(result.manifest.phases.find((phase) => phase.sourceRow === 5)?.id).toBe('row-5')
    expect(result.report.summary.errors).toBe(0)
    expect(result.report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate_case_id', severity: 'warning' }),
      expect.objectContaining({ code: 'steps_missing', severity: 'warning' }),
      expect.objectContaining({ code: 'case_id_missing', severity: 'warning' }),
    ]))
    expect(serialized).not.toContain('secret-pass')
    expect(serialized).toContain('${secret:workflow.case-001.username}')
    expect(assessAgentIntakeReadiness(result.manifest)).toEqual({ executable: true, problems: [] })
  })

  it('blocks only when the immutable execution contract cannot be formed', () => {
    const manifest = {
      version: '1.0' as const,
      kind: 'workflow-intake' as const,
      workflowId: 'empty',
      source: { format: 'xlsx' as const, fileName: 'empty.xlsx', sheetName: 'Cases', sha256: 'a'.repeat(64) },
      targetUrls: [],
      requiredCapabilities: [],
      phases: [],
      embeddedImages: [],
      supplementalImages: [],
      review: { status: 'draft' as const, reasons: [] },
    }

    expect(assessAgentIntakeReadiness(manifest)).toEqual({
      executable: false,
      problems: ['测试材料没有可访问的目标 URL', '测试材料没有可追踪的测试 case'],
    })
  })
})
