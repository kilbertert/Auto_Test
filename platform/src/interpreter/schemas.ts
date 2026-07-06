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
