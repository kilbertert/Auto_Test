import type { StructuredStep, StructuredAssertion } from './schemas.js'

// ─────────────────────────────────────────────────────────────────────────
// 动词词典(§7.3):动词 → action 映射。长动词在前,避免前缀冲突。
// ─────────────────────────────────────────────────────────────────────────

export const STEP_VERBS: ReadonlyArray<readonly [string, StructuredStep['action']]> = [
  // check (长动词在前)
  ['取消勾选', 'check'],
  // click
  ['点击', 'click'],
  ['单击', 'click'],
  ['按下', 'click'],
  ['保存', 'click'],
  ['提交', 'click'],
  ['删除', 'click'],
  ['编辑', 'click'],
  ['切换', 'click'],
  ['修改', 'click'],
  ['添加', 'click'],
  ['新建', 'click'],
  ['创建', 'click'],
  // type
  ['输入', 'type'],
  ['填写', 'type'],
  ['填入', 'type'],
  ['录入', 'type'],
  // select
  ['下拉选', 'select'],
  ['选择', 'select'],
  // check
  ['勾选', 'check'],
  ['选中', 'check'],
  // navigate
  ['进入', 'navigate'],
  ['打开', 'navigate'],
  ['跳转', 'navigate'],
  ['访问', 'navigate'],
  // clear
  ['清空', 'clear'],
  ['清除', 'clear'],
  // upload
  ['上传', 'upload'],
  // wait
  ['等待', 'wait'],
  ['加载', 'wait'],
  // other(验证/观察/查找类)
  ['查看', 'other'],
  ['检查', 'other'],
  ['核对', 'other'],
  ['观察', 'other'],
  ['确认', 'other'],
  ['搜索', 'other'],
  ['查询', 'other'],
  ['找到', 'other'],
  ['定位', 'other'],
  ['下载', 'other'],
  ['导出', 'other'],
  ['导入', 'other'],
  ['复制', 'other'],
  ['拖拽', 'other'],
  ['滚动', 'other'],
  ['不填写', 'other'],
  ['不填', 'other'],
]

/** 流水式切分用动词前缀(§7.2),按长度降序避免前缀冲突。 */
const SPLIT_VERBS = [...new Set(STEP_VERBS.map(([v]) => v))]
  .sort((a, b) => b.length - a.length)

// ─────────────────────────────────────────────────────────────────────────
// 步骤切分(§7.2):编号式 + 流水式容错,无 LLM
// ─────────────────────────────────────────────────────────────────────────

/** 正则转义。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把原始步骤文本切成句子数组。
 * 1. 编号式(78%):`1.` `2、` `3)` 分隔
 * 2. 分号/换行分隔
 * 3. 流水式(22%):动词前缀分词切句
 * 4. 切不开的整句保留
 */
export function splitSteps(rawSteps: string): string[] {
  const text = rawSteps?.trim()
  if (!text) return []

  // 1. 编号式:1. / 2、 / 3) / 1）(仅当文本以编号开头时)
  if (/^\s*\d+[.、)]/.test(text)) {
    const parts = text
      .split(/\d+[.、)]\s*/)
      .map(s => s.trim().replace(/[；;。！!]+$/, ''))
      .filter(Boolean)
    if (parts.length > 0) return parts
  }

  // 2. 分号或换行分隔
  if (/[；;\n]/.test(text)) {
    const parts = text
      .split(/[；;\n]/)
      .map(s => s.trim().replace(/[。！!]+$/, ''))
      .filter(Boolean)
    if (parts.length > 1) return parts
  }

  // 3. 流水式:动词前缀切句(至少 2 个动词前缀才切)
  const verbPattern = SPLIT_VERBS.map(escapeRe).join('|')
  const splitRe = new RegExp(`(?=${verbPattern})`)
  const candidates = text
    .split(splitRe)
    .map(s => s.trim())
    .filter(Boolean)

  // 合并"仅动词无内容"的片段到下一个片段
  const merged: string[] = []
  for (const part of candidates) {
    const isJustVerb = SPLIT_VERBS.some(v => v === part)
    if (isJustVerb && merged.length < candidates.length - 1) {
      // 合并到下一个:标记待合并
      merged.push('__MERGE_NEXT__' + part)
    } else if (merged.length > 0 && merged[merged.length - 1].startsWith('__MERGE_NEXT__')) {
      merged[merged.length - 1] = merged[merged.length - 1].slice('__MERGE_NEXT__'.length) + part
    } else {
      merged.push(part)
    }
  }
  if (merged.length > 1) return merged

  // 4. 切不开 → 整句保留
  return [text]
}

// ─────────────────────────────────────────────────────────────────────────
// 动作分类(§7.3):词典优先,命中返回结构(confidence 0.9)
// ─────────────────────────────────────────────────────────────────────────

/** 规则置信度常量。 */
const RULE_STEP_CONFIDENCE = 0.9
const RULE_ASSERTION_CONFIDENCE = 0.8

/** 常见非动词前缀,剥离后重试动词匹配。 */
const COMMON_PREFIXES = ['其他', '所有', '剩余', '正常', '手动', '仅', '只', '需要']

/**
 * 用 STEP_VERBS 匹配,把单条步骤文本分类为结构化 step。
 * 命中返回 StructuredStep(locator:null),未命中返回 null。
 */
export function classifyStep(text: string): StructuredStep | null {
  const trimmed = text.trim().replace(/[；;。！!]+$/, '')
  if (!trimmed) return null

  // ── "在{element}{verb}{value}" 模式 ──
  // 例:"在用户名输入框输入正确用户名" → target="用户名输入框", value="正确用户名"
  // 例:"在站场评分下拉框选择'0分'" → target="站场评分下拉框", value="'0分'"
  if (trimmed.startsWith('在')) {
    const afterZai = trimmed.slice(1)
    let best: { action: StructuredStep['action']; targetDescription: string; value?: string } | null = null

    for (const [verb, action] of STEP_VERBS) {
      // 用 lastIndexOf 避免匹配到"输入框"中的"输入"
      const idx = afterZai.lastIndexOf(verb)
      if (idx <= 0) continue
      const target = afterZai.slice(0, idx)
      const value = afterZai.slice(idx + verb.length)
      if (!target) continue
      // type/select 需要有 value;其他类型 value 可选
      if ((action === 'type' || action === 'select') && !value) continue
      // 选 target 最长的匹配(更精确的元素描述)
      if (!best || target.length > best.targetDescription.length) {
        best = { action, targetDescription: target, value: value || undefined }
      }
    }
    if (best) {
      return { ...best, locator: null, rawText: trimmed, confidence: RULE_STEP_CONFIDENCE }
    }

    // "在" 前缀但无中缀动词 — 剥离"在"后按常规匹配
    const stripped = afterZai
    for (const [verb, action] of STEP_VERBS) {
      if (stripped.startsWith(verb)) {
        const remainder = stripped.slice(verb.length).trim().replace(/[；;。！!]+$/, '')
        if (!remainder) continue
        return {
          action,
          targetDescription: remainder,
          value: action === 'type' ? remainder : undefined,
          locator: null,
          rawText: trimmed,
          confidence: RULE_STEP_CONFIDENCE,
        }
      }
    }
  }

  // ── 常规:动词在句首 ──
  for (const [verb, action] of STEP_VERBS) {
    if (trimmed.startsWith(verb)) {
      const remainder = trimmed.slice(verb.length).trim().replace(/[；;。！!]+$/, '')
      if (!remainder) continue
      return {
        action,
        targetDescription: remainder,
        value: action === 'type' ? remainder : undefined,
        locator: null,
        rawText: trimmed,
        confidence: RULE_STEP_CONFIDENCE,
      }
    }
  }

  // ── 剥离常见非动词前缀后重试 ──
  // 例:"其他必填项正常填写" → 剥离"其他" → "必填项正常填写" → 填写→type
  for (const prefix of COMMON_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      const stripped = trimmed.slice(prefix.length).trim()
      for (const [verb, action] of STEP_VERBS) {
        if (stripped.startsWith(verb)) {
          const remainder = stripped.slice(verb.length).trim().replace(/[；;。！!]+$/, '')
          if (!remainder) continue
          return {
            action,
            targetDescription: remainder,
            value: action === 'type' ? remainder : undefined,
            locator: null,
            rawText: trimmed,
            confidence: RULE_STEP_CONFIDENCE,
          }
        }
      }
    }
  }

  return null
}

// ─────────────────────────────────────────────────────────────────────────
// 断言提取(§7.4):模式匹配,命中返回断言(confidence 0.8)
// ─────────────────────────────────────────────────────────────────────────

/**
 * 从"预期结果"文本提取结构化断言。
 * 模式:跳转→url/title;提示/弹出/显示→text;变灰/不可点击→enabled;等。
 * 命中返回断言数组(置信度 0.8),未命中返回 []。
 */
export function extractAssertions(rawExpected: string): StructuredAssertion[] {
  const text = rawExpected?.trim()
  if (!text) return []

  // 拆分预期结果的编号子项和分号/逗号子句
  let clauses: string[]
  if (/^\s*\d+[.、)]/.test(text)) {
    clauses = text.split(/\d+[.、)]\s*/).map(c => c.trim()).filter(Boolean)
  } else {
    clauses = text.split(/[，,；;\n]/).map(c => c.trim()).filter(Boolean)
  }

  const assertions: StructuredAssertion[] = []

  for (const clause of clauses) {
    // 跳过纯否定句("无错误提示"/"无跳转") — 难以自动执行
    if (/^无/.test(clause)) continue

    // 提取引号内容作为 expected 精确值
    const quoted = clause.match(/[''"「」'"](.+?)[''"「」'"']/)
    const quotedText = quoted?.[1]

    // url:跳转到/跳转至
    let m = clause.match(/跳转(?:到|至)(.+)/)
    if (m) {
      assertions.push({
        kind: 'url',
        expected: m[1].trim().replace(/[。，,；;。]+$/, ''),
        rawText: clause,
        confidence: RULE_ASSERTION_CONFIDENCE,
      })
      continue
    }

    // title:进入X页面/X首页
    m = clause.match(/进入(.+?)(?:页面|主页|首页)/)
    if (m) {
      assertions.push({
        kind: 'title',
        expected: m[1].trim() + '页面',
        rawText: clause,
        confidence: RULE_ASSERTION_CONFIDENCE,
      })
      continue
    }

    // text:提示/弹出/显示/展示 + 内容
    m = clause.match(/(?:页面)?提示(.+)/)
    if (m) {
      assertions.push({
        kind: 'text',
        expected: (quotedText ?? m[1]).trim().replace(/[。，,；;。]+$/, ''),
        rawText: clause,
        confidence: RULE_ASSERTION_CONFIDENCE,
      })
      continue
    }
    m = clause.match(/弹出(.+)/)
    if (m) {
      assertions.push({
        kind: 'text',
        expected: (quotedText ?? m[1]).trim().replace(/[。，,；;。]+$/, ''),
        rawText: clause,
        confidence: RULE_ASSERTION_CONFIDENCE,
      })
      continue
    }
    m = clause.match(/(?:正确)?(?:显示|展示)(.+)/)
    if (m) {
      assertions.push({
        kind: 'text',
        expected: (quotedText ?? m[1]).trim().replace(/[。，,；;。]+$/, ''),
        rawText: clause,
        confidence: RULE_ASSERTION_CONFIDENCE,
      })
      continue
    }

    // visible:成功 + 动作(元素可见/操作成功)
    if (/成功$/.test(clause) || /^成功/.test(clause)) {
      assertions.push({
        kind: 'visible',
        expected: quotedText ?? clause.replace(/[。，,；;。]+$/, ''),
        rawText: clause,
        confidence: RULE_ASSERTION_CONFIDENCE,
      })
      continue
    }

    // value/checked:状态变为/变为/开关变为
    m = clause.match(/(?:状态|开关)?变为(.+?)(?:[，,。；;]|$)/)
    if (m) {
      const val = m[1].trim()
      const kind = /(开启|关闭|绿色|红色|已勾选|已选中)/.test(val) ? 'checked' : 'value'
      assertions.push({
        kind,
        expected: val,
        rawText: clause,
        confidence: RULE_ASSERTION_CONFIDENCE,
      })
      continue
    }

    // hidden:弹窗关闭/窗口关闭
    if (/(弹窗|窗口|对话框).*(关闭|消失)/.test(clause) || /^(关闭|消失)/.test(clause)) {
      assertions.push({
        kind: 'hidden',
        expected: 'true',
        rawText: clause,
        confidence: RULE_ASSERTION_CONFIDENCE,
      })
      continue
    }

    // enabled:false(变灰/不可点击/禁用)
    if (/(变灰|不可点击|禁用|不可用)/.test(clause)) {
      assertions.push({
        kind: 'enabled',
        expected: 'false',
        rawText: clause,
        confidence: RULE_ASSERTION_CONFIDENCE,
      })
      continue
    }

    // checked:已勾选/已选中
    if (/(已勾选|已选中)/.test(clause)) {
      assertions.push({
        kind: 'checked',
        expected: 'true',
        rawText: clause,
        confidence: RULE_ASSERTION_CONFIDENCE,
      })
      continue
    }

    // visible:不允许/校验不通过/不能保存(错误提示可见)
    if (/(不允许|校验不通过|不能保存|无法保存|保存失败|提交失败)/.test(clause)) {
      assertions.push({
        kind: 'visible',
        expected: quotedText ?? '错误提示',
        rawText: clause,
        confidence: RULE_ASSERTION_CONFIDENCE,
      })
      continue
    }

    // count:数量/条数/记录数
    m = clause.match(/(?:数量|条数|记录数?)(.+?)(?:[，,。；;]|$)/)
    if (m) {
      assertions.push({
        kind: 'count',
        expected: m[1].trim(),
        rawText: clause,
        confidence: RULE_ASSERTION_CONFIDENCE,
      })
      continue
    }
  }

  return assertions
}
