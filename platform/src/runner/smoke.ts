import { browserPool } from '../browser/pool.js'
import { makeBrowserTools, smokeContext } from '../browser/tools.js'
import { loginCase } from '../cases/login.case.js'
import type { ToolDefinition } from '@open-multi-agent/core'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

type AnyTool = ToolDefinition<any>
type ProgressFn = (msg: { type: string; text: string }) => void

/**
 * Smoke 模式:无 LLM,直接顺序调用浏览器工具执行登录用例,
 * 验证 Playwright + Locator + 工具链可用。可经 onProgress 推送到 WS。
 */
export async function runSmoke(runId = 'smoke', onProgress?: ProgressFn): Promise<void> {
  await browserPool.init()
  const session = await browserPool.acquire(runId)
  const tools = makeBrowserTools(session)
  const byName = new Map<string, AnyTool>(tools.map(t => [t.name, t]))
  const ctx = smokeContext()
  // smoke 不依赖 server:直接用 file:// 加载本地 fixture 登录页
  const fixtureUrl = pathToFileURL(join(process.cwd(), 'src/fixtures/login.html')).href
  const emit = (text: string): void => {
    console.log('[smoke] ' + text)
    onProgress?.({ type: 'smoke_step', text })
  }

  try {
    emit('初始化完成,执行登录步骤...')
    for (const step of loginCase.steps) {
      if (step.action === 'navigate') {
        const r = await byName.get('browser_navigate')!.execute({ url: fixtureUrl }, ctx)
        emit('navigate → ' + r.data)
      } else if (step.action === 'type') {
        const r = await byName.get('browser_type')!.execute({ locator: step.locator!, text: step.value! }, ctx)
        emit('type ' + step.targetDescription + ' → ' + r.data + (r.isError ? ' (ERR)' : ''))
      } else if (step.action === 'click') {
        const r = await byName.get('browser_click')!.execute({ locator: step.locator! }, ctx)
        emit('click ' + step.targetDescription + ' → ' + r.data + (r.isError ? ' (ERR)' : ''))
      }
    }
    for (const a of loginCase.assertions) {
      const r = await byName.get('browser_assert')!.execute(
        { kind: a.kind, locator: a.locator!, expected: a.expected },
        ctx,
      )
      const parsed = JSON.parse(r.data) as { pass: boolean; actual: string }
      emit(`assert ${a.kind} → pass=${parsed.pass} actual=${parsed.actual}`)
    }
    const shot = await byName.get('browser_screenshot')!.execute({ fullPage: true }, ctx)
    emit('截图: ' + (JSON.parse(shot.data) as { path: string }).path)
    emit('完成 ✓')
  } finally {
    browserPool.release(session)
  }
}

// CLI 入口:仅当直接执行本文件时运行
async function main(): Promise<void> {
  try {
    await runSmoke('smoke')
  } catch (e) {
    console.error('[smoke] 失败:', e)
    process.exitCode = 1
  } finally {
    await browserPool.close()
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main()
}
