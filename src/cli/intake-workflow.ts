#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { intakeWorkflowXlsx } from '../workflow/intake.js'

interface CliOptions {
  filePath: string
  sheetName?: string
  urls: string[]
  images: string[]
  outputPath?: string
  mediaDirectory?: string
  allowErrors: boolean
}

function help(): string {
  return [
    '用法:',
    '  npm run intake:workflow -- --file <workflow.xlsx> [--url <https://target/> ...] [选项]',
    '',
    '选项:',
    '  --sheet <name>          指定工作表',
    '  --url <url>             补充目标 URL，可重复',
    '  --image <path>          补充截图，可重复',
    '  --output <path>         工作流清单输出路径',
    '  --media-dir <path>      内嵌图片输出目录',
    '  --allow-errors          即使存在阻断诊断也返回退出码 0',
    '  --help                  显示帮助',
  ].join('\n')
}

function parseArgs(argv: string[]): CliOptions {
  let filePath: string | undefined
  let sheetName: string | undefined
  let outputPath: string | undefined
  let mediaDirectory: string | undefined
  let allowErrors = false
  const urls: string[] = []
  const images: string[] = []
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
    const value = argv[index + 1]
    if (!arg?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`参数 ${arg ?? ''} 缺少值或无法识别`)
    if (arg === '--file') filePath = resolve(value)
    else if (arg === '--sheet') sheetName = value
    else if (arg === '--url') urls.push(value)
    else if (arg === '--image') images.push(resolve(value))
    else if (arg === '--output') outputPath = resolve(value)
    else if (arg === '--media-dir') mediaDirectory = resolve(value)
    else throw new Error(`无法识别参数 ${arg}`)
    index += 1
  }
  if (!filePath) throw new Error('必须提供 --file')
  return {
    filePath,
    urls,
    images,
    ...(sheetName ? { sheetName } : {}),
    ...(outputPath ? { outputPath } : {}),
    ...(mediaDirectory ? { mediaDirectory } : {}),
    allowErrors,
  }
}

async function main(): Promise<void> {
  process.umask(0o027)
  const options = parseArgs(process.argv.slice(2))
  const result = await intakeWorkflowXlsx({
    filePath: options.filePath,
    additionalUrls: options.urls,
    supplementalImagePaths: options.images,
    ...(options.sheetName ? { sheetName: options.sheetName } : {}),
  })
  const outputPath = options.outputPath ?? resolve('artifacts', 'intake', `${result.manifest.workflowId}.workflow.json`)
  const diagnosticsPath = outputPath.replace(/\.workflow\.json$/i, '') + '.diagnostics.json'
  const mediaDirectory = options.mediaDirectory ?? resolve(dirname(outputPath), `${basename(outputPath, '.workflow.json')}-media`)
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o750 })
  await mkdir(mediaDirectory, { recursive: true, mode: 0o750 })
  await writeFile(outputPath, `${JSON.stringify(result.manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  await writeFile(diagnosticsPath, `${JSON.stringify(result.report, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  for (const asset of result.assets) {
    await writeFile(resolve(mediaDirectory, asset.metadata.fileName), asset.content, { mode: 0o640 })
  }

  const summary = result.report.summary
  console.log(`工作表: ${summary.sheetName ?? '(未识别)'}`)
  console.log(`工作流阶段: ${summary.phases}`)
  console.log(`图片资产: ${summary.images}`)
  console.log(`秘密引用: ${summary.secretBindings}`)
  console.log(`诊断: errors=${summary.errors} warnings=${summary.warnings}`)
  console.log(`Workflow: ${outputPath}`)
  console.log(`Diagnostics: ${diagnosticsPath}`)
  console.log(`Media: ${mediaDirectory}`)
  if (summary.errors > 0 && !options.allowErrors) process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(`工作流 intake 失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
