import { OpenMultiAgent } from '@open-multi-agent/core'
import type { AgentConfig, SupportedProvider, OpenMultiAgent as OMAInstance } from '@open-multi-agent/core'
import { config } from '../config.js'
import { sqlite } from '../db/client.js'
import { CaseInterpretationSchema } from './schemas.js'
import type { CaseInterpretation, StructuredStep, StructuredAssertion } from './schemas.js'
import { splitSteps, classifyStep, extractAssertions } from './action-dict.js'

// ─────────────────────────────────────────────────────────────────────────
// case-interpreter agent 配置(§13.1)
// ─────────────────────────────────────────────────────────────────────────

export const caseInterpreter: AgentConfig = {
  name: 'case-interpreter',
  model: config.OMA_MODEL,
  provider: config.OMA_PROVIDER as SupportedProvider,
  baseURL: config.OMA_BASE_URL,
  apiKey: config.OMA_API_KEY,
  systemPrompt: [
    '你是 Web 测试用例解析专家。把中文自然语言步骤/预期转成结构化 steps + assertions。',
    '规则:动词词典优先匹配,未命中再推断。targetDescription 保留原中文别名(【】/""/\'\'内文本)。',
    '步骤的 locator 设为 null(由定位层后续解析)。每条 step/assertion 给出 0-1 的 confidence。',
    '无法确定的动作归为 action:"other"。含条件/分支的预期拆成多条 assertion,存 ambiguities。',
    '输出严格符合 outputSchema 的 JSON。',
  ].join(''),
  customTools: [],
  maxTurns: 2,
  temperature: 0,
  outputSchema: CaseInterpretationSchema,
}

// ─────────────────────────────────────────────────────────────────────────
// OpenMultiAgent 单例
// ─────────────────────────────────────────────────────────────────────────

let _oma: OMAInstance | null = null

/** 获取模块级 OpenMultiAgent 单例(maxConcurrency:2,readonly 预设)。 */
export function makeInterpreter(): OMAInstance {
  if (_oma) return _oma
  _oma = new OpenMultiAgent({
    defaultModel: config.OMA_MODEL,
    defaultProvider: config.OMA_PROVIDER as SupportedProvider,
    defaultBaseURL: config.OMA_BASE_URL,
    defaultApiKey: config.OMA_API_KEY,
    maxConcurrency: 2,
    defaultToolPreset: 'readonly',
  })
  return _oma
}

// ─────────────────────────────────────────────────────────────────────────
// interpretCase:规则优先 + LLM 兜底
// ─────────────────────────────────────────────────────────────────────────

/** 规则置信度折扣(有歧义时降级)。 */
const FALLBACK_CONF_DISCOUNT = 0.8

interface InterpretContext {
  modulePath?: string
  title?: string
}

/**
 * 把自然语言步骤/预期结构化为 CaseInterpretation。
 * 1. 规则优先:splitSteps + classifyStep + extractAssertions
 * 2. 若全部 step 分类成功(无 null)且 assertions 非空或 rawExpected 为空 → 直接返回(不调 LLM)
 * 3. 否则 LLM 兜底:makeInterpreter().runAgent(caseInterpreter, prompt),取 result.structured
 * 4. LLM 失败 → 降级用规则结果 + ambiguities
 */
export async function interpretCase(
  rawSteps: string,
  rawExpected: string,
  ctx?: InterpretContext,
): Promise<CaseInterpretation> {
  const stepsText = rawSteps?.trim() ?? ''
  const expectedText = rawExpected?.trim() ?? ''

  // 空用例
  if (!stepsText && !expectedText) {
    return { steps: [], assertions: [], ambiguities: ['用例无步骤和预期'] }
  }

  // ── 规则路径 ──
  const splitResult = splitSteps(stepsText)
  const ruleSteps: StructuredStep[] = []
  const unclassified: string[] = []
  for (const s of splitResult) {
    const classified = classifyStep(s)
    if (classified) {
      ruleSteps.push(classified)
    } else {
      unclassified.push(s)
    }
  }
  const ruleAssertions = extractAssertions(expectedText)

  // 收集歧义
  const ambiguities: string[] = []
  if (unclassified.length > 0) {
    ambiguities.push(`词典未命中的步骤: ${unclassified.join(' | ')}`)
  }
  // 步骤 targetDescription 含逗号 → 可能是复合步骤
  for (let i = 0; i < ruleSteps.length; i++) {
    if (/[，,]/.test(ruleSteps[i].targetDescription)) {
      ambiguities.push(`步骤${i + 1}可能包含多个动作: ${ruleSteps[i].rawText}`)
    }
  }
  // 预期非空但未提取到断言
  if (expectedText && ruleAssertions.length === 0) {
    ambiguities.push(`未能从预期结果提取断言: ${expectedText}`)
  }

  // ── 判定:是否可直接用规则结果 ──
  const allClassified = splitResult.length > 0 && unclassified.length === 0
  const assertionsOk = ruleAssertions.length > 0 || !expectedText

  if (allClassified && assertionsOk) {
    return { steps: ruleSteps, assertions: ruleAssertions, ambiguities }
  }

  // ── LLM 兜底 ──
  if (!config.hasLlm) {
    // LLM 未配置 → 直接返回规则降级结果
    return {
      steps: ruleSteps,
      assertions: ruleAssertions,
      ambiguities: [...ambiguities, 'LLM 未配置,使用规则降级结果'],
    }
  }

  const prompt = buildPrompt(stepsText, expectedText, ruleSteps, ruleAssertions, ctx)

  try {
    const oma = makeInterpreter()
    const result = await oma.runAgent(caseInterpreter, prompt)

    if (result.success && result.structured) {
      const parsed = CaseInterpretationSchema.safeParse(result.structured)
      if (parsed.success) {
        return parsed.data
      }
      // 结构化验证失败 — 尝试用 LLM 输出的 output 文本解析
      const fromText = tryParseOutput(result.output)
      if (fromText) return fromText
    }

    // LLM 返回但结构化失败 → 降级
    return {
      steps: ruleSteps,
      assertions: ruleAssertions,
      ambiguities: [...ambiguities, 'LLM 结构化验证失败,使用规则降级结果'],
    }
  } catch (e) {
    // LLM 调用异常 → 降级
    return {
      steps: ruleSteps,
      assertions: ruleAssertions,
      ambiguities: [...ambiguities, `LLM 调用失败: ${String(e).slice(0, 120)}`],
    }
  }
}

/** 构建 LLM prompt:含上下文 + 原文 + 规则已识别部分(提示)。 */
function buildPrompt(
  stepsText: string,
  expectedText: string,
  ruleSteps: StructuredStep[],
  ruleAssertions: StructuredAssertion[],
  ctx?: InterpretContext,
): string {
  const lines: string[] = []
  if (ctx?.modulePath) lines.push(`模块路径: ${ctx.modulePath}`)
  if (ctx?.title) lines.push(`用例标题: ${ctx.title}`)
  lines.push(`\n## 原始步骤\n${stepsText || '(空)'}`)
  lines.push(`\n## 原始预期\n${expectedText || '(空)'}`)

  if (ruleSteps.length > 0) {
    lines.push(`\n## 词典已识别步骤(参考,可修正)\n${JSON.stringify(ruleSteps, null, 2)}`)
  }
  if (ruleAssertions.length > 0) {
    lines.push(`\n## 规则已提取断言(参考,可修正)\n${JSON.stringify(ruleAssertions, null, 2)}`)
  }

  lines.push(
    '\n## 要求',
    '请将上述中文自然语言步骤和预期转为结构化 JSON,严格符合 outputSchema。',
    '保留中文元素别名到 targetDescription。未命中词典的步骤需推断 action。',
    '含条件/分支的预期拆成多条 assertion,无法确定的写入 ambiguities。',
  )
  return lines.join('\n')
}

/** 尝试从 LLM 纯文本输出中解析 JSON。 */
function tryParseOutput(output: string): CaseInterpretation | null {
  try {
    const jsonMatch = output.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    const obj = JSON.parse(jsonMatch[0])
    const parsed = CaseInterpretationSchema.safeParse(obj)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────
// saveInterpretation:落库
// ─────────────────────────────────────────────────────────────────────────

/** 计算 CaseInterpretation 的整体置信度(用于 DB confidence 列)。 */
function computeConfidence(interp: CaseInterpretation): number {
  const confs: number[] = []
  for (const s of interp.steps) confs.push(s.confidence)
  for (const a of interp.assertions) confs.push(a.confidence)
  if (confs.length === 0) return 0
  const avg = confs.reduce((a, b) => a + b, 0) / confs.length
  return interp.ambiguities.length > 0 ? Number((avg * FALLBACK_CONF_DISCOUNT).toFixed(3)) : Number(avg.toFixed(3))
}

/**
 * 把结构化解读结果写入 test_case 表。
 * structured_steps / structured_assertions 存 JSON;
 * interpret_status='done';interpret_version+1;confidence=整体置信度;ambiguities=JSON。
 */
export function saveInterpretation(caseId: number, interp: CaseInterpretation): void {
  const now = new Date().toISOString()
  const stepsJson = JSON.stringify(interp.steps)
  const assertionsJson = JSON.stringify(interp.assertions)
  const ambiguitiesJson = interp.ambiguities.length > 0 ? JSON.stringify(interp.ambiguities) : null
  const confidence = computeConfidence(interp)

  sqlite
    .prepare(
      `UPDATE test_case
       SET structured_steps = ?,
           structured_assertions = ?,
           interpret_status = 'done',
           interpret_version = COALESCE(interpret_version, 0) + 1,
           confidence = ?,
           ambiguities = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(stepsJson, assertionsJson, confidence, ambiguitiesJson, now, caseId)
}

// ─────────────────────────────────────────────────────────────────────────
// interpretBatch:批量结构化
// ─────────────────────────────────────────────────────────────────────────

interface BatchRow {
  id: number
  module_path: string | null
  title: string | null
  raw_steps: string | null
  raw_expected: string | null
}

export interface BatchResult {
  done: number
  failed: number
  skipped: number
}

/**
 * 批量结构化 test_case 表中的用例。
 * @param opts.limit      最多处理条数
 * @param opts.wherePending 仅处理 interpret_status='pending' 的用例
 * @param onProgress      进度回调(done=已处理数, total=总数, cur=当前条目)
 * 串行执行以避免 LLM 限流。
 */
export async function interpretBatch(
  opts: { limit?: number; wherePending?: boolean },
  onProgress?: (done: number, total: number, cur: { title: string; ok: boolean }) => void,
): Promise<BatchResult> {
  // 查询待处理用例
  let sql: string
  if (opts.wherePending) {
    sql = opts.limit
      ? `SELECT id, module_path, title, raw_steps, raw_expected
         FROM test_case WHERE interpret_status = 'pending' ORDER BY id LIMIT ?`
      : `SELECT id, module_path, title, raw_steps, raw_expected
         FROM test_case WHERE interpret_status = 'pending' ORDER BY id`
  } else {
    sql = opts.limit
      ? `SELECT id, module_path, title, raw_steps, raw_expected
         FROM test_case ORDER BY id LIMIT ?`
      : `SELECT id, module_path, title, raw_steps, raw_expected
         FROM test_case ORDER BY id`
  }
  const stmt = sqlite.prepare(sql)
  const rows = (opts.limit ? stmt.all(opts.limit) : stmt.all()) as BatchRow[]

  let done = 0
  let failed = 0
  let skipped = 0
  const total = rows.length

  for (const row of rows) {
    const title = row.title ?? `#${row.id}`

    // 空用例跳过
    if (!row.raw_steps?.trim() && !row.raw_expected?.trim()) {
      skipped++
      onProgress?.(done + failed + skipped, total, { title, ok: true })
      continue
    }

    try {
      const interp = await interpretCase(
        row.raw_steps ?? '',
        row.raw_expected ?? '',
        { modulePath: row.module_path ?? undefined, title: row.title ?? undefined },
      )
      saveInterpretation(row.id, interp)
      done++
      onProgress?.(done + failed + skipped, total, { title, ok: true })
    } catch (e) {
      failed++
      // 标记为 failed
      sqlite
        .prepare("UPDATE test_case SET interpret_status = 'failed', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), row.id)
      onProgress?.(done + failed + skipped, total, { title, ok: false })
    }
  }

  return { done, failed, skipped }
}
