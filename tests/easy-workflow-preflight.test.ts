import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { utils, write } from '@e965/xlsx'
import { afterEach, describe, expect, it } from 'vitest'
import { policyForRisk, upsertEnvironmentProfile } from '../src/usability/environment-registration.js'
import { planEasyRegistration, preflightEasyWorkflow } from '../src/usability/workflow-preflight.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('easy workflow preflight', () => {
  it('merges URLs found in a workflow workbook before environment selection', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-preflight-'))
    temporaryDirectories.push(directory)
    const filePath = resolve(directory, 'charging-workflow.xlsx')
    const workbook = utils.book_new()
    const sheet = utils.aoa_to_sheet([
      ['启动模拟桩', '打开模拟桩后台并启动设备'],
      ['模拟充电', '打开 https://h5.example.test/login 并开始充电'],
    ])
    utils.book_append_sheet(workbook, sheet, 'Flow')
    await writeFile(filePath, write(workbook, { type: 'buffer', bookType: 'xlsx' }))

    const result = await preflightEasyWorkflow(filePath, [
      'https://admin.example.test/',
      'https://simulator.example.test/',
    ])

    expect(result.targetUrls).toEqual([
      'https://admin.example.test/',
      'https://simulator.example.test/',
      'https://h5.example.test/login',
    ])
    expect(result.materialOrigins).toEqual(['https://h5.example.test'])
  })
})

describe('easy registration plan', () => {
  it('rejects an empty environment URL set instead of inferring targets from Excel', async () => {
    const plan = await planEasyRegistration({ suppliedUrls: [], isTTY: true })
    expect(plan).toEqual({
      kind: 'error',
      message: expect.stringContaining('至少提供一个 --url'),
    })
  })

  it('does not require registration for origins merely discovered in the workbook', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-reg-scope-'))
    temporaryDirectories.push(directory)
    const filePath = resolve(directory, 'cases.xlsx')
    const workbook = utils.book_new()
    utils.book_append_sheet(
      workbook,
      utils.aoa_to_sheet([
        ['步骤', '说明'],
        ['登录后台', '打开 https://lta.example.test/ 并登录'],
        ['参考教程', '见 https://www.youtube.com/watch?v=example'],
      ]),
      'Flow',
    )
    await writeFile(filePath, write(workbook, { type: 'buffer', bookType: 'xlsx' }))

    const suppliedUrls = ['https://lta.example.test/']
    const preflight = await preflightEasyWorkflow(filePath, suppliedUrls)
    // preflight still surfaces the incidental YouTube origin as a notice
    expect(preflight.materialOrigins).toContain('https://www.youtube.com')

    const registryPath = resolve(directory, 'environment-profiles.json')
    await upsertEnvironmentProfile(
      {
        id: 'lta-staging',
        origins: ['https://lta.example.test'],
        auth: [],
        policy: policyForRisk('read'),
      },
      registryPath,
    )

    // The supplied target is covered; the discovered YouTube origin must NOT force registration.
    const plan = await planEasyRegistration({ suppliedUrls, isTTY: true, registryPath })
    expect(plan).toMatchObject({ kind: 'use', profileId: 'lta-staging' })
  })

  it('requests registration when no profile covers the supplied target (TTY)', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-reg-new-'))
    temporaryDirectories.push(directory)
    const registryPath = resolve(directory, 'environment-profiles.json')
    const plan = await planEasyRegistration({
      suppliedUrls: ['https://fresh.example.test/'],
      isTTY: true,
      registryPath,
    })
    expect(plan.kind).toBe('register')
    if (plan.kind === 'register') {
      expect(plan.registrationUrls).toEqual(['https://fresh.example.test/'])
      expect(plan.defaults).toEqual({})
    }
  })

  it('errors when no profile covers the supplied target and there is no TTY', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-reg-notty-'))
    temporaryDirectories.push(directory)
    const registryPath = resolve(directory, 'environment-profiles.json')
    const plan = await planEasyRegistration({
      suppliedUrls: ['https://fresh.example.test/'],
      isTTY: false,
      registryPath,
    })
    expect(plan.kind).toBe('error')
    if (plan.kind === 'error') expect(plan.message).toContain('尚未注册')
  })

  it('uses an explicitly requested profile when it covers the supplied target', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-reg-explicit-'))
    temporaryDirectories.push(directory)
    const registryPath = resolve(directory, 'environment-profiles.json')
    await upsertEnvironmentProfile(
      {
        id: 'lta-staging',
        origins: ['https://lta.example.test'],
        auth: [],
        policy: policyForRisk('read'),
      },
      registryPath,
    )
    const plan = await planEasyRegistration({
      suppliedUrls: ['https://lta.example.test/'],
      profileId: 'lta-staging',
      isTTY: true,
      registryPath,
    })
    expect(plan).toMatchObject({ kind: 'use', profileId: 'lta-staging' })
  })

  it('errors when an explicitly requested profile is missing', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'auto-test-easy-reg-missing-'))
    temporaryDirectories.push(directory)
    const registryPath = resolve(directory, 'environment-profiles.json')
    const plan = await planEasyRegistration({
      suppliedUrls: ['https://lta.example.test/'],
      profileId: 'does-not-exist',
      isTTY: true,
      registryPath,
    })
    expect(plan.kind).toBe('error')
  })
})
