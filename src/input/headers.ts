import { normalizeHeaderKey } from './text.js'

export type CanonicalColumn =
  | 'caseId'
  | 'project'
  | 'port'
  | 'module'
  | 'function'
  | 'subfunction'
  | 'title'
  | 'precondition'
  | 'testData'
  | 'steps'
  | 'expected'
  | 'priority'
  | 'dependencies'
  | 'authProfile'
  | 'tags'
  | 'cleanup'
  | 'risk'
  | 'method'
  | 'author'
  | 'result'
  | 'notes'

const ALIASES: Record<CanonicalColumn, readonly string[]> = {
  caseId: ['用例ID', '用例编号', '案例ID', 'case id', 'caseid', 'id'],
  project: ['项目', '项目名称'],
  port: ['端口', '终端', '测试端'],
  module: ['模块', '模块路径', '功能模块'],
  function: ['功能', '一级功能'],
  subfunction: ['子功能', '二级功能'],
  title: ['用例标题', '标题', '测试标题', '案例标题'],
  precondition: ['前置条件', '前提条件', '执行前提'],
  testData: ['测试数据', '数据', '输入数据'],
  steps: ['测试步骤', '步骤', '操作步骤', '执行步骤'],
  expected: ['预期结果', '期望结果', '预期', '期望'],
  priority: ['优先级', 'priority'],
  dependencies: ['依赖用例', '前置用例', '依赖案例'],
  authProfile: ['账号角色', '认证角色', '登录角色'],
  tags: ['标签', 'tag', 'tags'],
  cleanup: ['清理步骤', '恢复步骤', '后置步骤'],
  risk: ['风险等级', '风险级别', 'risk'],
  method: ['测试方法', '用例方法'],
  author: ['编写人', '作者', '创建人'],
  result: ['执行结果', '测试结果'],
  notes: ['备注', '说明'],
}

const LOOKUP = new Map<string, CanonicalColumn>()
for (const [canonical, aliases] of Object.entries(ALIASES) as Array<[CanonicalColumn, readonly string[]]>) {
  for (const alias of aliases) LOOKUP.set(normalizeHeaderKey(alias), canonical)
}

export const REQUIRED_COLUMNS: readonly CanonicalColumn[] = ['caseId', 'title', 'steps', 'expected']
export const HIERARCHY_COLUMNS: readonly CanonicalColumn[] = ['project', 'port', 'module', 'function', 'subfunction']

export function resolveHeader(value: string): CanonicalColumn | undefined {
  return LOOKUP.get(normalizeHeaderKey(value))
}

export function aliasesFor(column: CanonicalColumn): readonly string[] {
  return ALIASES[column]
}
