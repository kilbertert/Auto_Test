/** 探测真实后台登录页结构(只读快照,不提交表单)。 */
import { chromium } from 'playwright'

const URL = process.env.TEST_LOGIN_URL ?? 'https://qushiyun.com/'

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await ctx.newPage()
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  console.log('title:', await page.title())
  console.log('url:', page.url())
  console.log('=== ARIA 快照(前 2500 字符) ===')
  const snap = await page.locator('body').ariaSnapshot()
  console.log(snap.slice(0, 2500))
  console.log('=== input 元素(name/type/placeholder) ===')
  const inputs = await page.$$eval('input', (els) =>
    els.map((e) => ({ name: (e as HTMLInputElement).name, type: (e as HTMLInputElement).type, placeholder: (e as HTMLInputElement).placeholder, id: e.id })),
  )
  console.log(JSON.stringify(inputs, null, 2))
  console.log('=== 按钮/链接文本 ===')
  const btns = await page.$$eval('button, [role=button], input[type=submit], a', (els) =>
    els.slice(0, 15).map((e) => (e.textContent || (e as HTMLInputElement).value || '').trim()).filter(Boolean),
  )
  console.log(JSON.stringify(btns))
  await browser.close()
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
