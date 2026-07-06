import { runMigrate } from '../db/migrate.js'
import { sqlite } from '../db/client.js'
import { interpretCase } from '../interpreter/interpret.js'
import type { CaseInterpretation } from '../interpreter/schemas.js'

interface SampleRow {
  id: number
  module_path: string | null
  title: string | null
  raw_steps: string | null
  raw_expected: string | null
  author: string | null
}

/** 动作图标(终端友好)。 */
const ACTION_ICON: Record<string, string> = {
  navigate: '->', click: '[X]', type: '[=]', select: '[v]',
  check: '[v]', clear: 'clr', upload: 'up', wait: '...', other: ' ? ',
}

const ASSERT_ICON: Record<string, string> = {
  text: 'TXT', visible: 'VIS', hidden: 'HID', url: 'URL',
  title: 'TIT', count: 'CNT', value: 'VAL', enabled: 'ENB', checked: 'CHK',
}

function formatSteps(interp: CaseInterpretation): string {
  if (interp.steps.length === 0) return '  (无步骤)'
  return interp.steps
    .map((s, i) => {
      const icon = ACTION_ICON[s.action] ?? s.action
      const value = s.value ? ` = "${s.value}"` : ''
      const conf = s.confidence < 0.7 ? `  [LOW:${s.confidence}]` : ''
      return `  ${i + 1}. ${icon} ${s.targetDescription}${value}${conf}`
    })
    .join('\n')
}

function formatAssertions(interp: CaseInterpretation): string {
  if (interp.assertions.length === 0) return '  (无断言)'
  return interp.assertions
    .map((a, i) => {
      const icon = ASSERT_ICON[a.kind] ?? a.kind
      const target = a.target ? ` (${a.target})` : ''
      const conf = a.confidence < 0.7 ? `  [LOW:${a.confidence}]` : ''
      return `  ${i + 1}. ${icon}${target} expected="${a.expected}"${conf}`
    })
    .join('\n')
}

function avgConfidence(interp: CaseInterpretation): number {
  const confs = [...interp.steps.map(s => s.confidence), ...interp.assertions.map(a => a.confidence)]
  if (confs.length === 0) return 0
  return confs.reduce((a, b) => a + b, 0) / confs.length
}

/**
 * npm run interpret-sample [N](默认 20)
 * 查前 N 条 pending(或全部若无 pending 则前 N 条),interpretCase,
 * 打印每条 title + 结构化 steps/assertions 摘要 + confidence。
 * 供 50 条样本 gate 人工抽检。不写库。
 */
async function main(): Promise<void> {
  runMigrate()

  const n = parseInt(process.argv[2] ?? '20', 10)
  console.log(`[interpret-sample] 取 ${n} 条样本进行结构化解读(不写库)\n`)

  // 优先取 pending,无 pending 则取前 N 条
  let rows = sqlite
    .prepare(
      `SELECT id, module_path, title, raw_steps, raw_expected, author
       FROM test_case WHERE interpret_status = 'pending' ORDER BY id LIMIT ?`,
    )
    .all(n) as SampleRow[]

  if (rows.length === 0) {
    console.log('[interpret-sample] 无 pending 用例,取前 N 条全部用例')
    rows = sqlite
      .prepare(
        `SELECT id, module_path, title, raw_steps, raw_expected, author
         FROM test_case ORDER BY id LIMIT ?`,
      )
      .all(n) as SampleRow[]
  }

  if (rows.length === 0) {
    console.log('[interpret-sample] 数据库无用例')
    return
  }

  let okCount = 0
  let failCount = 0
  let ruleOnlyCount = 0
  let withAmbiguityCount = 0
  let totalSteps = 0
  let totalAssertions = 0
  const actionCounts: Record<string, number> = {}
  const assertKindCounts: Record<string, number> = {}

  for (const row of rows) {
    console.log(`${'='.repeat(70)}`)
    console.log(`#${row.id}  ${row.title ?? '(无标题)'}`)
    console.log(`模块: ${row.module_path ?? '-'}  作者: ${row.author ?? '-'}`)
    console.log(`步骤: ${(row.raw_steps ?? '').slice(0, 120)}${(row.raw_steps ?? '').length > 120 ? '...' : ''}`)
    console.log(`预期: ${(row.raw_expected ?? '').slice(0, 120)}${(row.raw_expected ?? '').length > 120 ? '...' : ''}`)

    try {
      const interp = await interpretCase(
        row.raw_steps ?? '',
        row.raw_expected ?? '',
        { modulePath: row.module_path ?? undefined, title: row.title ?? undefined },
      )

      console.log(`\n结构化步骤 (${interp.steps.length}):`)
      console.log(formatSteps(interp))

      console.log(`\n断言 (${interp.assertions.length}):`)
      console.log(formatAssertions(interp))

      if (interp.ambiguities.length > 0) {
        console.log('\n歧义:')
        for (const amb of interp.ambiguities) {
          console.log(`  ! ${amb}`)
        }
        withAmbiguityCount++
      }

      const avg = avgConfidence(interp)
      if (interp.ambiguities.length === 0) ruleOnlyCount++
      console.log(`\n平均置信度: ${avg.toFixed(2)}  ${avg >= 0.8 ? '[OK]' : avg >= 0.6 ? '[CHECK]' : '[LOW]'}`)

      // 统计
      okCount++
      totalSteps += interp.steps.length
      totalAssertions += interp.assertions.length
      for (const s of interp.steps) {
        actionCounts[s.action] = (actionCounts[s.action] ?? 0) + 1
      }
      for (const a of interp.assertions) {
        assertKindCounts[a.kind] = (assertKindCounts[a.kind] ?? 0) + 1
      }
    } catch (e) {
      console.error(`  解析失败: ${e}`)
      failCount++
    }
  }

  // ── 统计汇总 ──
  console.log(`\n${'='.repeat(70)}`)
  console.log('统计汇总')
  console.log(`${'='.repeat(70)}`)
  console.log(`样本数: ${rows.length}`)
  console.log(`成功: ${okCount}  失败: ${failCount}`)
  console.log(`纯规则(无歧义): ${ruleOnlyCount}  含歧义: ${withAmbiguityCount}`)
  console.log(`总步骤: ${totalSteps}  总断言: ${totalAssertions}`)
  console.log(`平均步骤/用例: ${okCount > 0 ? (totalSteps / okCount).toFixed(1) : '-'}`)
  console.log(`平均断言/用例: ${okCount > 0 ? (totalAssertions / okCount).toFixed(1) : '-'}`)

  console.log('\n动作分布:')
  for (const [action, count] of Object.entries(actionCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${action}: ${count}`)
  }

  console.log('\n断言类型分布:')
  for (const [kind, count] of Object.entries(assertKindCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind}: ${count}`)
  }
}

void main().catch((e) => {
  console.error('[interpret-sample] 失败:', e)
  process.exit(1)
})
