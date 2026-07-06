import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { config } from '../config.js'

export interface BrowserSession {
  runId: string
  context: BrowserContext
  page: Page
}

/**
 * 浏览器上下文池:管理 N 个独立 BrowserContext(隔离 cookie/localStorage),
 * 与 maxConcurrency 对齐。修正 ai_uitest_agent "每种类型仅 1 实例"的缺陷。
 */
class BrowserPool {
  private browser: Browser | null = null
  private inUse = new Set<BrowserContext>()
  private waiters: Array<() => void> = []
  private readonly size: number

  constructor(size: number) {
    this.size = Math.max(1, size)
  }

  /** 幂等初始化。 */
  async init(): Promise<void> {
    if (this.browser) return
    this.browser = await chromium.launch({ headless: config.browserHeadless })
  }

  async acquire(runId: string): Promise<BrowserSession> {
    if (!this.browser) await this.init()
    let ctx = await this.nextFreeContext()
    this.inUse.add(ctx)
    const page = await ctx.newPage()
    return { runId, context: ctx, page }
  }

  release(session: BrowserSession): void {
    void session.page.close().catch(() => {})
    this.inUse.delete(session.context)
    const next = this.waiters.shift()
    if (next) next()
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {})
      this.browser = null
    }
  }

  private async nextFreeContext(): Promise<BrowserContext> {
    if (!this.browser) throw new Error('browser not initialized')
    // 优先复用当前 browser 的新 context(共享进程,隔离存储)
    if (this.inUse.size < this.size) {
      return this.browser.newContext()
    }
    // 达到并发上限,排队等待
    await new Promise<void>(resolve => this.waiters.push(resolve))
    return this.browser.newContext()
  }
}

export const browserPool = new BrowserPool(config.BROWSER_POOL_SIZE)
