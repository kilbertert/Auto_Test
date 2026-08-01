import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { utils, write } from '@e965/xlsx'
import { afterEach, describe, expect, it } from 'vitest'
import { preflightEasyWorkflow } from '../src/usability/workflow-preflight.js'

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
    expect(result.discoveredOrigins).toEqual(['https://h5.example.test'])
  })
})
