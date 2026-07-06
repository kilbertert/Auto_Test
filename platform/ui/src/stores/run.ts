import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { runApi, runHistory, screenshotUrl } from '../api'
import type {
  RunMode,
  StartRunPayload,
  StartRunResponse,
  RunDetail,
  RunCase,
  RunRecord,
  WsMessage,
  WsCaseCompleteMessage,
  RunCaseStatus
} from '../types'

/** 一条渲染好的 WS 消息(用于日志流) */
export interface LogEntry {
  id: number
  raw: WsMessage
  text: string
  level: 'info' | 'success' | 'warning' | 'error' | 'dim'
  ts: number
}

const MAX_LOGS = 800

function formatMessage(msg: WsMessage): { text: string; level: LogEntry['level'] } {
  switch (msg.type) {
    case 'run_start':
      return { text: `-- run 开始${(msg as any).total ? `(共 ${(msg as any).total} 条)` : ''} --`, level: 'success' }
    case 'run_complete':
      return (msg as any).error
        ? { text: `-- run 失败: ${(msg as any).error} --`, level: 'error' }
        : { text: '-- run 完成 --', level: 'success' }
    case 'tasks_ready':
      return { text: `任务就绪: ${(msg as any).tasks?.map((t: any) => t.title).join(' → ')}`, level: 'info' }
    case 'case_start':
      return { text: `[用例开始] ${(msg as any).caseTitle ?? (msg as any).caseId}`, level: 'info' }
    case 'case_complete': {
      const m = msg as WsCaseCompleteMessage
      const ok = m.status === 'passed'
      return {
        text: `[用例完成] ${m.caseTitle ?? m.caseId} → ${m.status}${m.error ? ` (${m.error})` : ''}`,
        level: ok ? 'success' : 'error'
      }
    }
    case 'progress': {
      const ev = (msg as any).event
      return { text: `[progress] ${ev?.type ?? ''} agent=${ev?.agent ?? ''} task=${ev?.task ?? ''}`, level: 'info' }
    }
    case 'trace': {
      const ev = (msg as any).event
      return { text: `  trace ${ev?.type ?? ''} ${ev?.tool ?? ev?.model ?? ''}`, level: 'dim' }
    }
    case 'stream': {
      const ev = (msg as any).event
      const delta = ev?.delta ? ev.delta.slice(0, 200) : ''
      return { text: `  stream ${ev?.type ?? ''} (${(msg as any).agent ?? ''}) ${delta}`, level: 'dim' }
    }
    case 'smoke_step':
      return { text: `[smoke] ${(msg as any).text}`, level: 'info' }
    case 'step': {
      const m = msg as any
      const idx = m.index != null && m.total ? `${m.index}/${m.total}` : ''
      const s = m.step
      const desc = s ? `${s.action} ${s.targetDescription ?? ''}` : (m.text ?? '')
      return { text: `[步骤 ${idx}] ${m.status ?? ''} ${desc}`.trim(), level: m.status === 'failed' ? 'error' : 'info' }
    }
    case 'assert': {
      const m = msg as any
      const a = m.assertion
      const desc = a ? `${a.kind} ${a.target ?? ''} ${a.expected ?? ''}` : (m.text ?? '')
      return {
        text: `[断言] ${m.passed ? '✓' : '✗'} ${desc}`.trim(),
        level: m.passed ? 'success' : 'error'
      }
    }
    case 'agent_lifecycle':
      return { text: `[agent] ${(msg as any).agent ?? ''} → ${(msg as any).phase ?? ''}`, level: 'dim' }
    case 'budget_exceeded':
      return { text: `[预算告警] agent=${(msg as any).agent} budget=${(msg as any).budget}`, level: 'warning' }
    default:
      return { text: JSON.stringify(msg), level: 'dim' }
  }
}

export const useRunStore = defineStore('run', () => {
  const currentRunId = ref<string | null>(null)
  const currentMode = ref<RunMode | null>(null)
  const isRunning = ref(false)
  const logs = ref<LogEntry[]>([])
  const runCases = ref<RunCase[]>([])
  const runResult = ref<RunDetail | null>(null)
  const caseProgress = ref<{ current: number; total: number; title: string }>({
    current: 0,
    total: 0,
    title: ''
  })
  const screenshots = ref<Array<{ caseId?: number; url: string; title?: string }>>([])

  let ws: WebSocket | null = null
  let logSeq = 0

  const passedCount = computed(() => runCases.value.filter((c) => c.status === 'passed').length)
  const failedCount = computed(() => runCases.value.filter((c) => c.status === 'failed').length)
  const errorCount = computed(() => runCases.value.filter((c) => c.status === 'error').length)
  const skippedCount = computed(() => runCases.value.filter((c) => c.status === 'skipped').length)

  const progressPercent = computed(() => {
    const { current, total } = caseProgress.value
    if (!total) return 0
    return Math.min(100, Math.round((current / total) * 100))
  })

  const history = ref<RunRecord[]>(runHistory.list())

  function refreshHistory(): void {
    history.value = runHistory.list()
  }

  function pushLog(msg: WsMessage): void {
    const { text, level } = formatMessage(msg)
    logs.value.push({ id: ++logSeq, raw: msg, text, level, ts: Date.now() })
    if (logs.value.length > MAX_LOGS) {
      logs.value = logs.value.slice(-MAX_LOGS)
    }
  }

  function clearLogs(): void {
    logs.value = []
    runCases.value = []
    caseProgress.value = { current: 0, total: 0, title: '' }
    screenshots.value = []
  }

  function handleWsMessage(msg: WsMessage): void {
    pushLog(msg)
    switch (msg.type) {
      case 'run_start': {
        const m = msg as any
        if (m.total) caseProgress.value = { current: 0, total: m.total, title: '' }
        break
      }
      case 'case_start': {
        const m = msg as any
        caseProgress.value = {
          current: m.current ?? caseProgress.value.current + 1,
          total: m.total ?? caseProgress.value.total,
          title: m.caseTitle ?? m.caseId?.toString() ?? ''
        }
        if (m.caseId != null) {
          upsertRunCase({
            id: m.caseId,
            caseId: m.caseId,
            caseTitle: m.caseTitle,
            status: 'running'
          })
        }
        break
      }
      case 'case_complete': {
        const m = msg as WsCaseCompleteMessage
        if (m.caseId != null) {
          upsertRunCase({
            id: m.caseId,
            caseId: m.caseId,
            caseTitle: m.caseTitle,
            status: m.status ?? 'failed',
            error: m.error ?? null,
            screenshot: m.screenshot ?? null
          })
        }
        if (m.screenshot && currentRunId.value) {
          screenshots.value.push({
            caseId: m.caseId,
            title: m.caseTitle,
            url: screenshotUrl(currentRunId.value, m.screenshot)
          })
        }
        break
      }
      case 'step': {
        const m = msg as any
        if (m.screenshot && currentRunId.value) {
          screenshots.value.push({
            url: screenshotUrl(currentRunId.value, m.screenshot),
            caseId: m.caseId
          })
        }
        break
      }
      case 'run_complete': {
        const m = msg as any
        isRunning.value = false
        if (currentRunId.value) {
          runHistory.update(currentRunId.value, {
            status: m.error ? 'failed' : 'completed'
          })
          refreshHistory()
        }
        // 主动拉取最终详情
        if (currentRunId.value) {
          fetchRunDetail(currentRunId.value).catch(() => undefined)
        }
        break
      }
    }
  }

  function upsertRunCase(rc: RunCase): void {
    const idx = runCases.value.findIndex((c) => c.caseId === rc.caseId)
    if (idx === -1) {
      runCases.value.push(rc)
    } else {
      runCases.value[idx] = { ...runCases.value[idx], ...rc }
    }
  }

  function connectWs(runId: string): void {
    disconnectWs()
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${window.location.host}/ws?runId=${encodeURIComponent(runId)}`
    ws = new WebSocket(url)
    ws.onopen = () => {
      pushLog({ type: 'tasks_ready', tasks: [{ title: `WS 已连接 ${runId.slice(0, 8)}` }] })
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as WsMessage
        handleWsMessage(msg)
      } catch (e) {
        console.error('[WS] parse error', e)
      }
    }
    ws.onerror = () => {
      pushLog({ type: 'run_complete', error: 'WebSocket 连接错误' })
    }
    ws.onclose = () => {
      pushLog({ type: 'tasks_ready', tasks: [{ title: '(ws 已关闭)' }] })
      if (isRunning.value) {
        isRunning.value = false
      }
    }
  }

  function disconnectWs(): void {
    if (ws) {
      ws.onclose = null
      ws.onerror = null
      ws.onmessage = null
      try {
        ws.close()
      } catch {
        /* noop */
      }
      ws = null
    }
  }

  async function startRun(payload: StartRunPayload): Promise<StartRunResponse> {
    clearLogs()
    const res = await runApi.start(payload)
    currentRunId.value = res.runId
    currentMode.value = res.mode
    isRunning.value = true
    runHistory.add({
      id: res.runId,
      mode: res.mode,
      status: 'running',
      startedAt: Date.now()
    })
    refreshHistory()
    connectWs(res.runId)
    return res
  }

  function stopRun(): void {
    disconnectWs()
    isRunning.value = false
    if (currentRunId.value) {
      runHistory.update(currentRunId.value, { status: 'stopped' })
      refreshHistory()
    }
  }

  async function fetchRunDetail(id: string): Promise<RunDetail> {
    const detail = await runApi.detail(id)
    runResult.value = detail
    if (detail.runCases?.length) {
      // 用后端权威结果覆盖
      runCases.value = detail.runCases
    }
    return detail
  }

  function loadHistoryDetail(id: string): void {
    currentRunId.value = id
    fetchRunDetail(id).catch((e) => {
      console.error('[run] load detail', e)
    })
  }

  return {
    currentRunId,
    currentMode,
    isRunning,
    logs,
    runCases,
    runResult,
    caseProgress,
    screenshots,
    progressPercent,
    passedCount,
    failedCount,
    errorCount,
    skippedCount,
    history,
    refreshHistory,
    startRun,
    stopRun,
    connectWs,
    disconnectWs,
    fetchRunDetail,
    loadHistoryDetail,
    clearLogs,
    pushLog
  }
})
