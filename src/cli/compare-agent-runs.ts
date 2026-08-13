#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { compareAgentRuns, writeAgentCompetitionReport, type AgentCompetitionOracle } from '../agent/competition.js'

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} 必须提供取值`)
  return value
}

function valuesAfter(args: string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== name) continue
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} 必须提供取值`)
    values.push(resolve(value))
  }
  return values
}

function help(): string {
  return [
    '用法:',
    '  npm run agent:compare -- --run <baseline-run> --run <candidate-run> [--oracle <json>] [--require-oracle-match] [--output <json>]',
    '',
    '该命令只比较已经完成的 AgentHost 运行制品，不启动浏览器、不调用模型、不重做业务写入。',
    '比较器会读取每个 run 的 immutable test-manifest.json；没有 oracle 时只报告合同是否一致和逐 case 差异，不擅自判断哪个宿主更正确。',
    'oracle 必须同时提供 version、workflowId、sourceSha256 和完整逐 case 期望。',
    '--require-oracle-match 要求每个候选完整命中 oracle，适合 CI 和必须能失败的 probe。',
  ].join('\n')
}

export async function runAgentComparisonCli(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(help())
    return 0
  }
  const runDirectories = valuesAfter(args, '--run')
  if (runDirectories.length < 2) throw new Error('至少提供两个 --run 目录（通常分别是 Codex 和 OMP）')
  const oraclePath = valueAfter(args, '--oracle')
  const oracle = oraclePath ? JSON.parse(await readFile(resolve(oraclePath), 'utf8')) as AgentCompetitionOracle : undefined
  const requireOracleMatch = args.includes('--require-oracle-match')
  if (requireOracleMatch && !oracle) throw new Error('--require-oracle-match 必须同时提供 --oracle')
  const report = await compareAgentRuns({ runDirectories, ...(oracle ? { oracle } : {}) })
  const output = resolve(valueAfter(args, '--output') ?? 'agent-competition.json')
  await writeAgentCompetitionReport(output, report)
  console.log(`比较结果：${report.verdict}`)
  console.log(`合同：${report.contractStatus}`)
  for (const candidate of report.candidates) {
    const build = [candidate.platform, candidate.arch, candidate.packageVersion, candidate.commit].filter(Boolean).join(' / ')
    console.log(`- ${candidate.hostId}：${candidate.outcome}，通过 ${candidate.caseCounts.passed}，产品不符预期 ${candidate.caseCounts.product_failed}，阻断 ${candidate.caseCounts.blocked}，pending mutation ${candidate.pendingMutationCount}，运行环境 ${build}`)
    if (candidate.oracleMatchedCases !== undefined) console.log(`  oracle：${candidate.oracleMatchedCases}/${report.oracle?.cases.length ?? 0}（${Math.round((candidate.oracleMatchRate ?? 0) * 100)}%）`)
    if (candidate.failureModes && Object.keys(candidate.failureModes).length > 0) console.log(`  失败模式：${Object.entries(candidate.failureModes).map(([mode, count]) => `${mode}=${count}`).join('，')}`)
    if (candidate.inputTokens !== undefined || candidate.outputTokens !== undefined) {
      console.log(`  tokens：输入 ${candidate.inputTokens ?? 0}（缓存 ${candidate.cachedInputTokens ?? 0}），输出 ${candidate.outputTokens ?? 0}`)
    }
    if (candidate.threadGeneration !== undefined) console.log(`  恢复：线程代数 ${candidate.threadGeneration}，恢复 ${candidate.recoveryCount ?? 0}，epoch ${candidate.epochCount ?? '-'}${candidate.interruptionCode ? `，中断 ${candidate.interruptionCode}` : ''}`)
    if (candidate.baselineDelta) console.log(`  相对 baseline：耗时 ${candidate.baselineDelta.durationMs ?? 0}ms，证据 ${candidate.baselineDelta.evidenceCount >= 0 ? '+' : ''}${candidate.baselineDelta.evidenceCount}，回执 ${candidate.baselineDelta.citedReceiptCount >= 0 ? '+' : ''}${candidate.baselineDelta.citedReceiptCount}，输出 tokens ${candidate.baselineDelta.outputTokens !== undefined ? (candidate.baselineDelta.outputTokens >= 0 ? '+' : '') + candidate.baselineDelta.outputTokens : '-'}`)
  }
  if (report.caseDifferences.length > 0) console.log(`逐 case 差异：${report.caseDifferences.length} 条`)
  for (const problem of report.contractProblems) console.log(`合同问题：${problem}`)
  console.log(`报告文件：${output}`)
  if (report.contractStatus !== 'valid') return 1
  if (requireOracleMatch && report.candidates.some((candidate) => candidate.oracleMatchRate !== 1)) return 1
  return 0
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('compare-agent-runs.ts')) {
  void runAgentComparisonCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
