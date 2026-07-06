import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { caseApi } from '../api'
import type {
  CaseTree,
  ModuleNode,
  TestCaseSummary,
  TestCase,
  StructuredStep,
  StructuredAssertion
} from '../types'

/** 模块树节点(el-tree 用) */
export interface TreeNode {
  id: string
  label: string
  level: 0 | 1 | 2
  modulePath?: string
  children?: TreeNode[]
}

function buildTree(data: CaseTree): TreeNode[] {
  const roots: TreeNode[] = []
  for (const m of data.modules ?? []) {
    const mNode: TreeNode = {
      id: m.name,
      label: m.name,
      level: 0,
      children: (m.functions ?? []).map((fn) => {
        const fnNode: TreeNode = {
          id: `${m.name}/${fn.name}`,
          label: fn.name,
          level: 1,
          modulePath: `${m.name}/${fn.name}`,
          children: (fn.subfunctions ?? []).map((sf) => ({
            id: `${m.name}/${fn.name}/${sf}`,
            label: sf,
            level: 2,
            modulePath: `${m.name}/${fn.name}/${sf}`
          }))
        }
        return fnNode
      })
    }
    roots.push(mNode)
  }
  return roots
}

export const useCaseStore = defineStore('case', () => {
  const tree = ref<TreeNode[]>([])
  const cases = ref<TestCaseSummary[]>([])
  const total = ref(0)
  const loadingTree = ref(false)
  const loadingCases = ref(false)
  const loadingDetail = ref(false)
  const detailCache = ref<Record<number, TestCase>>({})

  /** 当前选中的用例(用于跨页面带到执行页) */
  const selectedIds = ref<number[]>([])

  const moduleList = computed<string[]>(() => {
    const names: string[] = []
    function walk(nodes: TreeNode[]) {
      for (const n of nodes) {
        if (n.level === 0) names.push(n.label)
        if (n.children) walk(n.children)
      }
    }
    walk(tree.value)
    return names
  })

  async function loadTree(): Promise<void> {
    loadingTree.value = true
    try {
      const data = await caseApi.tree()
      tree.value = buildTree(data)
    } finally {
      loadingTree.value = false
    }
  }

  async function loadCases(params: {
    project?: string
    q?: string
    limit?: number
    offset?: number
    modulePath?: string
  }): Promise<void> {
    loadingCases.value = true
    try {
      const data = await caseApi.list(params)
      cases.value = data.cases ?? []
      total.value = data.total ?? 0
    } finally {
      loadingCases.value = false
    }
  }

  async function loadDetail(id: number): Promise<TestCase> {
    if (detailCache.value[id]) return detailCache.value[id]
    loadingDetail.value = true
    try {
      const { case: c } = await caseApi.detail(id)
      detailCache.value = { ...detailCache.value, [id]: c }
      return c
    } finally {
      loadingDetail.value = false
    }
  }

  function setSelected(ids: number[]): void {
    selectedIds.value = [...ids]
  }

  function clearSelected(): void {
    selectedIds.value = []
  }

  function parseStructuredSteps(c: TestCase): StructuredStep[] {
    if (!c.structuredSteps) return []
    try {
      const v = JSON.parse(c.structuredSteps)
      return Array.isArray(v) ? (v as StructuredStep[]) : []
    } catch {
      return []
    }
  }

  function parseStructuredAssertions(c: TestCase): StructuredAssertion[] {
    if (!c.structuredAssertions) return []
    try {
      const v = JSON.parse(c.structuredAssertions)
      return Array.isArray(v) ? (v as StructuredAssertion[]) : []
    } catch {
      return []
    }
  }

  function parseAmbiguities(c: TestCase): string[] {
    if (!c.ambiguities) return []
    try {
      const v = JSON.parse(c.ambiguities)
      return Array.isArray(v) ? (v as string[]) : []
    } catch {
      return []
    }
  }

  return {
    tree,
    cases,
    total,
    loadingTree,
    loadingCases,
    loadingDetail,
    detailCache,
    selectedIds,
    moduleList,
    loadTree,
    loadCases,
    loadDetail,
    setSelected,
    clearSelected,
    parseStructuredSteps,
    parseStructuredAssertions,
    parseAmbiguities
  }
})
