import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'Home',
    component: () => import('../views/Home.vue'),
    meta: { title: '首页' }
  },
  {
    path: '/cases',
    name: 'Cases',
    component: () => import('../views/Cases.vue'),
    meta: { title: '用例库' }
  },
  {
    path: '/execute',
    name: 'Execute',
    component: () => import('../views/Execute.vue'),
    meta: { title: '执行' }
  },
  {
    path: '/reports',
    name: 'Reports',
    component: () => import('../views/Reports.vue'),
    meta: { title: '报告' }
  },
  {
    path: '/import',
    name: 'Import',
    component: () => import('../views/Import.vue'),
    meta: { title: '导入' }
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

export default router
