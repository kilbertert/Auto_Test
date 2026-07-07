import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 默认 xlsx 路径:仓库根目录下的 测试用例.xlsx。
 * 用 import.meta.url 相对本文件定位(本文件在 platform/src/importer/,上溯 3 级到仓库根),
 * 跨平台(Linux/macOS/Windows),不依赖 cwd 或硬编码绝对路径。
 * 可被 process.env.XLSX_PATH 或命令行参数覆盖。
 */
export const DEFAULT_XLSX_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../测试用例.xlsx',
)
