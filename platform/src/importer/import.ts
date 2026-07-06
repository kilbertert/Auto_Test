/**
 * xlsx 导入落库:解析 → 归一 → 事务写入 project / test_case / module_tree。
 *
 * 依赖 ../db/client.js 导出的 better-sqlite3 实例 `sqlite`(由调用方确保已 migrate)。
 * 表结构对齐 技术设计文档 §10.1:
 *   project(id, name)
 *   module_tree(id, parent_id, level, name)          -- 模块/功能/子功能 三级树
 *   test_case(id, global_key UNIQUE, project_id, module_path, title, priority,
 *             test_method, precondition, test_data, raw_steps, raw_expected,
 *             author, source_row, raw_snapshot, structured_steps, structured_assertions,
 *             interpret_version, interpret_status, confidence, ambiguities,
 *             created_at, updated_at)
 */

import { sqlite } from '../db/client.js'
import { parseXlsx } from './xlsx-xml.js'
import { normalizeCaseRow, normalizeMenuRow, type CaseRowCtx, type MenuRowCtx, type MenuLevel } from './normalize.js'

export interface ImportResult {
  /** 本次实际插入的 test_case 数(INSERT OR IGNORE 去重后) */
  cases: number
  /** 涉及的项目数 */
  projects: number
  /** 本次实际插入的 module_tree 节点数 */
  modules: number
}

interface ProjectRow {
  id: number
}

interface ModuleTreeRow {
  id: number
  parent_id: number | null
  level: string
  name: string
}

const INSERT_PROJECT = 'INSERT OR IGNORE INTO project (name) VALUES (?)'
const SELECT_PROJECT_ID = 'SELECT id FROM project WHERE name = ?'

const INSERT_TEST_CASE = `INSERT OR IGNORE INTO test_case (
  global_key, project_id, module_path, title, priority, test_method,
  precondition, test_data, raw_steps, raw_expected, author, source_row,
  raw_snapshot, structured_steps, structured_assertions,
  interpret_version, interpret_status, confidence, ambiguities,
  created_at, updated_at
) VALUES (
  @globalKey, @projectId, @modulePath, @title, @priority, @testMethod,
  @precondition, @testData, @rawSteps, @rawExpected, @author, @sourceRow,
  @rawSnapshot, NULL, NULL,
  0, 'pending', NULL, NULL,
  @now, @now
)`

const INSERT_MODULE_NODE = 'INSERT INTO module_tree (parent_id, level, name) VALUES (?, ?, ?)'
const SELECT_MODULE_NODES = 'SELECT id, parent_id, level, name FROM module_tree'

/** 找到用例 sheet:首列含表头 "用例ID" 的 sheet;否则回退第一个 sheet。 */
function findCasesSheet(sheets: { name: string; rows: string[][] }[]): { name: string; rows: string[][] } {
  return (
    sheets.find((s) => s.rows.some((r) => (r[0] ?? '').trim() === '用例ID')) ??
    sheets[0] ??
    { name: '', rows: [] }
  )
}

/** 找到菜单 sheet:列数 <=3 且非用例 sheet;否则回退第二个 sheet。 */
function findMenuSheet(
  sheets: { name: string; rows: string[][] }[],
  casesSheet: { name: string; rows: string[][] },
): { name: string; rows: string[][] } {
  const menu = sheets.find(
    (s) => s !== casesSheet && s.rows.every((r) => r.length <= 3),
  )
  return menu ?? sheets[1] ?? { name: '', rows: [] }
}

/**
 * 导入 xlsx 到数据库。
 *
 * @param filePath xlsx 文件路径
 * @param clearFirst 导入前是否清空 test_case / module_tree(默认 false,靠 global_key 去重)
 */
export async function importXlsx(
  filePath: string,
  clearFirst = false,
): Promise<ImportResult> {
  const parsed = parseXlsx(filePath)
  const casesSheet = findCasesSheet(parsed.sheets)
  const menuSheet = findMenuSheet(parsed.sheets, casesSheet)

  return sqlite.transaction((): ImportResult => {
    if (clearFirst) {
      sqlite.exec('DELETE FROM test_case')
      sqlite.exec('DELETE FROM module_tree')
    }

    const now = new Date().toISOString()

    const insertProject = sqlite.prepare(INSERT_PROJECT)
    const selectProjectId = sqlite.prepare(SELECT_PROJECT_ID)
    const projectIdCache = new Map<string, number>()
    const ensureProject = (name: string): number => {
      const resolved = name || '未分类'
      const cached = projectIdCache.get(resolved)
      if (cached !== undefined) return cached
      insertProject.run(resolved)
      const row = selectProjectId.get(resolved) as ProjectRow | undefined
      const id = row?.id ?? 0
      projectIdCache.set(resolved, id)
      return id
    }

    // ---- test_case ----
    const insertCase = sqlite.prepare(INSERT_TEST_CASE)
    let casesInserted = 0
    const projectSet = new Set<string>()
    const caseCtx: CaseRowCtx = {}
    const caseRows = casesSheet.rows
    for (let i = 0; i < caseRows.length; i++) {
      // 只取权威 16 列,丢弃 col[16..] 编辑残留
      const row16 = caseRows[i].slice(0, 16)
      const rec = normalizeCaseRow(row16, caseCtx)
      if (!rec) continue
      rec.sourceRow = i + 1

      const projectId = ensureProject(rec.project)
      projectSet.add(rec.project || '未分类')

      const info = insertCase.run({
        globalKey: rec.globalKey,
        projectId,
        modulePath: rec.modulePath,
        title: rec.title,
        priority: rec.priority,
        testMethod: rec.testMethod,
        precondition: rec.precondition,
        testData: rec.testData,
        rawSteps: rec.rawSteps,
        rawExpected: rec.rawExpected,
        author: rec.author,
        sourceRow: rec.sourceRow,
        rawSnapshot: rec.rawSnapshot,
        now,
      })
      casesInserted += info.changes
    }

    // ---- module_tree(Sheet2 菜单树,带 parent-child) ----
    const insertNode = sqlite.prepare(INSERT_MODULE_NODE)
    const selectNodes = sqlite.prepare(SELECT_MODULE_NODES)
    const nodeMap = new Map<string, number>()
    for (const r of selectNodes.all() as ModuleTreeRow[]) {
      nodeMap.set(nodeKey(r.parent_id, r.level, r.name), r.id)
    }

    let modulesInserted = 0
    const getOrCreateNode = (parentId: number | null, level: MenuLevel, name: string): number => {
      const key = nodeKey(parentId, level, name)
      const existingId = nodeMap.get(key)
      if (existingId !== undefined) return existingId
      const info = insertNode.run(parentId, level, name)
      const id = Number(info.lastInsertRowid)
      nodeMap.set(key, id)
      modulesInserted += 1
      return id
    }

    // 遍历菜单树:按继承上下文确保 module/function 祖先节点存在,
    // subfunction 挂到 function 节点下(function 缺失则挂到 module)。
    // 菜单数据多为"路径式"行(模块/功能/子功能 同时填),故祖先节点需隐式创建。
    const menuCtx: MenuRowCtx = {}
    for (const row of menuSheet.rows) {
      const node = normalizeMenuRow(row, menuCtx)
      if (!node) continue
      const moduleName = menuCtx.module
      if (!moduleName) continue // 无模块上下文,丢弃避免孤儿
      const moduleId = getOrCreateNode(null, 'module', moduleName)
      let funcId: number | null = null
      if (menuCtx.func) {
        funcId = getOrCreateNode(moduleId, 'function', menuCtx.func)
      }
      if (node.level === 'subfunction') {
        const parent = funcId ?? moduleId
        getOrCreateNode(parent, 'subfunction', node.name)
      }
      // module / function 层级的节点已由上方 getOrCreateNode 创建
    }

    return {
      cases: casesInserted,
      projects: projectSet.size,
      modules: modulesInserted,
    }
  })()
}

/** module_tree 节点去重键:parentId|level|name(NULL → 'NULL')。 */
function nodeKey(parentId: number | null, level: string, name: string): string {
  return `${parentId === null ? 'NULL' : parentId}|${level}|${name}`
}
