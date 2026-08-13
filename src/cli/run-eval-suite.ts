#!/usr/bin/env node
import { resolve } from 'node:path'
import { runEvalSuite } from '../eval/run-eval-suite.js'

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
    '  npm run eval:suite -- --run <baseline-run> --run <candidate-run> ...',
    '',
    '按 canonicalEvalSuite() 的固定任务集，对第一个 --run（baseline）与其后的候选 run 跑 oracle 门禁比较。',
    '只有 inputContract.kind === "oracle" 且已提交 oracle 文件的任务会被执行，其余任务跳过。',
    '任一 requiresOracleMatch 任务有候选未完整命中 oracle 时返回非零。',
  ].join('\n')
}

export async function runEvalSuiteCli(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(help())
    return 0
  }
  const runDirectories = valuesAfter(args, '--run')
  if (runDirectories.length < 2) throw new Error('至少提供两个 --run 目录（第一个作为 baseline）')
  const baselineDirectory = runDirectories[0]!
  const candidateDirectories = runDirectories.slice(1)
  const run = await runEvalSuite({ baselineDirectory, candidateDirectories })

  for (const problem of run.suiteProblems) console.log(`套件问题：${problem}`)
  if (run.skipped.length > 0) console.log(`跳过（oracle 未接线或未编写）：${run.skipped.join('、')}`)
  if (run.tasks.length === 0) {
    console.log('没有可运行的 oracle 任务（其余任务尚未接线到可运行 oracle）')
    return run.failed ? 1 : 0
  }
  for (const task of run.tasks) {
    console.log(`任务 ${task.taskId}：${task.verdict}（合同 ${task.contractStatus}）`)
    for (const candidate of task.candidates) {
      const rate = candidate.oracleMatchRate !== undefined ? `${Math.round(candidate.oracleMatchRate * 100)}%` : '-'
      console.log(`  - ${candidate.hostId}：${candidate.outcome}，oracle ${candidate.oracleMatchedCases ?? '-'}，命中率 ${rate}`)
    }
    if (task.requiresOracleMatch && task.gateFailed) console.log(`  门禁失败：${task.taskId} 需要完整命中 oracle`)
  }
  return run.failed ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('run-eval-suite.ts')) {
  void runEvalSuiteCli(process.argv.slice(2))
    .then((exitCode) => { process.exitCode = exitCode })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
