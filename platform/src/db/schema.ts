import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, real, check } from 'drizzle-orm/sqlite-core'

/**
 * 1. project — 顶层被测项目
 */
export const project = sqliteTable('project', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
})

/**
 * 2. module_tree — 用例所属的模块树(自引用)
 */
export const moduleTree = sqliteTable(
  'module_tree',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    parentId: integer('parent_id'),
    level: text('level').notNull(),
    name: text('name').notNull(),
  },
  (table) => [
    check(
      'module_tree_level_check',
      sql`${table.level} IN ('module', 'function', 'subfunction')`,
    ),
  ],
)

/**
 * 3. test_case — 测试用例(原始快照 + 结构化解读结果)
 */
export const testCase = sqliteTable('test_case', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  globalKey: text('global_key').notNull().unique(),
  projectId: integer('project_id').references(() => project.id),
  modulePath: text('module_path'),
  title: text('title'),
  priority: text('priority'),
  testMethod: text('test_method'),
  precondition: text('precondition'),
  testData: text('test_data'),
  rawSteps: text('raw_steps'),
  rawExpected: text('raw_expected'),
  author: text('author'),
  sourceRow: integer('source_row'),
  rawSnapshot: text('raw_snapshot'),
  structuredSteps: text('structured_steps'),
  structuredAssertions: text('structured_assertions'),
  interpretVersion: integer('interpret_version').default(0),
  interpretStatus: text('interpret_status').default('pending'),
  confidence: real('confidence'),
  ambiguities: text('ambiguities'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
})

/**
 * 4. test_step — 用例的步骤(结构化)
 */
export const testStep = sqliteTable('test_step', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  caseId: integer('case_id').references(() => testCase.id, { onDelete: 'cascade' }),
  orderNo: integer('order_no'),
  action: text('action'),
  targetDescription: text('target_description'),
  locator: text('locator'),
  value: text('value'),
  rawText: text('raw_text'),
  confidence: real('confidence'),
})

/**
 * 5. assertion — 用例的断言(结构化)
 */
export const assertion = sqliteTable('assertion', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  caseId: integer('case_id').references(() => testCase.id, { onDelete: 'cascade' }),
  kind: text('kind'),
  target: text('target'),
  locator: text('locator'),
  expected: text('expected'),
  rawText: text('raw_text'),
  confidence: real('confidence'),
})

/**
 * 6. page_object — 页面对象(按 URL 模式归组元素)
 */
export const pageObject = sqliteTable('page_object', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  urlPattern: text('url_pattern'),
  name: text('name'),
  description: text('description'),
})

/**
 * 7. element_alias — 元素定位别名(可自愈,带失败计数与确认标志)
 */
export const elementAlias = sqliteTable('element_alias', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pageObjectId: integer('page_object_id').references(() => pageObject.id),
  alias: text('alias'),
  locator: text('locator'),
  locatorType: text('locator_type'),
  source: text('source').default('manual'),
  failCount: integer('fail_count').default(0),
  confirmed: integer('confirmed').default(0),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
})

/**
 * 8. run — 一次测试执行批次
 */
export const run = sqliteTable('run', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name'),
  suiteSpec: text('suite_spec'),
  status: text('status'),
  config: text('config'),
  checkpointRunId: text('checkpoint_run_id'),
  startedAt: text('started_at'),
  endedAt: text('ended_at'),
  summary: text('summary'),
})

/**
 * 9. run_case — 批次内单个用例的执行记录
 */
export const runCase = sqliteTable('run_case', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id').references(() => run.id),
  caseId: integer('case_id').references(() => testCase.id),
  status: text('status'),
  startedAt: text('started_at'),
  endedAt: text('ended_at'),
  error: text('error'),
  retryCount: integer('retry_count').default(0),
  agentUsed: text('agent_used'),
})

/**
 * 10. run_step — 批次内单步执行记录
 */
export const runStep = sqliteTable('run_step', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runCaseId: integer('run_case_id').references(() => runCase.id),
  stepId: integer('step_id'),
  status: text('status'),
  actual: text('actual'),
  screenshotPath: text('screenshot_path'),
  error: text('error'),
  durationMs: integer('duration_ms'),
  locatorUsed: text('locator_used'),
})

/**
 * 11. assertion_result — 断言执行结果
 */
export const assertionResult = sqliteTable('assertion_result', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runCaseId: integer('run_case_id').references(() => runCase.id),
  assertionId: integer('assertion_id').references(() => assertion.id),
  pass: integer('pass'),
  actual: text('actual'),
  error: text('error'),
})

/**
 * 12. test_report — 测试报告
 */
export const testReport = sqliteTable('test_report', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id').references(() => run.id),
  summary: text('summary'),
  details: text('details'),
  htmlPath: text('html_path'),
  generatedAt: text('generated_at'),
})

/**
 * 13. oma_memory — OMA agent 记忆存储(按 turn 过期)
 */
export const omaMemory = sqliteTable('oma_memory', {
  key: text('key').primaryKey(),
  value: text('value'),
  metadata: text('metadata'),
  createdAt: text('created_at'),
  expiresAtTurn: integer('expires_at_turn'),
})
