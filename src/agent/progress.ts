import { normalizeAgentEvent, type AgentEvent } from './host.js'

export type CodexTestAgentProgressKind = 'stage' | 'activity' | 'heartbeat' | 'warning'

export interface CodexTestAgentProgress {
  kind: CodexTestAgentProgressKind
  message: string
}

export type CodexTestAgentProgressSink = (progress: CodexTestAgentProgress) => void

export type AgentTestProgressKind = CodexTestAgentProgressKind
export type AgentTestProgress = CodexTestAgentProgress
export type AgentTestProgressSink = CodexTestAgentProgressSink

const browserToolLabels: Record<string, string> = {
  browser_navigate: '打开目标页面',
  browser_navigate_back: '返回上一页面',
  browser_navigate_forward: '前往下一页面',
  browser_reload: '刷新当前页面',
  browser_snapshot: '读取页面结构',
  browser_find: '查找页面控件',
  browser_click: '点击页面控件',
  browser_hover: '检查悬停内容',
  browser_fill_form: '填写页面表单',
  browser_type: '输入页面内容',
  browser_select_option: '选择页面选项',
  browser_check: '勾选页面选项',
  browser_uncheck: '取消勾选页面选项',
  browser_press_key: '发送键盘操作',
  browser_wait_for: '等待页面状态变化',
  browser_take_screenshot: '保存页面截图证据',
  browser_verify_element_visible: '验证页面元素',
  browser_verify_list_visible: '验证页面列表',
  browser_verify_text_visible: '验证页面文字',
  browser_verify_value: '验证页面字段值',
  browser_network_request: '检查页面网络请求',
  browser_network_requests: '检查页面网络请求',
  browser_evaluate: '执行页面 JavaScript 检查',
  browser_run_code_unsafe: '执行 Playwright 辅助代码',
  browser_generate_locator: '生成页面定位器',
  browser_annotate: '标注页面证据',
  browser_highlight: '高亮页面元素',
  browser_hide_highlight: '移除页面高亮',
  browser_console_messages: '检查页面控制台',
  browser_tabs: '管理浏览器标签页',
  browser_handle_dialog: '处理页面弹窗',
  browser_drag: '拖动页面元素',
  browser_drop: '放置页面元素',
  browser_file_upload: '上传测试文件',
  browser_cookie_clear: '清理浏览器 Cookie',
  browser_localstorage_clear: '清理页面本地缓存',
  browser_sessionstorage_clear: '清理页面会话缓存',
  browser_set_storage_state: '恢复已注册的登录状态',
  browser_close: '关闭浏览器会话',
}

const controlToolLabels: Record<string, string> = {
  test_contract: '读取不可变测试契约',
  test_value_get: '读取本次运行测试数据',
  test_plan_update: '更新动态 Execution Plan',
  evidence_record: '记录测试证据',
  field_composition_check: '校验复合字段输入表示',
  field_composition_list: '核对复合字段输入门禁',
  case_result_record: '记录测试用例终态',
  mutation_begin: '登记业务写入到 Mutation Ledger',
  mutation_resolve: '核销业务写入和清理结果',
  mutation_list: '核对未完成的业务写入',
}

function toolLabel(server: string, tool: string): string {
  if (server === 'playwright') return browserToolLabels[tool] ?? '执行受控浏览器动作'
  if (server === 'auto-test-control') return controlToolLabels[tool] ?? '更新测试交付记录'
  if (tool === 'web_search') return '检索测试所需的外部资料'
  return '调用受控测试工具'
}

function normalizedToolIdentity(server: string | undefined, tool: string | undefined): { server: string; tool: string } {
  if (server) return { server, tool: tool ?? '' }
  const value = tool ?? ''
  const browser = Object.keys(browserToolLabels).find((name) => value === name || value.endsWith(`_${name}`))
  if (browser) return { server: 'playwright', tool: browser }
  const control = Object.keys(controlToolLabels).find((name) => value === name || value.endsWith(`_${name}`))
  if (control) return { server: 'auto-test-control', tool: control }
  return { server: '', tool: value }
}

export function progressFromAgentEvent(value: unknown): CodexTestAgentProgress | undefined {
  const event = normalizeAgentEvent(value)
  if (event.type === 'thread_started') {
    return { kind: 'stage', message: 'AgentHost 测试线程已建立；中断后可以从本次结果目录恢复' }
  }
  if (event.type === 'turn_started') {
    return { kind: 'stage', message: '测试代理正在理解测试用例、页面证据和下一步动作' }
  }
  if (event.type === 'turn_completed') {
    return { kind: 'stage', message: '测试代理本轮执行结束，正在核对结构化交付是否完整' }
  }
  if (event.type === 'error') {
    const reconnect = /^Reconnecting\.\.\.\s*(\d+\/\d+)/i.exec(event.message ?? '')
    if (reconnect) return { kind: 'warning', message: `模型连接暂时中断，AgentHost 正在自动重连（${reconnect[1]}）` }
    return undefined
  }
  if (event.type === 'tool_started' || event.type === 'tool_completed') {
    const identity = normalizedToolIdentity(event.server, event.tool)
    const label = toolLabel(identity.server, identity.tool)
    if (event.type === 'tool_started') return { kind: 'activity', message: `正在${label}` }
    if (event.status === 'failed') return { kind: 'warning', message: `${label}返回失败，测试代理正在分析并尝试恢复` }
    return { kind: 'activity', message: `${label}已完成` }
  }
  if (event.type === 'command_started' || event.type === 'command_completed') {
    if (event.type === 'command_started') return { kind: 'activity', message: '测试代理正在运行测试辅助命令或脚本' }
    if (event.status === 'failed') return { kind: 'warning', message: '测试辅助命令执行失败，测试代理正在分析并恢复' }
    return { kind: 'activity', message: '测试辅助命令或脚本已完成' }
  }
  if (event.type === 'file_change_started' || event.type === 'file_change_completed') {
    if (event.type === 'file_change_started') return { kind: 'activity', message: '测试代理正在更新本次运行的临时脚本或记录' }
    if (event.status === 'failed') return { kind: 'warning', message: '本次运行工作区文件更新失败，测试代理正在恢复' }
    return { kind: 'activity', message: '本次运行的临时脚本或记录已更新' }
  }
  if (event.type === 'reasoning_started') {
    return { kind: 'activity', message: '测试代理正在分析当前证据和下一步动作' }
  }
  if (event.type === 'todo_started') {
    return { kind: 'activity', message: '测试代理正在整理当前执行步骤' }
  }
  if (event.type === 'agent_message') {
    return { kind: 'activity', message: '测试代理已完成本轮执行说明' }
  }
  return undefined
}

/** Backward-compatible name retained for integrations that imported the old helper. */
export function progressFromThreadEvent(event: unknown): CodexTestAgentProgress | undefined {
  return progressFromAgentEvent(event)
}

function elapsedLabel(milliseconds: number): string {
  const totalSeconds = Math.max(1, Math.floor(milliseconds / 1000))
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`
}

export class CodexTestProgressReporter {
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private currentActivity = '正在准备测试代理'
  private readonly startedAt = Date.now()

  constructor(
    private readonly sink?: CodexTestAgentProgressSink,
    private readonly heartbeatIntervalMs = 20_000,
  ) {}

  report(kind: CodexTestAgentProgressKind, message: string): void {
    this.currentActivity = message
    try {
      this.sink?.({ kind, message })
    } catch {
      // Progress reporting must never affect the test result.
    }
  }

  observe(event: AgentEvent | unknown): void {
    const progress = progressFromAgentEvent(event)
    if (progress) this.report(progress.kind, progress.message)
  }

  startHeartbeat(): void {
    if (!this.sink || this.heartbeat || this.heartbeatIntervalMs <= 0) return
    this.heartbeat = setInterval(() => {
      const elapsed = elapsedLabel(Date.now() - this.startedAt)
      try {
        this.sink?.({
          kind: 'heartbeat',
          message: `框架仍在运行（已持续 ${elapsed}）；最近进度：${this.currentActivity}`,
        })
      } catch {
        // Progress reporting must never affect the test result.
      }
    }, this.heartbeatIntervalMs)
    this.heartbeat.unref?.()
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }
}

/** Host-neutral name; the historical Codex export remains compatible. */
export class AgentTestProgressReporter extends CodexTestProgressReporter {}
