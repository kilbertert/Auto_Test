import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { config } from '../config.js'

export interface BrowserSession {
  runId: string
  context: BrowserContext
  page: Page
}

/**
 * 浏览器池,两种模式:
 * - CDP 模式(设置 BROWSER_CDP_URL):connectOverCDP 连接用户已登录的浏览器,
 *   复用其登录态(绕过验证码/登录)。close() 不关闭用户浏览器,仅断开引用。
 * - launch 模式(默认):chromium.launch 全新浏览器,按 size 并发新建 context。
 */
class BrowserPool {
  private browser: Browser | null = null
  private sharedContext: BrowserContext | null = null
  private inUse = 0
  private waiters: Array<() => void> = []
  private readonly size: number

  constructor(size: number) {
    this.size = Math.max(1, size)
  }

  get cdpUrl(): string | undefined {
    return process.env.BROWSER_CDP_URL
  }

  /** 幂等初始化。 */
  async init(): Promise<void> {
    if (this.browser) return
    const cdp = this.cdpUrl
    if (cdp) {
      // CDP 连接:超时 60s + 重试一次(应对 Edge 偶发慢响应/累积标签)
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          this.browser = await chromium.connectOverCDP(cdp, { timeout: 60000 })
          break
        } catch (e) {
          if (attempt === 1) throw e
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
      if (!this.browser) throw new Error('CDP connect failed')
      const ctxs = this.browser.contexts()
      this.sharedContext = ctxs[0] ?? (await this.browser.newContext({ ignoreHTTPSErrors: true }))
    } else {
      this.browser = await chromium.launch({ headless: config.browserHeadless })
    }
  }

  async acquire(runId: string): Promise<BrowserSession> {
    if (!this.browser) await this.init()
    if (this.inUse >= this.size) {
      await new Promise<void>(resolve => this.waiters.push(resolve))
    }
    this.inUse++
    const context = this.sharedContext
      ? this.sharedContext
      : await this.browser!.newContext({ ignoreHTTPSErrors: true })
    const page = await context.newPage()
    return { runId, context, page }
  }

  release(session: BrowserSession): void {
    void session.page.close().catch(() => {})
    // launch 模式:关闭临时 context;CDP 模式:保留 sharedContext(用户登录态)
    if (!this.sharedContext) {
      void session.context.close().catch(() => {})
    }
    this.inUse--
    const next = this.waiters.shift()
    if (next) next()
  }

  async close(): Promise<void> {
    if (this.browser) {
      // CDP 模式不调用 close(),避免关闭用户的 Chrome;进程退出时连接自然断开
      if (!this.cdpUrl) {
        await this.browser.close().catch(() => {})
      }
      this.browser = null
      this.sharedContext = null
    }
  }
}

export const browserPool = new BrowserPool(config.BROWSER_POOL_SIZE)
