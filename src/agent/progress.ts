import { normalizeAgentEvent, type AgentEvent } from './host.js'

export type CodexTestAgentProgressKind = 'stage' | 'activity' | 'heartbeat' | 'warning'

export type AgentProgressActionPhase = 'started' | 'completed' | 'failed'
export type AgentProgressActionCategory = 'browser' | 'control' | 'shell' | 'workspace' | 'tool'

/** Safe, non-content description of the operation currently visible to a user. */
export interface AgentProgressAction {
  phase: AgentProgressActionPhase
  category: AgentProgressActionCategory
  label: string
  server?: string
  tool?: string
  sequence?: number
  durationMs?: number
}

export interface AgentTestProgressContext {
  hostId?: string
  epochIndex?: number
  epochTotal?: number
  threadGeneration?: number
}

export interface CodexTestAgentProgress {
  kind: CodexTestAgentProgressKind
  message: string
  context?: AgentTestProgressContext
  action?: AgentProgressAction
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

function safeIdentityPart(value: string | undefined): string | undefined {
  if (!value) return undefined
  const sanitized = value.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 48)
  return sanitized || undefined
}

function actionIdentity(identity: { server: string; tool: string }): { server?: string; tool?: string; suffix: string } {
  const server = safeIdentityPart(identity.server)
  const tool = safeIdentityPart(identity.tool)
  const name = [server, tool].filter(Boolean).join('.')
  return { ...(server ? { server } : {}), ...(tool ? { tool } : {}), suffix: name ? ` [${name}]` : '' }
}

function actionCategory(server: string, tool: string): AgentProgressActionCategory {
  if (server === 'playwright') return 'browser'
  if (server === 'auto-test-control') return 'control'
  if (tool === 'command_execution') return 'shell'
  if (tool === 'file_change') return 'workspace'
  return 'tool'
}

function actionProgress(
  event: AgentEvent,
  label: string,
  identity: { server: string; tool: string },
): CodexTestAgentProgress {
  let phase: AgentProgressActionPhase
  if (event.status === 'failed') phase = 'failed'
  else if (event.type.endsWith('_started')) phase = 'started'
  else phase = 'completed'
  const safe = actionIdentity(identity)
  const suffix = safe.suffix
  let message: string
  if (phase === 'started') message = `正在${label}${suffix}`
  else if (phase === 'failed') message = `${label}返回失败，测试代理正在分析并尝试恢复${suffix}`
  else message = `${label}已完成${suffix}`
  const action: AgentProgressAction = {
    phase,
    category: actionCategory(identity.server, identity.tool),
    label,
    ...(safe.server ? { server: safe.server } : {}),
    ...(safe.tool ? { tool: safe.tool } : {}),
  }
  return { kind: phase === 'failed' ? 'warning' : 'activity', message, action }
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
    const message = event.message ?? ''
    if (/quota|rate\s*limit|余额|额度|credit/i.test(message)) {
      return { kind: 'warning', message: '模型额度或请求频率受限，AgentHost 正在尝试恢复' }
    }
    if (/timeout|timed\s*out|超时/i.test(message)) {
      return { kind: 'warning', message: 'AgentHost 请求超时，测试代理正在分析并尝试恢复' }
    }
    return { kind: 'warning', message: 'AgentHost 返回通信错误，测试代理正在分析并尝试恢复' }
  }
  if (event.type === 'turn_failed') {
    return { kind: 'warning', message: 'AgentHost 本轮执行失败，正在保存可恢复状态' }
  }
  if (event.type === 'session_incompatible') {
    return { kind: 'warning', message: '原 AgentHost 会话与当前模型绑定不兼容，正在启动恢复线程' }
  }
  if (event.type === 'tool_started' || event.type === 'tool_completed') {
    const identity = normalizedToolIdentity(event.server, event.tool)
    return actionProgress(event, toolLabel(identity.server, identity.tool), identity)
  }
  if (event.type === 'command_started' || event.type === 'command_completed') {
    return actionProgress(event, '运行测试辅助命令或脚本', { server: '', tool: 'command_execution' })
  }
  if (event.type === 'file_change_started' || event.type === 'file_change_completed') {
    return actionProgress(event, '更新本次运行工作区文件', { server: '', tool: 'file_change' })
  }
  if (event.type === 'reasoning_started') {
    return { kind: 'activity', message: '测试代理正在分析当前证据和下一步动作（不显示模型推理正文）' }
  }
  if (event.type === 'todo_started') {
    return { kind: 'activity', message: '测试代理正在整理当前执行步骤清单' }
  }
  if (event.type === 'agent_message') {
    return { kind: 'activity', message: '测试代理已生成本轮执行回执' }
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

function hostLabel(hostId: string | undefined): string | undefined {
  if (!hostId) return undefined
  if (hostId.toLowerCase() === 'codex') return 'Codex'
  if (hostId.toLowerCase() === 'omp') return 'OMP'
  return safeIdentityPart(hostId)
}

function contextPrefix(context: AgentTestProgressContext): string {
  const parts: string[] = []
  const host = hostLabel(context.hostId)
  if (host) parts.push(`Host=${host}`)
  if (context.epochIndex !== undefined && context.epochTotal !== undefined) {
    parts.push(`epoch=${context.epochIndex}/${context.epochTotal}`)
  }
  if (context.threadGeneration !== undefined) parts.push(`thread generation=${context.threadGeneration}`)
  return parts.length > 0 ? `[${parts.join(' | ')}] ` : ''
}

function actionDescription(action: AgentProgressAction): string {
  const name = [action.server, action.tool].filter(Boolean).join('.')
  return `${action.label}${name ? ` [${name}]` : ''}`
}

interface ActiveAction {
  action: AgentProgressAction
  sequence: number
  startedAt: number
}

export class CodexTestProgressReporter {
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private currentActivity = '正在准备测试代理'
  private currentAction: AgentProgressAction | undefined
  private readonly activeActions = new Map<string, ActiveAction>()
  private readonly recentEventKeys = new Map<string, number>()
  private actionSequence = 0
  private recoveryActive = false
  private context: AgentTestProgressContext = {}
  private readonly startedAt = Date.now()

  constructor(
    private readonly sink?: CodexTestAgentProgressSink,
    private readonly heartbeatIntervalMs = 20_000,
  ) {}

  setContext(context: AgentTestProgressContext): void {
    this.context = { ...this.context, ...context }
  }

  report(kind: CodexTestAgentProgressKind, message: string): void {
    this.currentActivity = message
    if (kind === 'warning') this.recoveryActive = true
    this.emit({ kind, message })
  }

  private emit(progress: CodexTestAgentProgress): void {
    const context = Object.keys(this.context).length > 0 ? { ...this.context } : undefined
    const message = `${contextPrefix(this.context)}${progress.message}`
    try {
      this.sink?.({
        ...progress,
        message,
        ...(context ? { context } : {}),
      })
    } catch {
      // Progress reporting must never affect the test result.
    }
  }

  observe(event: AgentEvent | unknown): void {
    const progress = progressFromAgentEvent(event)
    if (!progress) return
    const normalized = normalizeAgentEvent(event)
    const enriched = progress.action ? this.enrichAction(progress, normalized) : progress
    if (!enriched) return
    this.currentActivity = enriched.message
    this.currentAction = enriched.action
    if (enriched.kind === 'warning') this.recoveryActive = true
    if (enriched.action?.phase === 'completed') this.recoveryActive = false
    this.emit(enriched)
  }

  // Correlate lifecycle events by call ID without retaining tool arguments or results.
  private enrichAction(progress: CodexTestAgentProgress, event: AgentEvent): CodexTestAgentProgress | undefined {
    const action = progress.action
    if (!action) return progress
    const correlationId = event.callId ?? event.id
    const key = correlationId ? `${action.category}|${action.server ?? ''}|${action.tool ?? ''}|${correlationId}` : undefined
    const now = Date.now()
    if (key) {
      const eventKey = `${event.type}|${key}`
      if (this.recentEventKeys.has(eventKey)) return undefined
      this.recentEventKeys.set(eventKey, now)
      for (const [candidate, timestamp] of this.recentEventKeys) {
        if (now - timestamp > 60_000) this.recentEventKeys.delete(candidate)
      }
    }
    const started = key ? this.activeActions.get(key) : undefined
    const sequence = started?.sequence ?? ++this.actionSequence
    let durationMs: number | undefined
    if (action.phase !== 'started' && started) durationMs = Math.max(0, now - started.startedAt)
    if (action.phase === 'started') {
      if (key) this.activeActions.set(key, { action, sequence, startedAt: now })
    } else if (key) {
      this.activeActions.delete(key)
    }
    const enrichedAction: AgentProgressAction = {
      ...action,
      sequence,
      ...(durationMs !== undefined ? { durationMs } : {}),
    }
    let status: string
    if (action.phase === 'started') status = '进行中'
    else if (action.phase === 'failed') status = '失败'
    else status = '完成'
    const duration = durationMs === undefined ? '' : `，耗时 ${elapsedLabel(durationMs)}`
    return {
      ...progress,
      action: enrichedAction,
      message: `${progress.message}；动作 #${sequence}，状态=${status}${duration}`,
    }
  }

  private latestActiveAction(): ActiveAction | undefined {
    let latest: ActiveAction | undefined
    for (const action of this.activeActions.values()) {
      if (!latest || action.startedAt > latest.startedAt) latest = action
    }
    return latest
  }

  startHeartbeat(): void {
    if (!this.sink || this.heartbeat || this.heartbeatIntervalMs <= 0) return
    this.heartbeat = setInterval(() => {
      const elapsed = elapsedLabel(Date.now() - this.startedAt)
      const active = this.latestActiveAction()
      const activity = active
        ? `当前动作：${actionDescription(active.action)}；动作 #${active.sequence}，状态=进行中，已持续 ${elapsedLabel(Date.now() - active.startedAt)}`
        : `最近动作：${this.currentActivity}`
      const recovery = this.recoveryActive ? '；恢复状态：进行中' : ''
      try {
        this.sink?.({
          kind: 'heartbeat',
          message: `${contextPrefix(this.context)}框架仍在运行（已持续 ${elapsed}）；${activity}${recovery}`,
          ...(Object.keys(this.context).length > 0 ? { context: { ...this.context } } : {}),
          ...(active ? {
            action: {
              ...active.action,
              phase: 'started' as const,
              sequence: active.sequence,
              durationMs: Math.max(0, Date.now() - active.startedAt),
            },
          } : this.currentAction ? { action: this.currentAction } : {}),
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
    this.activeActions.clear()
    this.recentEventKeys.clear()
  }
}

/** Host-neutral name; the historical Codex export remains compatible. */
export class AgentTestProgressReporter extends CodexTestProgressReporter {}
