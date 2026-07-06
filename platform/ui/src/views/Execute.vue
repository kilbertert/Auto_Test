<template>
  <div class="execute-page">
    <!-- 配置区 -->
    <el-card shadow="never" class="config-card">
      <template #header>
        <span>执行配置</span>
      </template>
      <el-form label-width="90px" label-position="right">
        <el-form-item label="执行模式">
          <el-radio-group v-model="mode" @change="onModeChange">
            <el-radio-button label="agent">Agent 模式</el-radio-button>
            <el-radio-button label="smoke">冒烟 (无 LLM)</el-radio-button>
            <el-radio-button label="regression">回归</el-radio-button>
            <el-radio-button label="explore">探索</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <el-form-item v-if="mode === 'regression'" label="用例范围">
          <div class="case-scope">
            <el-radio-group v-model="regressionScope">
              <el-radio label="selected">选中用例 ({{ caseStore.selectedIds.length }})</el-radio>
              <el-radio label="all">全部用例</el-radio>
            </el-radio-group>
            <el-button
              v-if="regressionScope === 'selected' && caseStore.selectedIds.length === 0"
              link
              type="primary"
              @click="$router.push('/cases')"
            >
              前往用例库选择
            </el-button>
            <span v-if="regressionScope === 'selected' && caseStore.selectedIds.length > 0" class="hint">
              已选 {{ caseStore.selectedIds.length }} 条
            </span>
          </div>
        </el-form-item>

        <el-form-item v-if="mode === 'explore'" label="探索目标">
          <el-input v-model="goal" placeholder="例:测试登录流程是否正常" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item v-if="mode === 'explore'" label="目标 URL">
          <el-input v-model="url" placeholder="https://example.com" />
        </el-form-item>

        <el-form-item v-if="mode === 'agent'" label="目标 URL">
          <el-input v-model="url" placeholder="可选,留空使用默认" />
        </el-form-item>

        <el-form-item>
          <el-button
            type="primary"
            size="large"
            :loading="starting"
            :disabled="!canStart"
            @click="onStart"
          >
            <el-icon><VideoPlay /></el-icon> 开始执行
          </el-button>
          <el-button v-if="runStore.isRunning" type="danger" @click="runStore.stopRun()">
            <el-icon><SwitchButton /></el-icon> 断开
          </el-button>
          <el-button @click="runStore.clearLogs()" :disabled="runStore.isRunning">清空</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 运行中:进度条 -->
    <el-card v-if="runStore.currentRunId" shadow="never" class="progress-card">
      <el-progress :percentage="runStore.progressPercent" :status="progressStatus" :stroke-width="18" text-inside />
      <div class="progress-meta">
        <span>Run: <code>{{ runStore.currentRunId.slice(0, 12) }}</code></span>
        <span v-if="runStore.caseProgress.title">当前: {{ runStore.caseProgress.title }}</span>
        <span>{{ runStore.caseProgress.current }} / {{ runStore.caseProgress.total }}</span>
      </div>
    </el-card>

    <!-- 结果摘要 -->
    <el-row :gutter="12" class="summary-row" v-if="runStore.runCases.length">
      <el-col :span="6"><div class="summary-item total"><div class="v">{{ runStore.runCases.length }}</div><div class="l">总用例</div></div></el-col>
      <el-col :span="6"><div class="summary-item passed"><div class="v">{{ runStore.passedCount }}</div><div class="l">通过</div></div></el-col>
      <el-col :span="6"><div class="summary-item failed"><div class="v">{{ runStore.failedCount + runStore.errorCount }}</div><div class="l">失败</div></div></el-col>
      <el-col :span="6"><div class="summary-item skipped"><div class="v">{{ runStore.skippedCount }}</div><div class="l">跳过</div></div></el-col>
    </el-row>

    <el-row :gutter="16">
      <!-- 实时日志流 -->
      <el-col :span="14">
        <el-card shadow="never" class="log-card">
          <template #header>
            <div class="card-header">
              <span>实时日志</span>
              <el-button-group size="small">
                <el-button :type="logFilter === 'all' ? 'primary' : ''" @click="logFilter = 'all'">全部</el-button>
                <el-button :type="logFilter === 'key' ? 'primary' : ''" @click="logFilter = 'key'">关键</el-button>
              </el-button-group>
            </div>
          </template>
          <div class="log-box" ref="logBox">
            <div
              v-for="entry in filteredLogs"
              :key="entry.id"
              :class="['log-line', `log-${entry.level}`]"
            >
              <span class="log-time">{{ formatTs(entry.ts) }}</span>
              <span class="log-text">{{ entry.text }}</span>
            </div>
            <div v-if="runStore.logs.length === 0" class="log-empty">等待执行...</div>
          </div>
        </el-card>
      </el-col>

      <!-- 用例结果 + 截图 -->
      <el-col :span="10">
        <el-card shadow="never" class="result-card">
          <template #header>
            <span>用例结果</span>
          </template>
          <el-table :data="runStore.runCases" stripe size="small" max-height="320">
            <el-table-column prop="caseTitle" label="用例" min-width="140" show-overflow-tooltip>
              <template #default="{ row }">{{ row.caseTitle ?? row.caseId }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="caseStatusType(row.status)">{{ caseStatusText(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="screenshot" label="截图" width="60">
              <template #default="{ row }">
                <el-button v-if="row.screenshot && runStore.currentRunId" link size="small" type="primary" @click="viewShot(row)">看</el-button>
                <span v-else>-</span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card v-if="runStore.screenshots.length" shadow="never" class="shot-card">
          <template #header>
            <span>截图 ({{ runStore.screenshots.length }})</span>
          </template>
          <div class="shot-grid">
            <div v-for="(s, i) in runStore.screenshots.slice(-6)" :key="i" class="shot-thumb" @click="openShot(s.url)">
              <img :src="s.url" :alt="s.title || `截图${i}`" />
              <div class="shot-title">{{ s.title || `截图 ${i + 1}` }}</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="shotDialogVisible" title="截图查看" width="860px">
      <img v-if="currentShotUrl" :src="currentShotUrl" style="width: 100%" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useRunStore } from '../stores/run'
import { useCaseStore } from '../stores/case'
import { screenshotUrl } from '../api'
import type { RunMode, RunCaseStatus, RunCase } from '../types'
import type { LogEntry } from '../stores/run'

const route = useRoute()
const runStore = useRunStore()
const caseStore = useCaseStore()

const mode = ref<RunMode>('smoke')
const regressionScope = ref<'selected' | 'all'>('selected')
const goal = ref('')
const url = ref('')
const starting = ref(false)
const logFilter = ref<'all' | 'key'>('all')
const logBox = ref<HTMLElement | null>(null)
const shotDialogVisible = ref(false)
const currentShotUrl = ref('')

const canStart = computed(() => {
  if (mode.value === 'explore') return goal.value.trim().length > 0
  if (mode.value === 'regression' && regressionScope.value === 'selected') {
    return caseStore.selectedIds.length > 0
  }
  return true
})

const progressStatus = computed<'' | 'success' | 'exception'>(() => {
  if (!runStore.isRunning && runStore.runCases.length) {
    return runStore.failedCount + runStore.errorCount > 0 ? 'exception' : 'success'
  }
  return ''
})

const KEY_TYPES = new Set([
  'run_start', 'run_complete', 'case_start', 'case_complete',
  'step', 'assert', 'smoke_step', 'budget_exceeded'
])

const filteredLogs = computed<LogEntry[]>(() => {
  if (logFilter.value === 'all') return runStore.logs
  return runStore.logs.filter((l) => KEY_TYPES.has(l.raw.type))
})

function onModeChange(): void {
  if (mode.value !== 'regression') regressionScope.value = 'selected'
}

async function onStart(): Promise<void> {
  starting.value = true
  try {
    const payload: Record<string, unknown> = { mode: mode.value }
    if (mode.value === 'regression' && regressionScope.value === 'selected') {
      payload.caseIds = caseStore.selectedIds
    }
    if (mode.value === 'explore') {
      payload.goal = goal.value
      payload.url = url.value
    }
    if ((mode.value === 'agent' || mode.value === 'explore') && url.value) {
      payload.url = url.value
    }
    const res = await runStore.startRun(payload as any)
    ElMessage.success(`已启动 ${res.mode} 运行 (${res.runId.slice(0, 8)})`)
  } catch (e: any) {
    ElMessage.error('启动失败: ' + (e?.message || e))
  } finally {
    starting.value = false
  }
}

function viewShot(row: RunCase): void {
  if (row.screenshot && runStore.currentRunId) {
    openShot(screenshotUrl(runStore.currentRunId, row.screenshot))
  }
}
function openShot(u: string): void {
  currentShotUrl.value = u
  shotDialogVisible.value = true
}

function caseStatusType(s: RunCaseStatus): 'success' | 'danger' | 'warning' | 'info' | '' {
  return { passed: 'success', failed: 'danger', error: 'danger', skipped: 'warning', running: '', pending: 'info' }[s] ?? 'info'
}
function caseStatusText(s: RunCaseStatus): string {
  return { passed: '通过', failed: '失败', error: '错误', skipped: '跳过', running: '运行中', pending: '等待' }[s] ?? s
}
function formatTs(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

// 自动滚动日志到底部
watch(() => runStore.logs.length, async () => {
  await nextTick()
  if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
})

onMounted(() => {
  if (route.query.mode) mode.value = route.query.mode as RunMode
  if (route.query.from === 'cases') mode.value = 'regression'
})
</script>

<style scoped>
.execute-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.config-card,
.progress-card,
.log-card,
.result-card,
.shot-card {
  margin-bottom: 0;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.case-scope {
  display: flex;
  align-items: center;
  gap: 12px;
}
.hint {
  color: #909399;
  font-size: 13px;
}
.progress-meta {
  display: flex;
  gap: 24px;
  margin-top: 8px;
  color: #606266;
  font-size: 13px;
}
.progress-meta code {
  font-family: ui-monospace, monospace;
  background: #f0f2f5;
  padding: 1px 6px;
  border-radius: 3px;
}
.summary-row {
  margin-bottom: 4px;
}
.summary-item {
  padding: 16px;
  border-radius: 8px;
  text-align: center;
  color: #fff;
}
.summary-item.total { background: #409eff; }
.summary-item.passed { background: #67c23a; }
.summary-item.failed { background: #f56c6c; }
.summary-item.skipped { background: #e6a23c; }
.summary-item .v { font-size: 28px; font-weight: bold; }
.summary-item .l { font-size: 13px; margin-top: 4px; opacity: 0.9; }

.log-box {
  height: 420px;
  overflow-y: auto;
  background: #1e1e1e;
  border-radius: 6px;
  padding: 10px;
  font-family: ui-monospace, 'Cascadia Code', monospace;
  font-size: 12.5px;
  line-height: 1.7;
}
.log-line {
  display: flex;
  gap: 8px;
  white-space: pre-wrap;
  word-break: break-word;
}
.log-time { color: #6a9955; flex-shrink: 0; }
.log-text { color: #d4d4d4; }
.log-success .log-text { color: #4ec9b0; }
.log-error .log-text { color: #f48771; }
.log-warning .log-text { color: #dcdcaa; }
.log-dim .log-text { color: #808080; }
.log-info .log-text { color: #9cdcfe; }
.log-empty {
  color: #808080;
  text-align: center;
  padding: 40px;
}
.shot-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.shot-thumb {
  cursor: pointer;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  overflow: hidden;
}
.shot-thumb img {
  width: 100%;
  height: 90px;
  object-fit: cover;
  display: block;
}
.shot-title {
  font-size: 11px;
  color: #909399;
  padding: 2px 4px;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
