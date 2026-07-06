<template>
  <div class="import-page">
    <el-row :gutter="16">
      <!-- 导入 -->
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>
            <span><el-icon><Upload /></el-icon> 导入测试用例</span>
          </template>
          <el-form label-width="100px">
            <el-form-item label="Excel 路径">
              <el-input v-model="filePath" placeholder="例:/data/测试用例.xlsx" clearable />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="importing" @click="doImport" :disabled="!filePath.trim()">
                开始导入
              </el-button>
            </el-form-item>
          </el-form>

          <el-result v-if="importResult" icon="success" title="导入完成" sub-title="">
            <template #extra>
              <div class="result-stats">
                <el-statistic title="用例数" :value="importResult.cases" />
                <el-statistic title="项目数" :value="importResult.projects.length" />
                <el-statistic title="模块数" :value="importResult.modules.length" />
              </div>
              <div class="result-tags">
                <el-tag v-for="p in importResult.projects" :key="p" class="tag-item">{{ p }}</el-tag>
              </div>
            </template>
          </el-result>
        </el-card>
      </el-col>

      <!-- 解释 -->
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>
            <span><el-icon><MagicStick /></el-icon> LLM 解释(NL → 结构化)</span>
          </template>
          <el-alert
            type="info"
            :closable="false"
            show-icon
            title="对用例的原始自然语言步骤/预期进行结构化解释,产出可执行 steps + assertions"
            class="info-alert"
          />
          <el-form label-width="100px" class="interp-form">
            <el-form-item label="处理数量">
              <el-input-number v-model="limit" :min="1" :max="1000" :step="10" />
              <span class="hint">留空或 0 表示全部 pending(可能耗时较长)</span>
            </el-form-item>
            <el-form-item label="指定用例">
              <el-input v-model="caseIdsInput" placeholder="可选,逗号分隔 ID,如 1,2,3" />
            </el-form-item>
            <el-form-item>
              <el-button type="warning" :loading="interpreting" @click="doInterpret" :disabled="!canInterpret">
                开始解释
              </el-button>
              <el-button @click="pollRun" v-if="interpreting">轮询提示</el-button>
            </el-form-item>
          </el-form>

          <el-result v-if="interpretResult" icon="success" title="解释完成" sub-title="">
            <template #extra>
              <div class="result-stats">
                <el-statistic title="成功" :value="interpretResult.done" />
                <el-statistic title="失败" :value="interpretResult.failed" />
                <el-statistic title="跳过" :value="interpretResult.skipped" />
              </div>
            </template>
          </el-result>
        </el-card>
      </el-col>
    </el-row>

    <!-- 帮助说明 -->
    <el-card shadow="never" class="help-card">
      <template #header><span>使用说明</span></template>
      <ol class="help-list">
        <li><b>导入</b>:输入测试用例 Excel 的绝对路径,后端解析 Sheet1(用例)与 Sheet2(模块树)。</li>
        <li><b>解释</b>:导入后用例为 pending 状态。执行解释将调用 LLM 把自然语言步骤转为结构化 steps + assertions,并标注歧义。</li>
        <li>解释为异步批处理,可指定 limit 控制单次处理量。失败用例可重跑。</li>
        <li>完成后前往 <el-link type="primary" @click="$router.push('/cases')">用例库</el-link> 查看结构化结果。</li>
      </ol>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { importApi } from '../api'
import type { ImportResponse, InterpretResponse } from '../types'

const filePath = ref('')
const limit = ref(50)
const caseIdsInput = ref('')

const importing = ref(false)
const interpreting = ref(false)
const importResult = ref<ImportResponse | null>(null)
const interpretResult = ref<InterpretResponse | null>(null)

const canInterpret = computed(() => limit.value > 0 || caseIdsInput.value.trim().length > 0)

async function doImport(): Promise<void> {
  importing.value = true
  importResult.value = null
  try {
    const res = await importApi.import(filePath.value.trim())
    importResult.value = res
    ElMessage.success(`导入完成: ${res.cases} 条用例`)
  } catch (e: any) {
    ElMessage.error('导入失败: ' + (e?.message || e))
  } finally {
    importing.value = false
  }
}

async function doInterpret(): Promise<void> {
  interpreting.value = true
  interpretResult.value = null
  try {
    const ids = caseIdsInput.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => !Number.isNaN(n))
    const payload: { limit?: number; caseIds?: number[] } = {}
    if (ids.length) payload.caseIds = ids
    else payload.limit = limit.value || undefined
    const res = await importApi.interpret(payload)
    interpretResult.value = res
    ElMessage.success(`解释完成: 成功 ${res.done}, 失败 ${res.failed}, 跳过 ${res.skipped}`)
  } catch (e: any) {
    ElMessage.error('解释失败: ' + (e?.message || e))
  } finally {
    interpreting.value = false
  }
}

function pollRun(): void {
  ElMessage.info('解释为后端批处理任务,请稍后在用例库查看 interpretStatus 变化')
}
</script>

<style scoped>
.import-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.info-alert {
  margin-bottom: 16px;
}
.interp-form {
  margin-top: 10px;
}
.hint {
  margin-left: 10px;
  color: #909399;
  font-size: 12px;
}
.result-stats {
  display: flex;
  gap: 40px;
  justify-content: center;
  margin-bottom: 16px;
}
.result-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
}
.tag-item {
  margin: 0;
}
.help-card {
  margin-top: 4px;
}
.help-list {
  padding-left: 20px;
  line-height: 2;
  color: #606266;
}
</style>
