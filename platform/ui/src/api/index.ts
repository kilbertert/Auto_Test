import axios, { type AxiosInstance } from 'axios'
import type {
  CaseListResponse,
  CaseTree,
  TestCase,
  ImportResponse,
  InterpretResponse,
  RunMode,
  StartRunPayload,
  StartRunResponse,
  RunDetail,
  RunRecord
} from '../types'

const api: AxiosInstance = axios.create({
  baseURL: '/api/v1',
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json'
  }
})

api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    const message =
      (error.response && error.response.data && (error.response.data.error || error.response.data.message)) ||
      error.message ||
      '请求失败'
    console.error('[API]', error.config?.method?.toUpperCase(), error.config?.url, message)
    return Promise.reject(new Error(message))
  }
)

// ---- 用例库 ----
export const caseApi = {
  tree: (): Promise<CaseTree> => api.get('/tree'),
  list: (params: {
    project?: string
    q?: string
    limit?: number
    offset?: number
    modulePath?: string
  }): Promise<CaseListResponse> => api.get('/cases', { params }),
  detail: (id: number): Promise<{ case: TestCase }> => api.get(`/cases/${id}`)
}

// ---- 导入 / 解释 ----
export const importApi = {
  import: (filePath: string): Promise<ImportResponse> =>
    api.post('/import', { filePath }),
  interpret: (payload: {
    limit?: number
    caseIds?: number[]
  }): Promise<InterpretResponse> => api.post('/interpret', payload)
}

// ---- 执行 ----
export const runApi = {
  start: (payload: StartRunPayload): Promise<StartRunResponse> =>
    api.post('/runs', payload),
  detail: (id: string): Promise<RunDetail> => api.get(`/runs/${id}`)
}

// ---- 本地 run 记录(无列表端点,本地维护) ----
const RUNS_KEY = 'auto-test:runs'

export const runHistory = {
  list(): RunRecord[] {
    try {
      const raw = localStorage.getItem(RUNS_KEY)
      return raw ? (JSON.parse(raw) as RunRecord[]) : []
    } catch {
      return []
    }
  },
  add(record: RunRecord): void {
    const all = this.list().filter((r) => r.id !== record.id)
    all.unshift(record)
    localStorage.setItem(RUNS_KEY, JSON.stringify(all.slice(0, 100)))
  },
  update(id: string, patch: Partial<RunRecord>): void {
    const all = this.list()
    const idx = all.findIndex((r) => r.id === id)
    if (idx !== -1) {
      all[idx] = { ...all[idx], ...patch }
      localStorage.setItem(RUNS_KEY, JSON.stringify(all))
    }
  },
  remove(id: string): void {
    const all = this.list().filter((r) => r.id !== id)
    localStorage.setItem(RUNS_KEY, JSON.stringify(all))
  }
}

// ---- 截图 URL ----
export function screenshotUrl(runId: string, filename: string): string {
  return `/screenshots/${runId}/${filename}`
}

export type { RunMode }
