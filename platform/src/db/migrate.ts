import { sqlite } from './client.js'

/**
 * 建表迁移:为全部 13 张表执行 CREATE TABLE IF NOT EXISTS。
 * 列定义与 schema.ts 保持完全一致(含 CHECK 约束 / 默认值 / 外键)。
 *
 * 幂等:重复调用安全。不删除已有数据。
 */
export function runMigrate(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS project (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS module_tree (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER REFERENCES module_tree(id),
      level TEXT NOT NULL CHECK(level IN ('module','function','subfunction')),
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS test_case (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      global_key TEXT NOT NULL UNIQUE,
      project_id INTEGER REFERENCES project(id),
      module_path TEXT,
      title TEXT,
      priority TEXT,
      test_method TEXT,
      precondition TEXT,
      test_data TEXT,
      raw_steps TEXT,
      raw_expected TEXT,
      author TEXT,
      source_row INTEGER,
      raw_snapshot TEXT,
      structured_steps TEXT,
      structured_assertions TEXT,
      interpret_version INTEGER DEFAULT 0,
      interpret_status TEXT DEFAULT 'pending',
      confidence REAL,
      ambiguities TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS test_step (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER REFERENCES test_case(id) ON DELETE CASCADE,
      order_no INTEGER,
      action TEXT,
      target_description TEXT,
      locator TEXT,
      value TEXT,
      raw_text TEXT,
      confidence REAL
    );

    CREATE TABLE IF NOT EXISTS assertion (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER REFERENCES test_case(id) ON DELETE CASCADE,
      kind TEXT,
      target TEXT,
      locator TEXT,
      expected TEXT,
      raw_text TEXT,
      confidence REAL
    );

    CREATE TABLE IF NOT EXISTS page_object (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url_pattern TEXT,
      name TEXT,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS element_alias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_object_id INTEGER REFERENCES page_object(id),
      alias TEXT,
      locator TEXT,
      locator_type TEXT,
      source TEXT DEFAULT 'manual',
      fail_count INTEGER DEFAULT 0,
      confirmed INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      suite_spec TEXT,
      status TEXT,
      config TEXT,
      checkpoint_run_id TEXT,
      started_at TEXT,
      ended_at TEXT,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS run_case (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER REFERENCES run(id),
      case_id INTEGER REFERENCES test_case(id),
      status TEXT,
      started_at TEXT,
      ended_at TEXT,
      error TEXT,
      retry_count INTEGER DEFAULT 0,
      agent_used TEXT
    );

    CREATE TABLE IF NOT EXISTS run_step (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_case_id INTEGER REFERENCES run_case(id),
      step_id INTEGER,
      status TEXT,
      actual TEXT,
      screenshot_path TEXT,
      error TEXT,
      duration_ms INTEGER,
      locator_used TEXT
    );

    CREATE TABLE IF NOT EXISTS assertion_result (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_case_id INTEGER REFERENCES run_case(id),
      assertion_id INTEGER REFERENCES assertion(id),
      pass INTEGER,
      actual TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS test_report (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER REFERENCES run(id),
      summary TEXT,
      details TEXT,
      html_path TEXT,
      generated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS oma_memory (
      key TEXT PRIMARY KEY,
      value TEXT,
      metadata TEXT,
      created_at TEXT,
      expires_at_turn INTEGER
    );
  `)
}
