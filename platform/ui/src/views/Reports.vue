<template>
  <div class="reports-page">
    <el-row :gutter="16">
      <!-- 左侧 run 历史 -->
      <el-col :span="8">
        <el-card shadow="never" class="history-card">
          <template #header>
            <div class="card-header">
              <span>运行历史</span>
              <el-button link type="primary" size="small" @click="runStore.refreshHistory()">刷新</el-button>
            </div>
          </template>
          <div v-if="runStore.history.length === 0" class="empty">暂无运行记录(运行后自动记录)</div>
          <div
            v-for="r in runStore.history"
            :key="r.id"
            :class="['history-item', { active: r.id === selectedRunId }]"
            @click="selectRun(r.id)"
          >
            <div class="hi-top">
              <span class="hi-id">{{ r.id.slice(0, 12) }}</span>
              <el-tag size="small" :type="statusType(r.status)">{{ statusText(r.status) }}</el-tag>
            </div>
            <div class="hi-meta">
              <el-tag size="small" effect="plain">{{ modeText(r.mode) }}</el-tag>
              <span class="hi-time">{{ formatTime(r.startedAt) }}</span>
            </div>
          </div>
        </el-card>
      </el-col>

      <!-- 右侧详情 -->
      <el-col :span="16">
        <el-card shadow="never" v-loading="loadingDetail">
          <template #header>
            <div class="card-header">
              <span v-if="selectedRunId">Run 详情: {{ selectedRunId.slice(0, 12) }}</span>
              <span v-else>请选择左侧运行记录</span>
              <el-button v-if="detail" link type="primary" size="small" @click="reloadDetail">刷新</el-button>
            </div>
          </template>

          <div v-if="!selectedRunId" class="empty-big">从左侧选择一条运行记录查看详情</div>

          <template v-else-if="detail">
            <!-- 摘要 -->
            <el-descriptions :column="4" border size="small" class="summary-desc">
              <el-descriptions-item label="状态">
                <el-tag size="small" :type="statusType(detail.run.status)">{{ statusText(detail.run.status) }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="模式">{{ modeText(detail.run.mode || '') }}</el-descriptions-item>
              <el-descriptions-item label="总数">{{ detail.summary?.total ?? detail.runCases.length }}</el-descriptions-item>
              <el-descriptions-item label="通过">{{ detail.summary?.passed ?? '-' }}</el-descriptions-item>
              <el-descriptions-item label="失败">{{ detail.summary?.failed ?? '-' }}</el-descriptions-item>
              <el-descriptions-item label="跳过">{{ detail.summary?.skipped ?? '-' }}</el-descriptions-item>
              <el-descriptions-item label="耗时">{{ formatDuration(detail.summary?.duration) }}</el-descriptions-item>
              <el-descriptions-item label="名称">{{ detail.run.name || '-' }}</el-descriptions-item>
            </el-descriptions>

            <!-- 用例结果 -->
            <el-table :data="detail.runCases" stripe size="small" class="case-table">
              <el-table-column prop="caseId" label="ID" width="70" />
              <el-table-column prop="caseTitle" label="用例" min-width="180" show-overflow-tooltip>
                <template #default="{ row }">{{ row.caseTitle ?? row.caseId }}</template>
              </el-table-column>
              <el-table-column prop="status" label="状态" width="90">
                <template #default="{ row }">
                  <el-tag size="small" :type="caseStatusType(row.status)">{{ caseStatusText(row.status) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="error" label="错误" min-width="200" show-overflow-tooltip />
              <el-table-column label="截图" width="80">
                <template #default="{ row }">
                  <el-button v-if="row.screenshot" link size="small" type="primary" @click="openShot(row)">查看</el-button>
                  <span v-else>-</span>
                </template>
              </el-table-column>
            </el-table>
          </template>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="shotDialogVisible" title="截图查看" width="860px">
      <img v-if="currentShotUrl" :src="currentShotUrl" style="width: 100%" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRunStore } from '../stores/run'
import { runApi, screenshotUrl } from '../api'
import type { RunDetail, RunMode, RunCaseStatus, RunCase } from '../types'

const runStore = useRunStore()

const selectedRunId = ref<string | null>(null)
const detail = ref<RunDetail | null>(null)
const loadingDetail = ref(false)
const shotDialogVisible = ref(false)
const currentShotUrl = ref('')

async function selectRun(id: string): Promise<void> {
  selectedRunId.value = id
  await reloadDetail()
}

async function reloadDetail(): Promise<void> {
  if (!selectedRunId.value) return
  loadingDetail.value = true
  try {
    detail.value = await runApi.detail(selectedRunId.value)
  } catch (e: any) {
    detail.value = null
  } finally {
    loadingDetail.value = false
  }
}

function openShot(row: RunCase): void {
  if (row.screenshot && selectedRunId.value) {
    currentShotUrl.value = screenshotUrl(selectedRunId.value, row.screenshot)
    shotDialogVisible.value = true
  }
}

function statusType(s: string): 'success' | 'warning' | 'danger' | 'info' {
  if (s === 'completed') return 'success'
  if (s === 'running') return 'warning'
  if (s === 'failed') return 'danger'
  return 'info'
}
function statusText(s: string): string {
  return { completed: '完成', running: '运行中', failed: '失败', stopped: '已停止' }[s] ?? s
}
function modeText(m: RunMode | string): string {
  return { agent: 'Agent', smoke: '冒烟', regression: '回归', explore: '探索' }[m as RunMode] ?? m
}
function caseStatusType(s: RunCaseStatus): 'success' | 'danger' | 'warning' | 'info' | '' {
  return { passed: 'success', failed: 'danger', error: 'danger', skipped: 'warning', running: '', pending: 'info' }[s] ?? 'info'
}
function caseStatusText(s: RunCaseStatus): string {
  return { passed: '通过', failed: '失败', error: '错误', skipped: '跳过', running: '运行中', pending: '等待' }[s] ?? s
}
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN')
}
function formatDuration(ms?: number): string {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
</script>

<style scoped>
.reports-page {
  height: 100%;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.history-card {
  height: calc(100vh - 140px);
}
.history-card :deep(.el-card__body) {
  max-height: calc(100vh - 220px);
  overflow-y: auto;
  padding: 8px;
}
.history-item {
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid transparent;
  margin-bottom: 6px;
}
.history-item:hover {
  background: #f5f7fa;
}
.history-item.active {
  background: #ecf5ff;
  border-color: #409eff;
}
.hi-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.hi-id {
  font-family: ui-monospace, monospace;
  font-size: 13px;
  font-weight: 600;
}
.hi-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: #909399;
}
.empty {
  text-align: center;
  color: #909399;
  padding: 30px;
}
.empty-big {
  text-align: center;
  color: #909399;
  padding: 60px;
}
.summary-desc {
  margin-bottom: 16px;
}
.case-table {
  width: 100%;
}
</style>
