import { z } from 'zod'
import { defineTool } from '@open-multi-agent/core'
import type { ToolDefinition, ToolUseContext } from '@open-multi-agent/core'
import { resolveLocator, LocatorSchema, type Locator } from './locator.js'
import type { BrowserSession } from './pool.js'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveAliasOrAi } from '../locator/resolve-alias.js'

/**
 * 为一次 run 的 BrowserSession 生成 8 个浏览器工具(defineTool)。
 * 工具通过闭包持有 session.page,agent 调用时直接操作该 page。
 * 返回 ToolDefinition<any>[],可直接作为 AgentConfig.customTools。
 */
export function makeBrowserTools(session: BrowserSession): ToolDefinition<any>[] {
  const { page } = session

  const navigate = defineTool({
    name: 'browser_navigate',
    description: '导航到指定 URL,返回当前页面 URL 与标题。',
    inputSchema: z.object({
      url: z.string().url(),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
    }),
    execute: async ({ url, waitUntil }) => {
      await page.goto(url, { waitUntil: waitUntil ?? 'domcontentloaded' })
      return { data: JSON.stringify({ url: page.url(), title: await page.title() }) }
    },
  })

  const click = defineTool({
    name: 'browser_click',
    description: '点击元素。locator 指定定位方式(css/xpath/role/text)。',
    inputSchema: z.object({ locator: LocatorSchema }),
    execute: async ({ locator }) => {
      try {
        await resolveLocator(page, locator as Locator).click({ timeout: 10000 })
        return { data: JSON.stringify({ clicked: true }) }
      } catch (e) {
        return { data: String((e as Error).message), isError: true }
      }
    },
  })

  const typeTool = defineTool({
    name: 'browser_type',
    description: '在输入框填入文本。clear 默认 true(先清空)。',
    inputSchema: z.object({
      locator: LocatorSchema,
      text: z.string(),
      clear: z.boolean().optional(),
    }),
    execute: async ({ locator, text, clear }) => {
      try {
        const el = resolveLocator(page, locator as Locator)
        if (clear !== false) await el.fill('')
        await el.fill(text)
        return { data: JSON.stringify({ filled: true }) }
      } catch (e) {
        return { data: String((e as Error).message), isError: true }
      }
    },
  })

  const assertTool = defineTool({
    name: 'browser_assert',
    description: '断言。kind: text(元素文本含 expected)/visible/hidden/url/title。返回 {pass,actual,expected}。失败不抛,返回 isError 供上层判定。',
    inputSchema: z.object({
      kind: z.enum(['text', 'visible', 'hidden', 'url', 'title']),
      locator: LocatorSchema.optional(),
      expected: z.string().optional(),
      timeout: z.number().optional(),
    }),
    execute: async ({ kind, locator, expected, timeout }) => {
      try {
        if (kind === 'url') {
          const actual = page.url()
          return { data: JSON.stringify({ pass: actual.includes(expected ?? ''), actual, expected }) }
        }
        if (kind === 'title') {
          const actual = await page.title()
          return { data: JSON.stringify({ pass: actual.includes(expected ?? ''), actual, expected }) }
        }
        if (!locator) return { data: 'assert ' + kind + ' 需要 locator', isError: true }
        const el = resolveLocator(page, locator as Locator)
        if (kind === 'visible') {
          const visible = await el.isVisible()
          return { data: JSON.stringify({ pass: visible, actual: String(visible), expected: expected ?? 'true' }) }
        }
        if (kind === 'hidden') {
          const hidden = await el.isHidden()
          return { data: JSON.stringify({ pass: hidden, actual: String(hidden), expected: expected ?? 'true' }) }
        }
        const actual = (await el.textContent({ timeout: timeout ?? 10000 })) ?? ''
        return { data: JSON.stringify({ pass: actual.includes(expected ?? ''), actual, expected }) }
      } catch (e) {
        return { data: JSON.stringify({ pass: false, error: String((e as Error).message), expected }), isError: true }
      }
    },
  })

  const screenshot = defineTool({
    name: 'browser_screenshot',
    description: '截屏并保存到 screenshots/<runId>/ 下,返回相对路径。',
    inputSchema: z.object({ fullPage: z.boolean().optional() }),
    execute: async ({ fullPage }) => {
      const dir = join('screenshots', session.runId)
      await mkdir(dir, { recursive: true })
      const file = join(dir, 'step-' + Date.now() + '.png')
      await page.screenshot({ path: file, fullPage: fullPage ?? false })
      return { data: JSON.stringify({ path: file }) }
    },
  })

  const snapshot = defineTool({
    name: 'browser_snapshot',
    description: '返回页面 ARIA 快照(accessibility tree 字符串),供定位参考。',
    inputSchema: z.object({}),
    execute: async () => {
      const snap = await page.locator('body').ariaSnapshot()
      return { data: snap }
    },
  })

  const selectTool = defineTool({
    name: 'browser_select',
    description: '下拉选择:在下拉框选择值(value 或可见文本)。',
    inputSchema: z.object({ locator: LocatorSchema, value: z.string() }),
    execute: async ({ locator, value }) => {
      try {
        await resolveLocator(page, locator as Locator).selectOption(value)
        return { data: JSON.stringify({ selected: true }) }
      } catch (e) {
        return { data: String((e as Error).message), isError: true }
      }
    },
  })

  const locate = defineTool({
    name: 'browser_locate',
    description: 'AI 语义定位:给定中文元素描述(如"登录按钮"),返回定位器。别名优先,AI 兜底,成功回写别名词典。用于 locator 无法直接解析或元素难定位时。',
    inputSchema: z.object({ description: z.string() }),
    execute: async ({ description }) => {
      try {
        const { locator, source } = await resolveAliasOrAi(page, description, page.url())
        return { data: JSON.stringify({ locator, source }) }
      } catch (e) {
        return { data: String((e as Error).message), isError: true }
      }
    },
  })

  return [navigate, click, typeTool, selectTool, assertTool, screenshot, snapshot, locate]
}

/** smoke 模式直接调用工具 execute 时使用的最小 ToolUseContext。 */
export function smokeContext(): ToolUseContext {
  return { agent: { name: 'smoke', role: 'smoke', model: 'smoke' } } as ToolUseContext
}
