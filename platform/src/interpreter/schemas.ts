import { z } from 'zod'
import { LocatorSchema } from '../browser/locator.js'

/** 复用 browser/locator 的统一元素定位 schema。 */
export { LocatorSchema }

/** 单条结构化步骤的 schema(§7.6)。 */
export const StructuredStepSchema = z.object({
  action: z.enum([
    'navigate', 'click', 'type', 'select', 'check',
    'clear', 'upload', 'wait', 'other',
  ]),
  targetDescription: z.string(),
  value: z.string().optional(),
  locator: LocatorSchema.nullable(),
  rawText: z.string(),
  confidence: z.number().min(0).max(1),
})

/** 单条结构化断言的 schema(§7.6)。 */
export const StructuredAssertionSchema = z.object({
  kind: z.enum([
    'text', 'visible', 'hidden', 'url', 'title',
    'count', 'value', 'enabled', 'checked',
  ]),
  target: z.string().optional(),
  expected: z.string(),
  locator: LocatorSchema.nullable().optional(),
  rawText: z.string(),
  confidence: z.number().min(0).max(1),
})

/** 用例结构化解读结果的 schema(§7.6 outputSchema)。 */
export const CaseInterpretationSchema = z.object({
  steps: z.array(StructuredStepSchema),
  assertions: z.array(StructuredAssertionSchema),
  ambiguities: z.array(z.string()).describe('需人工确认的歧义点'),
})

export type StructuredStep = z.infer<typeof StructuredStepSchema>
export type StructuredAssertion = z.infer<typeof StructuredAssertionSchema>
export type CaseInterpretation = z.infer<typeof CaseInterpretationSchema>

/**
 * 规范化后的可执行步骤(locator 已在录制时硬编码,重放时零 AI)。
 * action 已规范化:SPA 的"进入X页面"→ click(点菜单),而非 navigate。
 */
export const ResolvedStepSchema = z.object({
  action: z.enum(['navigate_url', 'click', 'type', 'select', 'clear', 'wait']),
  resolvedLocator: LocatorSchema.nullable(),
  value: z.string().optional(),
  targetDescription: z.string(),
  rawText: z.string(),
})

/** 规范化后的断言(locator 已硬编码,重放时 browser_assert 直接用)。 */
export const ResolvedAssertionSchema = z.object({
  kind: z.enum(['text', 'visible', 'hidden', 'url', 'title', 'count', 'value', 'enabled', 'checked']),
  resolvedLocator: LocatorSchema.nullable(),
  expected: z.string(),
  target: z.string().optional(),
  rawText: z.string(),
})

export type ResolvedStep = z.infer<typeof ResolvedStepSchema>
export type ResolvedAssertion = z.infer<typeof ResolvedAssertionSchema>
