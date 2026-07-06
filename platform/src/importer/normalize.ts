/**
 * xlsx 行归一化:向下继承 / 表头跳过 / 优先级与测试方法归一 / 全局 key / 脱敏。
 *
 * 16 列含义:
 * 0 用例ID / 1 项目 / 2 端口 / 3 模块 / 4 功能 / 5 子功能 / 6 优先级
 * 7 测试方法 / 8 用例标题 / 9 前置条件 / 10 测试数据 / 11 测试步骤
 * 12 预期结果 / 13 编写人 / 14 执行结果 / 15 备注
 */

import { createHash } from 'node:crypto'

/** 归一化后的用例记录。 */
export interface TestCaseRecord {
  /** 全局唯一 key(项目+功能+原始ID,或 h+hash) */
  globalKey: string
  project: string
  port: string
  module: string
  func: string
  subfunc: string
  /** 模块/功能/子功能 拼接的路径,如 "登录/忘记密码" */
  modulePath: string
  priority: 'high' | 'normal' | 'low'
  testMethod: string
  title: string
  precondition: string
  /** 已脱敏的测试数据 */
  testData: string
  rawSteps: string
  rawExpected: string
  author: string
  /** 源数据行号(1 基),由导入方回填 */
  sourceRow?: number
  /** 原始行 JSON 快照 */
  rawSnapshot: string
}

/** 用例行继承上下文(函数会就地更新,供下一行使用)。 */
export interface CaseRowCtx {
  project?: string
  module?: string
  func?: string
  port?: string
}

export type MenuLevel = 'module' | 'function' | 'subfunction'

/** 菜单树节点(来自 Sheet2)。 */
export interface MenuNode {
  level: MenuLevel
  name: string
}

/** 菜单行继承上下文(函数会就地更新)。 */
export interface MenuRowCtx {
  module?: string
  func?: string
}

const HEADER_ID = '用例ID'

/** 取单元格并 trim,越界/undefined 返回 ''。 */
function cell(row: string[], idx: number): string {
  const v = row[idx]
  return v === undefined ? '' : v.trim()
}

/** 优先级归一:高/1→high,中/2→normal,低/3→low,空/未知→normal。 */
function normalizePriority(raw: string): 'high' | 'normal' | 'low' {
  const v = raw.trim()
  if (v === '高' || v === '1') return 'high'
  if (v === '低' || v === '3') return 'low'
  if (v === '中' || v === '2') return 'normal'
  return 'normal'
}

/** 测试方法同义归一;其余保留原名。 */
function normalizeMethod(raw: string): string {
  const v = raw.trim()
  if (v === '边界值' || v === '边界值分析法') return '边界值'
  if (v === '错误推断法' || v === '错误推断') return '错误推断'
  return v
}

/**
 * 测试数据脱敏:
 * - 手机号 1[3-9]\d{9} → 1**********
 * - 身份证 \d{17}[\dXx](18 位) → 前6 + * + 后4
 * - 银行卡 \d{16,19} → 前4 + * + 后4
 *
 * 用 \b 词边界避免在更长数字串里误匹配;身份证先于银行卡处理。
 */
function desensitize(text: string): string {
  if (!text) return text
  let out = text.replace(/\b1[3-9]\d{9}\b/g, '1**********')
  out = out.replace(/\b\d{17}[\dXx]\b/g, (m) => m.slice(0, 6) + '*'.repeat(m.length - 10) + m.slice(-4))
  out = out.replace(/\b\d{16,19}\b/g, (m) => m.slice(0, 4) + '*'.repeat(m.length - 8) + m.slice(-4))
  return out
}

/**
 * 归一化一行用例数据。
 *
 * - 项目/端口/模块/功能 空值继承 ctx 上一行值,并回填 ctx。
 * - 跳过表头(row[0]==='用例ID')及无 ID 且无标题的空行,返回 null。
 * - 生成全局 key;test_data 脱敏。
 *
 * @param row 16 列原始行(可更长,只取 0..15)
 * @param ctx 继承上下文(就地更新)
 */
export function normalizeCaseRow(row: string[], ctx: CaseRowCtx): TestCaseRecord | null {
  const rawId = cell(row, 0)

  // 跳过内嵌表头
  if (rawId === HEADER_ID) return null

  const rawProject = cell(row, 1)
  const rawPort = cell(row, 2)
  const rawModule = cell(row, 3)
  const rawFunc = cell(row, 4)
  const subfunc = cell(row, 5)
  const title = cell(row, 8)

  // 无 ID 且无标题 → 视为空行,丢弃
  if (!rawId && !title) return null

  // 向下继承:空值用 ctx 上一行值
  const project = rawProject || ctx.project || ''
  const port = rawPort || ctx.port || ''
  const module_ = rawModule || ctx.module || ''
  const func = rawFunc || ctx.func || ''

  // 回填 ctx 供下一行使用
  if (rawProject) ctx.project = rawProject
  if (rawPort) ctx.port = rawPort
  if (rawModule) ctx.module = rawModule
  if (rawFunc) ctx.func = rawFunc

  const priority = normalizePriority(cell(row, 6))
  const testMethod = normalizeMethod(cell(row, 7))
  const precondition = cell(row, 9)
  const testData = desensitize(cell(row, 10))
  const rawSteps = cell(row, 11)
  const rawExpected = cell(row, 12)
  const author = cell(row, 13)

  const modulePath = [module_, func, subfunc].filter(Boolean).join('/')

  // 全局 key:项目|功能|子功能|原始ID|短hash(title+steps)
  // 含 subfunc 并追加 hash,避免按子功能重置的 ID 在 INSERT OR IGNORE 时丢用例
  const hash = createHash('sha1').update(title + rawSteps).digest('hex').slice(0, 8)
  const idPart = rawId || 'h'
  const globalKey = `${project}|${func}|${subfunc}|${idPart}|${hash}`

  return {
    globalKey,
    project,
    port,
    module: module_,
    func,
    subfunc,
    modulePath,
    priority,
    testMethod,
    title,
    precondition,
    testData,
    rawSteps,
    rawExpected,
    author,
    rawSnapshot: JSON.stringify(row),
  }
}

/**
 * 归一化一行菜单树数据(Sheet2,3 列:模块/功能/子功能)。
 *
 * 空单元格继承上一行;按"最深非空原始单元格"判定本行层级:
 * - col2 非空 → subfunction
 * - col1 非空 → function
 * - col0 非空 → module
 * - 全空 → null
 *
 * 新模块出现时重置 func 上下文,避免跨模块串继承。
 *
 * @param row 3 列原始行
 * @param ctx 继承上下文(就地更新)
 */
export function normalizeMenuRow(row: string[], ctx: MenuRowCtx): MenuNode | null {
  const rawModule = cell(row, 0)
  const rawFunc = cell(row, 1)
  const rawSub = cell(row, 2)

  // 跳过表头
  if (rawModule === '模块' && rawFunc === '功能' && rawSub === '子功能') return null

  if (rawModule) {
    ctx.module = rawModule
    ctx.func = undefined // 新模块重置功能上下文
  }
  if (rawFunc) ctx.func = rawFunc

  if (rawSub) return { level: 'subfunction', name: rawSub }
  if (rawFunc) return { level: 'function', name: rawFunc }
  if (rawModule) return { level: 'module', name: rawModule }
  return null
}
