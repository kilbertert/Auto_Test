import { runMigrate } from '../db/migrate.js'
import { importXlsx } from '../importer/import.js'

/** 导入 xlsx 到数据库:npm run import [xlsx路径](默认 测试用例.xlsx) */
async function main(): Promise<void> {
  const xlsxPath = process.argv[2] ?? '/home/ranlei/Auto-Test/测试用例.xlsx'
  console.log('[import] 运行数据库迁移...')
  runMigrate()
  console.log(`[import] 导入 ${xlsxPath} ...`)
  const result = await importXlsx(xlsxPath, true)
  console.log('[import] 完成:', result)
}

void main().catch((e) => {
  console.error('[import] 失败:', e)
  process.exit(1)
})
