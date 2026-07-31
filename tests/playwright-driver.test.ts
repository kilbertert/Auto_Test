import { chromium, type Browser } from '@playwright/test'
import { afterEach, describe, expect, it } from 'vitest'
import { PlaywrightWorkflowPageSession } from '../src/workflow/playwright-driver.js'

let browser: Browser | undefined

afterEach(async () => {
  await browser?.close()
  browser = undefined
})

function target() {
  return {
    id: 'fixture',
    baseUrl: 'about:blank',
    allowedOrigins: ['about:blank'],
  }
}

const captchaSolver = { name: 'fixture', solve: async () => '0000' }

describe('Playwright workflow driver', () => {
  it('opens an Element UI select when the readonly input itself does not trigger it', async () => {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.setContent(`
      <div class="el-select">
        <div class="el-input__wrapper"><input readonly placeholder="Choose type"></div>
        <div class="el-select-dropdown" style="display:none"><div role="option">Cloud 1.6</div></div>
      </div>
      <script>
        const select = document.querySelector('.el-select')
        const popup = document.querySelector('.el-select-dropdown')
        select.addEventListener('click', (event) => {
          if (event.target.matches('input')) return
          popup.style.display = 'block'
        })
      </script>
    `)
    const session = new PlaywrightWorkflowPageSession(page, target(), captchaSolver)

    await session.click({ strategy: 'placeholder', value: 'Choose type', source: 'playwrightCli' })

    expect(await page.getByRole('option', { name: 'Cloud 1.6', exact: true }).isVisible()).toBe(true)
  })

  it('selects an option from the recovered Element UI popup', async () => {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.setContent(`
      <div class="el-select">
        <div class="el-input__wrapper"><input readonly placeholder="Choose type"></div>
        <div class="el-select-dropdown" style="display:none"><div role="option">Cloud 1.6</div></div>
      </div>
      <script>
        const select = document.querySelector('.el-select')
        const popup = document.querySelector('.el-select-dropdown')
        select.addEventListener('click', (event) => {
          if (event.target.matches('input')) return
          popup.style.display = 'block'
        })
        document.querySelector('[role="option"]').addEventListener('click', () => {
          document.querySelector('input').value = 'Cloud 1.6'
          popup.style.display = 'none'
        })
      </script>
    `)
    const session = new PlaywrightWorkflowPageSession(page, target(), captchaSolver)

    await session.select({ strategy: 'placeholder', value: 'Choose type', source: 'playwrightCli' }, 'Cloud 1.6')

    expect(await page.locator('input').inputValue()).toBe('Cloud 1.6')
  })

  it('does not inspect a normal button after it navigates the page', async () => {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.setContent('<button onclick="location.href=\'about:blank#home\'">Login</button>')
    const session = new PlaywrightWorkflowPageSession(page, target(), captchaSolver)

    await session.click({ strategy: 'role', value: 'button', name: 'Login', exact: true, source: 'playwrightCli' })

    expect(await page.url()).toBe('about:blank#home')
  })

  it('confirms a visible Element UI dialog opened by an aligned destructive action', async () => {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.setContent(`
      <table>
        <thead><tr><th>Device Code</th><th>Status</th></tr></thead>
        <tbody><tr id="device-row"><td>DEVICE-1</td><td>offline</td></tr></tbody>
      </table>
      <table>
        <thead><tr><th>Operation</th></tr></thead>
        <tbody><tr><td><button id="delete">Delete</button></td></tr></tbody>
      </table>
      <div class="el-message-box" role="dialog" style="display:none">
        <p>Delete this device?</p>
        <button id="confirm">Confirm</button>
      </div>
      <script>
        document.querySelector('#delete').addEventListener('click', () => {
          document.querySelector('.el-message-box').style.display = 'block'
        })
        document.querySelector('#confirm').addEventListener('click', () => {
          document.querySelector('#device-row').remove()
          document.querySelector('.el-message-box').style.display = 'none'
        })
      </script>
    `)
    const session = new PlaywrightWorkflowPageSession(page, target(), captchaSolver)

    await session.clickAlignedTableAction({
      dataTable: { headerLabels: ['Device Code', 'Status'], bodyOffset: 0, region: 'main' },
      actionTable: { headerLabels: ['Operation'], bodyOffset: 0, region: 'main' },
      entityId: 'DEVICE-1',
      actionNames: ['Delete'],
    })

    expect(await page.locator('#device-row').count()).toBe(0)
    expect(await page.locator('.el-message-box').isVisible()).toBe(false)
  }, 15_000)

  it('maps a canonical delete action to a localized table button', async () => {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.setContent(`
      <table>
        <thead><tr><th>设备编码</th><th>设备状态</th></tr></thead>
        <tbody><tr id="device-row"><td>20260713000001</td><td>离线</td></tr></tbody>
      </table>
      <table>
        <thead><tr><th>操作</th></tr></thead>
        <tbody><tr><td><button id="delete">删除</button></td></tr></tbody>
      </table>
      <div class="el-message-box" role="dialog" style="display:none">
        <p>确认删除？</p>
        <button id="confirm">确定</button>
      </div>
      <script>
        document.querySelector('#delete').addEventListener('click', () => {
          document.querySelector('.el-message-box').style.display = 'block'
        })
        document.querySelector('#confirm').addEventListener('click', () => {
          document.querySelector('#device-row').remove()
          document.querySelector('.el-message-box').style.display = 'none'
        })
      </script>
    `)
    const session = new PlaywrightWorkflowPageSession(page, target(), captchaSolver)

    await session.clickAlignedTableAction({
      dataTable: { headerLabels: ['设备编码', '设备状态'], bodyOffset: 0, region: 'main' },
      actionTable: { headerLabels: ['操作'], bodyOffset: 0, region: 'main' },
      entityId: '20260713000001',
      actionNames: ['delete'],
    })

    expect(await page.locator('#device-row').count()).toBe(0)
    expect(await page.locator('.el-message-box').isVisible()).toBe(false)
  }, 15_000)
})
