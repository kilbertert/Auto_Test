<template>
  <div class="home-page">
    <el-row :gutter="20">
      <el-col :span="6" v-for="card in statCards" :key="card.label">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-value" :style="{ color: card.color }">{{ card.value }}</div>
          <div class="stat-label">{{ card.label }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="quick-card">
      <template #header>
        <span>快速入口</span>
      </template>
      <div class="quick-actions">
        <el-button type="primary" @click="$router.push('/import')">
          <el-icon><Upload /></el-icon> 导入用例
        </el-button>
        <el-button type="success" @click="$router.push('/cases')">
          <el-icon><Document /></el-icon> 浏览用例库
        </el-button>
        <el-button type="warning" @click="$router.push('/execute')">
          <el-icon><VideoPlay /></el-icon> 执行测试
        </el-button>
        <el-button @click="$router.push('/reports')">
          <el-icon><DataAnalysis /></el-icon> 查看报告
        </el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="recent-card" v-if="runStore.history.length">
      <template #header>
        <span>最近运行</span>
      </template>
      <el-table :data="runStore.history.slice(0, 5)" stripe size="small">
        <el-table-column prop="id" label="Run ID" width="140">
          <template #default="{ row }">
            <span class="mono">{{ row.id.slice(0, 12) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="mode" label="模式" width="100">
          <template #default="{ row }">
            <el-tag size="small">{{ modeText(row.mode) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="startedAt" label="开始时间" min-width="160">
          <template #default="{ row }">
            {{ formatTime(row.startedAt) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="$router.push('/reports')">查看</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRunStore } from '../stores/run'
import { useCaseStore } from '../stores/case'
import type { RunMode, RunCaseStatus } from '../types'

const runStore = useRunStore()
const caseStore = useCaseStore()

const statCards = [
  { label: '用例总数', value: '—', color: '#409eff' },
  { label: '模块数', value: '—', color: '#67c23a' },
  { label: '历史运行', value: runStore.history.length, color: '#e6a23c' },
  { label: '最近成功', value: runStore.history.filter((r) => r.status === 'completed').length, color: '#909399' }
]

function modeText(m: RunMode): string {
  return { agent: 'Agent', smoke: '冒烟', regression: '回归', explore: '探索' }[m] ?? m
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
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN')
}

onMounted(async () => {
  await caseStore.loadTree()
  statCards[0].value = '—'
  statCards[1].value = caseStore.tree.length
})
</script>

<style scoped>
.stat-card {
  text-align: center;
}
.stat-value {
  font-size: 36px;
  font-weight: bold;
}
.stat-label {
  margin-top: 6px;
  color: #909399;
  font-size: 14px;
}
.quick-card,
.recent-card {
  margin-top: 20px;
}
.quick-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.mono {
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
</style>
