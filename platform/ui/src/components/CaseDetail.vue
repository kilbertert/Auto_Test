<template>
  <div class="case-detail" v-loading="loading">
    <el-tabs v-if="detail">
      <el-tab-pane label="结构化步骤">
        <div v-if="steps.length === 0" class="empty">暂无结构化步骤</div>
        <el-timeline v-else>
          <el-timeline-item
            v-for="(s, i) in steps"
            :key="i"
            :timestamp="`#${i + 1}`"
            placement="top"
            type="primary"
          >
            <div class="step-line">
              <el-tag size="small" type="info">{{ s.action }}</el-tag>
              <span class="step-target">{{ s.targetDescription }}</span>
              <span v-if="s.value" class="step-value">值: {{ s.value }}</span>
              <el-tag v-if="s.confidence != null && s.confidence < 0.7" size="small" type="warning">
                置信度低
              </el-tag>
            </div>
          </el-timeline-item>
        </el-timeline>
      </el-tab-pane>

      <el-tab-pane label="结构化断言">
        <div v-if="assertions.length === 0" class="empty">暂无结构化断言</div>
        <ul v-else class="assert-list">
          <li v-for="(a, i) in assertions" :key="i">
            <el-tag size="small">{{ a.kind }}</el-tag>
            <span class="assert-target">{{ a.target }}</span>
            <span class="assert-expected">{{ a.expected }}</span>
          </li>
        </ul>
      </el-tab-pane>

      <el-tab-pane label="原始步骤/预期">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="原始步骤">
            <pre class="raw-text">{{ detail.rawSteps || '—' }}</pre>
          </el-descriptions-item>
          <el-descriptions-item label="预期结果">
            <pre class="raw-text">{{ detail.rawExpected || '—' }}</pre>
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.precondition" label="前置条件">
            <pre class="raw-text">{{ detail.precondition }}</pre>
          </el-descriptions-item>
        </el-descriptions>
      </el-tab-pane>

      <el-tab-pane :label="`歧义${ambiguities.length ? '(' + ambiguities.length + ')' : ''}`">
        <div v-if="ambiguities.length === 0" class="empty">无歧义标记</div>
        <el-alert
          v-for="(a, i) in ambiguities"
          :key="i"
          :title="a"
          type="warning"
          :closable="false"
          show-icon
          class="amb-item"
        />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watchEffect } from 'vue'
import type { useCaseStore } from '../stores/case'
import type { TestCase } from '../types'

const props = defineProps<{
  caseId: number
  store: ReturnType<typeof useCaseStore>
}>()

const loading = ref(false)
const detail = ref<TestCase | null>(null)

watchEffect(async () => {
  if (!props.caseId) return
  loading.value = true
  try {
    detail.value = await props.store.loadDetail(props.caseId)
  } finally {
    loading.value = false
  }
})

const steps = computed(() => (detail.value ? props.store.parseStructuredSteps(detail.value) : []))
const assertions = computed(() => (detail.value ? props.store.parseStructuredAssertions(detail.value) : []))
const ambiguities = computed(() => (detail.value ? props.store.parseAmbiguities(detail.value) : []))
</script>

<style scoped>
.case-detail {
  padding: 8px 24px;
  background: #fafbfc;
}
.empty {
  color: #909399;
  padding: 20px;
  text-align: center;
}
.step-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.step-target {
  color: #303030;
}
.step-value {
  color: #909399;
  font-size: 13px;
}
.assert-list {
  list-style: none;
  padding: 0;
}
.assert-list li {
  padding: 6px 0;
  display: flex;
  gap: 8px;
  align-items: center;
}
.raw-text {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  margin: 0;
}
.amb-item {
  margin-bottom: 8px;
}
</style>
