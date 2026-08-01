import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { utils, write } from '@e965/xlsx'
import { afterEach, describe, expect, it } from 'vitest'
import { intakeWorkflowXlsx } from '../src/workflow/intake.js'
import { parseWpsCellImageIndex } from '../src/workflow/xlsx-media.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('workflow xlsx intake', () => {
  it('bridges a standard test-case sheet into the autonomous workflow manifest', async () => {
    const result = await intakeWorkflowXlsx({
      filePath: resolve(import.meta.dirname, 'fixtures', 'legacy-14.xlsx'),
      additionalUrls: ['https://admin.example.test/', 'https://simulator.example.test/login'],
    })
    const serialized = JSON.stringify(result.manifest)

    expect(result.manifest.phases).toHaveLength(2)
    expect(result.manifest.phases[0]).toMatchObject({ id: 'test-001', title: '正确账号密码验证码登录成功' })
    expect(result.manifest.requiredCapabilities).toEqual(expect.arrayContaining(['multiOrigin', 'otpOrCaptcha']))
    expect(result.manifest.phases[0]?.resources.some((resource) => resource.text.startsWith('预期结果：'))).toBe(true)
    expect(result.manifest.phases[0]?.secretBindings.map((binding) => binding.secretRef)).toEqual(expect.arrayContaining([
      'workflow.test-001.username',
      'workflow.test-001.password',
    ]))
    expect(result.secretMaterial).toMatchObject({
      'workflow.test-001.username': expect.any(String),
      'workflow.test-001.password': expect.any(String),
    })
    expect(serialized).not.toContain('ny5x')
    expect(result.report.summary.errors).toBe(0)
  })

  it('discovers target URLs from a standard test-case workbook without requiring --url', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-standard-url-'))
    try {
      const filePath = resolve(directory, 'cases.xlsx')
      const workbook = utils.book_new()
      const sheet = utils.aoa_to_sheet([
        ['用例ID', '用例标题', '测试步骤', '预期结果', '前置条件'],
        ['catalog-001', '筛选目录', '选择 Lighting 并点击筛选', '只显示两个 Lighting 商品', '打开 https://catalog.example.test/catalog'],
      ])
      utils.book_append_sheet(workbook, sheet, 'Cases')
      await writeFile(filePath, write(workbook, { type: 'buffer', bookType: 'xlsx' }))

      const result = await intakeWorkflowXlsx({ filePath })

      expect(result.manifest.targetUrls).toContain('https://catalog.example.test/catalog')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('moves plaintext secrets from standard titles and steps into secret bindings', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-standard-secret-'))
    try {
      const filePath = resolve(directory, 'secrets.xlsx')
      const workbook = utils.book_new()
      const sheet = utils.aoa_to_sheet([
        ['用例ID', '用例标题', '测试步骤', '预期结果', '测试数据'],
        ['login-001', '使用账号 demo@example.test 密码 secret-pass 登录', '1.输入账号 demo@example.test 密码 secret-pass 2.输入验证码：8888', '页面显示登录成功', '账号=${secret:staging.username};密码=${secret:staging.password}'],
      ])
      utils.book_append_sheet(workbook, sheet, 'Cases')
      await writeFile(filePath, write(workbook, { type: 'buffer', bookType: 'xlsx' }))

      const result = await intakeWorkflowXlsx({ filePath, additionalUrls: ['https://app.example.test/login'] })
      const serialized = JSON.stringify(result.manifest)

      expect(serialized).not.toContain('demo@example.test')
      expect(serialized).not.toContain('secret-pass')
      expect(serialized).not.toContain('8888')
      expect(result.manifest.phases[0]?.secretBindings.map((binding) => binding.secretRef)).toEqual(expect.arrayContaining([
        'workflow.login-001.username',
        'workflow.login-001.password',
        'workflow.login-001.verificationCode',
        'staging.username',
        'staging.password',
      ]))
      expect(result.secretMaterial).toMatchObject({
        'workflow.login-001.username': 'demo@example.test',
        'workflow.login-001.password': 'secret-pass',
        'workflow.login-001.verificationCode': '8888',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('turns a phase table into a secret-safe review manifest', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-workflow-'))
    temporaryDirectories.push(directory)
    const filePath = resolve(directory, 'workflow.xlsx')
    const supplementalImagePath = resolve(directory, 'occupancy.png')
    const workbook = utils.book_new()
    const sheet = utils.aoa_to_sheet([
      ['启动模拟桩', '1.邮箱登录2.点击启动设备', 'tester@example.test/secret-pass'],
      ['模拟充电', '按照多账户重复步骤（1.输入手机号2.输入验证码‘8888’3.点击开始充电4.清空缓存）', 'https://h5.example.test/ +6590000001 +6590000002'],
      ['关停订单', '随机时间窗后（1.匹配最新订单2.点击 Force Stop3.手动结算）'],
    ])
    utils.book_append_sheet(workbook, sheet, 'Flow')
    await writeFile(filePath, write(workbook, { type: 'buffer', bookType: 'xlsx' }))
    await writeFile(supplementalImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const result = await intakeWorkflowXlsx({
      filePath,
      additionalUrls: ['https://admin.example.test/'],
      supplementalImagePaths: [supplementalImagePath],
    })
    const serialized = JSON.stringify(result.manifest)

    expect(result.manifest.phases).toHaveLength(3)
    expect(result.manifest.phases.map((phase) => phase.risk)).toEqual(['write', 'destructive', 'destructive'])
    expect(result.manifest.targetUrls).toEqual(expect.arrayContaining(['https://h5.example.test/', 'https://admin.example.test/']))
    expect(result.manifest.requiredCapabilities).toEqual(expect.arrayContaining([
      'embeddedImageUnderstanding',
      'multiOrigin',
      'freshBrowserContextPerIteration',
      'runtimeEntityCapture',
      'otpOrCaptcha',
      'destructiveApproval',
      'scheduledWait',
    ]))
    expect(result.manifest.phases.flatMap((phase) => phase.secretBindings).map((binding) => binding.secretRef)).toEqual(expect.arrayContaining([
      'workflow.启动模拟桩.username',
      'workflow.启动模拟桩.password',
      'workflow.模拟充电.phoneNumbers',
      'workflow.模拟充电.verificationCode',
    ]))
    expect(serialized).not.toContain('secret-pass')
    expect(serialized).not.toContain('8888')
    expect(serialized).not.toContain('+6590000001')
    expect(serialized).not.toContain('tester@example.test')
    expect(serialized).toContain('${secret:workflow.启动模拟桩.username}')
    expect(serialized).toContain('${secret:workflow.模拟充电.verificationCode}')
    expect(result.manifest.phases[1]?.steps).toHaveLength(4)
    expect(result.report.summary.errors).toBe(0)
    expect(result.report.summary.images).toBe(1)
    expect(result.manifest.supplementalImages).toHaveLength(1)
    expect(result.assets).toHaveLength(1)
    expect(result.secretMaterial).toMatchObject({
      'workflow.启动模拟桩.username': 'tester@example.test',
      'workflow.启动模拟桩.password': 'secret-pass',
      'workflow.模拟充电.phoneNumbers': ['+6590000001', '+6590000002'],
      'workflow.模拟充电.verificationCode': '8888',
    })
    expect(JSON.stringify({ manifest: result.manifest, report: result.report })).not.toContain('secret-pass')
    expect(JSON.stringify(result)).not.toContain('secret-pass')
    expect(JSON.stringify(result)).not.toContain('+6590000001')
    expect(await readFile(filePath)).toBeInstanceOf(Buffer)
  })

  it('enforces container and size limits before workbook format detection', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-workflow-input-limit-'))
    temporaryDirectories.push(directory)
    const invalidPath = resolve(directory, 'invalid.xlsx')
    const oversizedPath = resolve(directory, 'oversized.xlsx')
    await writeFile(invalidPath, 'not a zip container')
    await writeFile(oversizedPath, 'PK')
    await truncate(oversizedPath, 25 * 1024 * 1024 + 1)

    await expect(intakeWorkflowXlsx({
      filePath: invalidPath,
      additionalUrls: ['https://app.example.test/'],
    })).rejects.toThrow(/XLSX\/ZIP/i)
    await expect(intakeWorkflowXlsx({
      filePath: oversizedPath,
      additionalUrls: ['https://app.example.test/'],
    })).rejects.toThrow(/25 MB/i)
  })

  it('parses WPS cell image relationship metadata', () => {
    const cellImagesXml = `<?xml version="1.0"?><etc:cellImages xmlns:etc="urn:etc" xmlns:xdr="urn:xdr" xmlns:a="urn:a" xmlns:r="urn:r"><etc:cellImage><xdr:pic><xdr:nvPicPr><xdr:cNvPr name="ID_IMAGE_1"/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill></xdr:pic></etc:cellImage></etc:cellImages>`
    const relationshipsXml = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="media/image1.png"/></Relationships>`

    expect(parseWpsCellImageIndex(cellImagesXml, relationshipsXml)).toEqual([
      { formulaId: 'ID_IMAGE_1', target: 'media/image1.png' },
    ])
  })
})
