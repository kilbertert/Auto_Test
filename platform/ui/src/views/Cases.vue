<template>
  <div class="cases-page">
    <el-row :gutter="16" class="cases-row">
      <!-- 左侧模块树 -->
      <el-col :span="6">
        <el-card shadow="never" class="tree-card" v-loading="caseStore.loadingTree">
          <template #header>
            <div class="card-header">
              <span>模块树</span>
              <el-button link type="primary" size="small" @click="caseStore.loadTree()">刷新</el-button>
            </div>
          </template>
          <el-input
            v-model="treeFilter"
            placeholder="搜索模块"
            size="small"
            clearable
            class="tree-filter"
          />
          <el-tree
            ref="treeRef"
            :data="caseStore.tree"
            :props="{ label: 'label', children: 'children' }"
            node-key="id"
            :filter-node-method="filterNode"
            :default-expand-all="false"
            highlight-current
            @node-click="onNodeClick"
            class="module-tree"
          />
        </el-card>
      </el-col>

      <!-- 右侧用例表格 -->
      <el-col :span="18">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <div class="filter-bar">
                <span class="title">用例列表</span>
                <el-tag v-if="currentModulePath" closable @close="clearModuleFilter" type="info" size="small">
                  {{ currentModulePath }}
                </el-tag>
              </div>
              <div class="filter-bar">
                <el-input
                  v-model="searchQuery"
                  placeholder="搜索标题/编号"
                  size="small"
                  style="width: 200px"
                  clearable
                  @keyup.enter="reloadCases"
                  @clear="reloadCases"
                />
                <el-select v-model="projectFilter" placeholder="项目" size="small" clearable style="width: 160px" @change="reloadCases">
                  <el-option v-for="p in projectOptions" :key="p" :label="p" :value="p" />
                </el-select>
                <el-button size="small" type="primary" @click="reloadCases">搜索</el-button>
              </div>
            </div>
          </template>

          <el-table
            :data="caseStore.cases"
            v-loading="caseStore.loadingCases"
            stripe
            row-key="id"
            @selection-change="onSelectionChange"
            @expand-change="onExpand"
            style="width: 100%"
          >
            <el-table-column type="selection" width="42" />
            <el-table-column type="expand">
              <template #default="{ row }">
                <case-detail :case-id="row.id" :store="caseStore" />
              </template>
            </el-table-column>
            <el-table-column prop="globalKey" label="编号" width="130" show-overflow-tooltip />
            <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
            <el-table-column prop="modulePath" label="模块" min-width="160" show-overflow-tooltip />
            <el-table-column prop="priority" label="优先级" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="priorityType(row.priority)">{{ row.priority }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="author" label="作者" width="90" />
            <el-table-column prop="interpretStatus" label="解释状态" width="100">
              <template #default="{ row }">
                <el-tag size="small" :type="interpretType(row.interpretStatus)">
                  {{ interpretText(row.interpretStatus) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="confidence" label="置信度" width="90">
              <template #default="{ row }">
                <span v-if="row.confidence != null">{{ (row.confidence * 100).toFixed(0) }}%</span>
                <span v-else>-</span>
              </template>
            </el-table-column>
          </el-table>

          <div class="table-footer">
            <div>
              <el-button
                type="warning"
                :disabled="selectedRows.length === 0"
                @click="goExecute"
              >
                <el-icon><VideoPlay /></el-icon>
                执行选中 ({{ selectedRows.length }})
              </el-button>
              <el-button :disabled="selectedRows.length === 0" @click="goExecuteAll">全部回归</el-button>
            </div>
            <el-pagination
              v-model:current-page="page"
              v-model:page-size="pageSize"
              :total="caseStore.total"
              :page-sizes="[20, 50, 100]"
              layout="total, sizes, prev, pager, next"
              background
              @current-change="reloadCases"
              @size-change="reloadCases"
            />
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useCaseStore, type TreeNode } from '../stores/case'
import CaseDetail from '../components/CaseDetail.vue'
import type { TestCaseSummary, InterpretStatus } from '../types'

const router = useRouter()
const caseStore = useCaseStore()

const treeRef = ref()
const treeFilter = ref('')
const searchQuery = ref('')
const projectFilter = ref('')
const currentModulePath = ref('')
const page = ref(1)
const pageSize = ref(20)
const selectedRows = ref<TestCaseSummary[]>([])
const projectOptions = ref<string[]>([])

watch(treeFilter, (val) => {
  treeRef.value?.filter(val)
})

function filterNode(value: string, data: TreeNode): boolean {
  if (!value) return true
  return data.label.includes(value)
}

function onNodeClick(node: TreeNode): void {
  if (node.modulePath) {
    currentModulePath.value = node.modulePath
  } else {
    currentModulePath.value = node.label
  }
  page.value = 1
  reloadCases()
}

function clearModuleFilter(): void {
  currentModulePath.value = ''
  reloadCases()
}

async function reloadCases(): Promise<void> {
  await caseStore.loadCases({
    project: projectFilter.value || undefined,
    q: searchQuery.value || undefined,
    limit: pageSize.value,
    offset: (page.value - 1) * pageSize.value,
    modulePath: currentModulePath.value || undefined
  })
}

function onSelectionChange(rows: TestCaseSummary[]): void {
  selectedRows.value = rows
}

async function onExpand(row: TestCaseSummary): Promise<void> {
  // 预加载详情
  await caseStore.loadDetail(row.id)
}

function goExecute(): void {
  caseStore.setSelected(selectedRows.value.map((r) => r.id))
  router.push({ path: '/execute', query: { from: 'cases', mode: 'regression' } })
}

function goExecuteAll(): void {
  caseStore.clearSelected()
  router.push({ path: '/execute', query: { mode: 'regression' } })
}

function priorityType(p: string): 'danger' | 'warning' | 'info' {
  if (p === 'P0') return 'danger'
  if (p === 'P1') return 'warning'
  return 'info'
}
function interpretType(s: InterpretStatus): 'success' | 'warning' | 'danger' | 'info' {
  return { done: 'success', pending: 'warning', failed: 'danger', manual: 'info' }[s] ?? 'info'
}
function interpretText(s: InterpretStatus): string {
  return { done: '已解释', pending: '待解释', failed: '失败', manual: '人工' }[s] ?? s
}

onMounted(async () => {
  await caseStore.loadTree()
  // 模块名作为项目候选(后端若无独立 project 列表端点)
  projectOptions.value = caseStore.tree.map((n) => n.label)
  await reloadCases()
})
</script>

<style scoped>
.cases-page {
  height: 100%;
}
.cases-row {
  height: 100%;
}
.tree-card {
  height: calc(100vh - 140px);
  display: flex;
  flex-direction: column;
}
.tree-card :deep(.el-card__body) {
  flex: 1;
  overflow: auto;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.filter-bar {
  display: flex;
  gap: 8px;
  align-items: center;
}
.tree-filter {
  margin-bottom: 10px;
}
.module-tree {
  margin-top: 4px;
}
.table-footer {
  margin-top: 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.title {
  font-weight: 600;
}
</style>
