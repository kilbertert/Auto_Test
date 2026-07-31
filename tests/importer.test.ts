import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importXlsxToIr } from '../src/importer.js'

const root = resolve(import.meta.dirname, '..')

describe('xlsx importer', () => {
  it('imports the canonical template into schema-valid IR', async () => {
    const result = await importXlsxToIr({
      filePath: resolve(root, 'templates/test-cases.xlsx'),
      baseUrl: 'https://example.test/',
    })

    expect(result.schemaValid).toBe(true)
    expect(result.report.summary.errors).toBe(0)
    expect(result.suite.cases).toHaveLength(1)
    expect(result.suite.cases[0]).toMatchObject({
      id: 'login-001',
      title: '正确账号密码登录成功',
      priority: 'P0',
      risk: 'read',
      authProfile: 'admin',
    })
    expect(result.suite.cases[0]?.dataBindings).toEqual([
      { name: 'username', source: 'secret', secretRef: 'admin.username' },
      { name: 'password', source: 'secret', secretRef: 'admin.password' },
    ])
    expect(result.suite.cases[0]?.steps[1]?.valueRef).toBe('username')
    expect(result.suite.cases[0]?.steps[2]?.valueRef).toBe('password')
    expect(result.suite.cases[0]?.assertions.length).toBeGreaterThanOrEqual(1)
  })

  it('maps the legacy 14-column format by header instead of position', async () => {
    const result = await importXlsxToIr({
      filePath: resolve(root, 'tests/fixtures/legacy-14.xlsx'),
      baseUrl: 'https://legacy.example.test/',
    })

    expect(result.schemaValid).toBe(true)
    expect(result.suite.cases).toHaveLength(2)
    expect(result.suite.cases[0]).toMatchObject({
      id: 'test_001',
      title: '正确账号密码验证码登录成功',
      modulePath: ['登录', '登录主流程'],
      priority: 'P0',
    })
    expect(result.suite.cases[0]?.preconditions?.[0]).toContain('登录页面')
    expect(result.suite.cases[0]?.steps[0]?.sourceText).toContain('打开登录页面')
    expect(JSON.stringify(result.suite)).not.toContain('ny5x')
    expect(result.report.diagnostics.some((item) => item.code === 'plaintext_secret')).toBe(true)
  })

  it('reports duplicate IDs, empty expectations and removes plaintext secrets', async () => {
    const result = await importXlsxToIr({
      filePath: resolve(root, 'tests/fixtures/invalid.xlsx'),
      baseUrl: 'https://invalid.example.test/',
    })

    const codes = result.report.diagnostics.map((item) => item.code)
    expect(codes).toContain('duplicate_case_id')
    expect(codes).toContain('expected_missing')
    expect(codes).toContain('plaintext_secret')
    expect(JSON.stringify(result.suite)).not.toContain('super-secret')
    expect(result.suite.cases[0]?.id).toBe('case-001')
  })

  it('supports the old 16-column project and port hierarchy', async () => {
    const result = await importXlsxToIr({
      filePath: resolve(root, 'tests/fixtures/legacy-16.xlsx'),
      baseUrl: 'https://legacy16.example.test/',
    })

    expect(result.schemaValid).toBe(true)
    expect(result.suite.cases[0]?.modulePath).toEqual([
      '充电平台',
      'PC后台',
      '系统',
      '用户管理',
      '列表',
    ])
    expect(result.suite.cases[0]?.title).toBe('查询用户列表')
  })
})
