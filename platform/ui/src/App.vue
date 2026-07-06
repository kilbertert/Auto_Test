<template>
  <div id="app">
    <el-container class="layout-container">
      <el-aside width="210px" class="layout-aside">
        <div class="logo">
          <el-icon :size="22"><Monitor /></el-icon>
          <span>自动化测试平台</span>
        </div>
        <el-menu
          :default-active="$route.path"
          router
          class="layout-menu"
          background-color="#304156"
          text-color="#bfcbd9"
          active-text-color="#409eff"
        >
          <el-menu-item index="/">
            <el-icon><House /></el-icon>
            <span>首页</span>
          </el-menu-item>
          <el-menu-item index="/cases">
            <el-icon><Document /></el-icon>
            <span>用例库</span>
          </el-menu-item>
          <el-menu-item index="/execute">
            <el-icon><VideoPlay /></el-icon>
            <span>执行</span>
          </el-menu-item>
          <el-menu-item index="/reports">
            <el-icon><DataAnalysis /></el-icon>
            <span>报告</span>
          </el-menu-item>
          <el-menu-item index="/import">
            <el-icon><FolderOpened /></el-icon>
            <span>导入</span>
          </el-menu-item>
        </el-menu>
      </el-aside>

      <el-container>
        <el-header class="layout-header">
          <div class="header-left">
            <h2>{{ pageTitle }}</h2>
          </div>
          <div class="header-right">
            <el-tag
              v-if="runStore.isRunning"
              type="success"
              effect="dark"
              size="small"
            >
              运行中:{{ runStore.currentRunId?.slice(0, 8) }}
            </el-tag>
            <el-tag
              v-else
              type="info"
              size="small"
            >
              空闲
            </el-tag>
          </div>
        </el-header>

        <el-main class="layout-main">
          <router-view />
        </el-main>
      </el-container>
    </el-container>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useRunStore } from './stores/run'

const route = useRoute()
const runStore = useRunStore()

const pageTitle = computed(() => {
  const title = route.meta.title as string | undefined
  return title || '自动化测试平台'
})
</script>

<style scoped>
.layout-container {
  height: 100%;
}

.layout-aside {
  background-color: #304156;
  overflow-y: auto;
}

.logo {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 16px;
  font-weight: bold;
  color: #fff;
  border-bottom: 1px solid #3d4a5c;
  white-space: nowrap;
}

.layout-menu {
  border-right: none;
}

.layout-menu .el-menu-item:hover {
  background-color: #263445 !important;
}

.layout-header {
  background-color: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  box-shadow: 0 1px 4px rgba(0, 21, 41, 0.08);
}

.header-left h2 {
  font-size: 18px;
  font-weight: 500;
  color: #333;
}

.layout-main {
  background-color: #f5f7fa;
  padding: 20px;
}
</style>
