import { z } from 'zod'
import type { Page, Locator as PwLocator } from 'playwright'

/**
 * 统一元素定位 schema。
 * - css / xpath / role / text:直接映射 Playwright locator(P0 实现)
 * - alias:中文元素描述 → 别名词典(P3 实现,P0 抛错)
 * - ref:accessibility 快照编号(P6 AI 探索实现,P0 抛错)
 */
export const LocatorSchema = z.object({
  type: z.enum(['alias', 'css', 'xpath', 'role', 'text', 'ref']),
  value: z.string(),
  role: z.string().optional(),
  name: z.string().optional(),
})

export type Locator = z.infer<typeof LocatorSchema>

/** 把统一 Locator 解析为 Playwright Locator。 */
export function resolveLocator(page: Page, loc: Locator): PwLocator {
  switch (loc.type) {
    case 'css':
      return page.locator(loc.value)
    case 'xpath':
      return page.locator('xpath=' + loc.value)
    case 'role':
      return page.getByRole(
        loc.value as Parameters<Page['getByRole']>[0],
        loc.name ? { name: loc.name } : undefined,
      )
    case 'text':
      return page.getByText(loc.value)
    case 'ref':
      throw new Error('locator type "ref" 未在 P0 实现(见 P3/P6 accessibility 快照映射)')
    case 'alias':
      throw new Error('locator type "alias" 需要 P3 别名词典,当前不可用')
    default: {
      const _exhaustive: never = loc.type
      throw new Error('未知 locator type: ' + _exhaustive)
    }
  }
}
