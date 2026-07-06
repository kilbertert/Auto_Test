import { sqlite } from '../db/client.js'

/**
 * 元素定位层 — page object + 别名词典(§8)。
 * 持久化到 page_object / element_alias 表,better-sqlite3 同步参数化查询。
 */

/** page_object 行(按 URL 模式归组页面)。 */
export interface PageObjectRow {
  id: number
  urlPattern: string | null
  name: string | null
  description: string | null
}

/** element_alias 行(alias → locator 映射,带失败计数与确认标志)。 */
export interface ElementAliasRow {
  id: number
  pageObjectId: number | null
  alias: string | null
  locator: string | null
  locatorType: string | null
  source: string
  failCount: number
  confirmed: number
  createdAt: string | null
  updatedAt: string | null
}

/** 别名来源(与 schema 默认值一致)。 */
export type AliasSource = 'manual' | 'import' | 'auto-learned'

/** element_alias 行的 camelCase 投影列(供 SELECT 复用)。 */
const ALIAS_COLUMNS = [
  'id',
  'page_object_id AS pageObjectId',
  'alias',
  'locator',
  'locator_type AS locatorType',
  'source',
  'fail_count AS failCount',
  'confirmed',
  'created_at AS createdAt',
  'updated_at AS updatedAt',
].join(', ')

/**
 * 确保某 url_pattern 对应的 page_object 存在,返回其 id。
 * INSERT OR IGNORE 后再查 id,天然容忍并发插入竞争。
 */
export function ensurePageObject(urlPattern: string, name?: string): number {
  sqlite
    .prepare('INSERT OR IGNORE INTO page_object (url_pattern, name) VALUES (?, ?)')
    .run(urlPattern, name ?? null)
  const row = sqlite
    .prepare('SELECT id FROM page_object WHERE url_pattern = ?')
    .get(urlPattern) as { id: number } | undefined
  if (!row) {
    // 理论上 INSERT OR IGNORE 后必定能查到;兜底防御。
    throw new Error('ensurePageObject: 插入/查询 page_object 失败 urlPattern=' + urlPattern)
  }
  return row.id
}

/**
 * 按 url + alias 查别名词典。
 * url 匹配规则:page_object.url_pattern 作为 url 的前缀(startsWith),
 * 多个命中时取最长(最具体)的 url_pattern,再按 alias 精确查找。
 * 用 JS startsWith 而非 SQL LIKE,避免 url_pattern 中的 `_`/`%` 被当作通配符。
 */
export function getAliasByUrl(url: string, alias: string): ElementAliasRow | null {
  const pageObjects = sqlite
    .prepare('SELECT id, url_pattern AS urlPattern, name, description FROM page_object')
    .all() as PageObjectRow[]

  const best = pageObjects
    .filter((po) => Boolean(po.urlPattern) && url.startsWith(po.urlPattern as string))
    .sort((a, b) => (b.urlPattern?.length ?? 0) - (a.urlPattern?.length ?? 0))[0]

  if (!best) return null

  const row = sqlite
    .prepare(
      `SELECT ${ALIAS_COLUMNS} FROM element_alias WHERE page_object_id = ? AND alias = ? LIMIT 1`,
    )
    .get(best.id, alias) as ElementAliasRow | undefined
  return row ?? null
}

/**
 * 写入/更新别名。
 * schema 未对 (page_object_id, alias) 加唯一约束,故采用 UPDATE-then-INSERT:
 * 已存在则更新(保留 fail_count/confirmed),不存在则插入。
 */
export function upsertAlias(
  pageObjectId: number,
  alias: string,
  locator: string,
  locatorType: string,
  source: AliasSource,
): void {
  const now = new Date().toISOString()
  const updated = sqlite
    .prepare(
      `UPDATE element_alias
       SET locator = ?, locator_type = ?, source = ?, updated_at = ?
       WHERE page_object_id = ? AND alias = ?`,
    )
    .run(locator, locatorType, source, now, pageObjectId, alias)

  if (updated.changes === 0) {
    sqlite
      .prepare(
        `INSERT INTO element_alias
           (page_object_id, alias, locator, locator_type, source, fail_count, confirmed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      )
      .run(pageObjectId, alias, locator, locatorType, source, now, now)
  }
}

/** 别名定位失败计数 +1(供自愈/人工维护阈值判定)。 */
export function incrementAliasFail(pageObjectId: number, alias: string): void {
  const now = new Date().toISOString()
  sqlite
    .prepare(
      `UPDATE element_alias SET fail_count = fail_count + 1, updated_at = ?
       WHERE page_object_id = ? AND alias = ?`,
    )
    .run(now, pageObjectId, alias)
}

/** 列出某 page_object 下全部别名(按 alias 排序)。 */
export function listAliases(pageObjectId: number): ElementAliasRow[] {
  return sqlite
    .prepare(
      `SELECT ${ALIAS_COLUMNS} FROM element_alias WHERE page_object_id = ? ORDER BY alias`,
    )
    .all(pageObjectId) as ElementAliasRow[]
}
