import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 极简 .env 加载器(无第三方依赖):若项目根存在 .env,则解析并注入 process.env,
 * 不覆盖已存在的环境变量。供 config.ts 在读取 env 前调用。
 */
const envPath = resolve(process.cwd(), '.env')
if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, 'utf-8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}
