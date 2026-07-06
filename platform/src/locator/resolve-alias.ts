import type { Page } from 'playwright'
import { getAliasByUrl, ensurePageObject, upsertAlias } from './page-object.js'
import { aiLocate } from './ai-locate.js'
import { LocatorSchema, type Locator } from '../browser/locator.js'

/**
 * 元素定位层 — 高层解析入口(§8.2 解析流程)。
 * 供集成者在 browser/tools.ts 的 browser_locate 工具中调用;
 * browser/locator.ts 的 alias 分支也应调 getAliasByUrl。
 *
 * 策略:
 *   1. 别名词典命中 → 直接返回(最快最稳)。
 *   2. 未命中 → AI 语义定位兜底,成功后回写别名词典(自学习)。
 */

/**
 * 解析别名/中文元素描述为 Playwright 定位器。
 * @param page   当前 Playwright Page(用于取 ARIA 快照做 AI 兜底)
 * @param alias  中文元素描述,如 "【登录】按钮" / "用户名输入框"
 * @param url    当前页面 URL(用于匹配 page_object.url_pattern)
 * @returns locator 结构化定位器;source 'alias'(词典命中)或 'ai'(AI 兜底)
 */
export async function resolveAliasOrAi(
  page: Page,
  alias: string,
  url: string,
): Promise<{ locator: Locator; source: 'alias' | 'ai' }> {
  // 1. 别名词典:命中即用
  const row = getAliasByUrl(url, alias)
  if (row && row.locator) {
    const parsed = LocatorSchema.safeParse(JSON.parse(row.locator))
    if (parsed.success) {
      return { locator: parsed.data, source: 'alias' }
    }
    // 存储的 locator 损坏 → 落到 AI 兜底重新定位
  }

  // 2. AI 语义定位兜底
  const { locator } = await aiLocate(page, alias)

  // 3. 自学习回写别名词典
  const pageObjectId = ensurePageObject(url)
  upsertAlias(pageObjectId, alias, JSON.stringify(locator), locator.type, 'auto-learned')

  return { locator, source: 'ai' }
}
