#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { importXlsxToIr } from '../importer.js'

interface CliOptions {
  filePath: string
  baseUrl: string
  sheetName?: string
  authProfile?: string
  outputPath?: string
  limit: number
  allowErrors: boolean
}

function help(): string {
  return [
    '用法:',
    '  npm run import -- --file <cases.xlsx> --url <https://target.example/> [选项]',
    '',
    '选项:',
    '  --sheet <name>          指定工作表',
    '  --auth-profile <name>   默认认证配置名称',
    '  --limit <1-20>          本次导入的有效用例上限，默认 20',
    '  --output <path>         IR 输出路径',
    '  --allow-errors          即使存在阻断诊断也返回退出码 0',
    '  --help                  显示帮助',
  ].join('\n')
}

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>()
  let allowErrors = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help') {
      console.log(help())
      process.exit(0)
    }
    if (arg === '--allow-errors') {
      allowErrors = true
      continue
    }
    if (!arg?.startsWith('--')) throw new Error(`无法识别参数 ${arg}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`参数 ${arg} 缺少值`)
    values.set(arg, value)
    index += 1
  }

  const filePath = values.get('--file')
  const baseUrl = values.get('--url')
  if (!filePath || !baseUrl) throw new Error('必须提供 --file 和 --url')
  const limit = Number.parseInt(values.get('--limit') ?? '20', 10)
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('--limit 必须是 1 到 20 的整数')
  const sheetName = values.get('--sheet')
  const authProfile = values.get('--auth-profile')
  const outputPath = values.get('--output')

  return {
    filePath: resolve(filePath),
    baseUrl,
    ...(sheetName ? { sheetName } : {}),
    ...(authProfile ? { authProfile } : {}),
    ...(outputPath ? { outputPath: resolve(outputPath) } : {}),
    limit,
    allowErrors,
  }
}

async function main(): Promise<void> {
  process.umask(0o027)
  const options = parseArgs(process.argv.slice(2))
  const result = await importXlsxToIr({
    filePath: options.filePath,
    baseUrl: options.baseUrl,
    limit: options.limit,
    ...(options.sheetName ? { sheetName: options.sheetName } : {}),
    ...(options.authProfile ? { authProfile: options.authProfile } : {}),
  })

  const outputPath = options.outputPath ?? resolve('artifacts', 'import', `${result.suite.suiteId}.ir.json`)
  const diagnosticsPath = outputPath.replace(/\.ir\.json$/i, '') + '.diagnostics.json'
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o750 })
  await writeFile(outputPath, `${JSON.stringify(result.suite, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  await writeFile(diagnosticsPath, `${JSON.stringify(result.report, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })

  const summary = result.report.summary
  console.log(`工作表: ${summary.sheetName ?? '(未识别)'}`)
  console.log(`数据行: ${summary.totalDataRows}`)
  console.log(`导入用例: ${summary.importedCases}`)
  console.log(`诊断: errors=${summary.errors} warnings=${summary.warnings}`)
  console.log(`Schema: ${result.schemaValid ? 'valid' : 'invalid'}`)
  console.log(`IR: ${outputPath}`)
  console.log(`Diagnostics: ${diagnosticsPath}`)

  for (const item of result.report.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info').slice(0, 12)) {
    const location = [item.sheet, item.row ? `row ${item.row}` : '', item.caseId].filter(Boolean).join(' / ')
    console.log(`[${item.severity}] ${item.code}${location ? ` (${location})` : ''}: ${item.message}`)
  }

  if (summary.errors > 0 && !options.allowErrors) process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(`导入失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
