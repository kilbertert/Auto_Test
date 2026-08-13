import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js'
import type { CodexTestAgentResult, CodexTestMutationLedgerEntry } from './types.js'

export const codexTestResultSchema = {
  type: 'object',
  properties: {
    version: { type: 'string', const: '1.0' },
    workflowId: { type: 'string' },
    sourceSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    outcome: { type: 'string', enum: ['passed', 'product_failed', 'blocked'] },
    summary: { type: 'string' },
    startedAt: { type: 'string' },
    finishedAt: { type: 'string' },
    cases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          caseId: { type: 'string' },
          title: { type: 'string' },
          outcome: { type: 'string', enum: ['passed', 'product_failed', 'blocked'] },
          summary: { type: 'string' },
          failureSource: { type: ['string', 'null'], enum: ['product', 'agent_execution', 'environment', 'input', 'infrastructure', null] },
          failureKind: { type: ['string', 'null'], enum: ['assertion', 'validation', 'authentication', 'environment', 'data', 'execution', 'locator', 'mutation', null] },
          environmentRequirementIds: { type: ['array', 'null'], items: { type: 'string' } },
          executionReceiptIds: { type: ['array', 'null'], items: { type: 'string' } },
          fieldGateIds: { type: ['array', 'null'], items: { type: 'string' } },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['snapshot', 'screenshot', 'console', 'network', 'observation', 'mutation'] },
                path: { type: ['string', 'null'] },
                description: { type: 'string' },
              },
              required: ['kind', 'path', 'description'],
              additionalProperties: false,
            },
          },
        },
        required: ['caseId', 'title', 'outcome', 'summary', 'failureSource', 'failureKind', 'environmentRequirementIds', 'executionReceiptIds', 'fieldGateIds', 'evidence'],
        additionalProperties: false,
      },
    },
    mutations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          caseId: { type: 'string' },
          description: { type: 'string' },
          risk: { type: 'string', enum: ['write', 'destructive'] },
          status: { type: 'string', enum: ['pending', 'compensated', 'accepted'] },
          evidence: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'caseId', 'description', 'risk', 'status', 'evidence'],
        additionalProperties: false,
      },
    },
    environmentRequirements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          caseIds: { type: 'array', items: { type: 'string' } },
          kind: { type: 'string', enum: ['origin', 'permission', 'authentication', 'test_data', 'physical'] },
          origin: { type: ['string', 'null'] },
          condition: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', enum: ['pending', 'satisfied', 'superseded'] },
          requestedAt: { type: 'string' },
        },
        required: ['id', 'caseIds', 'kind', 'origin', 'condition', 'evidence', 'status', 'requestedAt'],
        additionalProperties: false,
      },
    },
    blockers: { type: 'array', items: { type: 'string' } },
    productDefects: { type: 'array', items: { type: 'string' } },
    nextActions: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'version',
    'workflowId',
    'sourceSha256',
    'outcome',
    'summary',
    'startedAt',
    'finishedAt',
    'cases',
    'mutations',
    'environmentRequirements',
    'blockers',
    'productDefects',
    'nextActions',
  ],
  additionalProperties: false,
} as const

/**
 * Provider-facing structured-output schemas use a deliberately conservative
 * JSON Schema subset. Some Responses-compatible providers accept strict
 * object schemas but reject nullable `type: [T, "null"]` unions. Empty
 * strings and arrays are transport sentinels only; the parser below restores
 * the canonical optional-field semantics before validation.
 */
function structuredOutputSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structuredOutputSchemaValue)
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const result = Object.fromEntries(
    Object.entries(source).map(([key, child]) => [key, structuredOutputSchemaValue(child)]),
  ) as Record<string, unknown>
  if (Array.isArray(source.type)) {
    const concreteTypes = source.type.filter((item) => item !== 'null')
    if (concreteTypes.length === 1) result.type = concreteTypes[0]
    if (Array.isArray(source.enum)) {
      const values = source.enum.filter((item) => item !== null)
      result.enum = concreteTypes[0] === 'string' && !values.includes('') ? [...values, ''] : values
    }
  }
  return result
}

export const agentTestStructuredOutputSchema = structuredOutputSchemaValue(codexTestResultSchema)

const ajv = new Ajv2020({ allErrors: true, strict: false })
const validateResult = ajv.compile<CodexTestAgentResult>(codexTestResultSchema)

function validationMessage(error: ErrorObject): string {
  return `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`
}

export function parseCodexTestResult(value: string): CodexTestAgentResult {
  const input = prepareResultForValidation(JSON.parse(value) as unknown)
  if (validateResult(input)) return normalizeParsedResult(input as CodexTestAgentResult & { cases: Array<Record<string, unknown>>; environmentRequirements: Array<Record<string, unknown>> })
  throw new Error(`Codex test result failed schema validation: ${(validateResult.errors ?? []).map(validationMessage).join('; ')}`)
}

function prepareResultForValidation(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const value = input as Record<string, unknown>
  return {
    ...value,
    cases: Array.isArray(value.cases)
      ? value.cases.map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return item
          const caseValue = item as Record<string, unknown>
          const failureSource = caseValue.failureSource === '' ? null : (caseValue.failureSource ?? null)
          const failureKind = caseValue.failureKind === '' ? null : (caseValue.failureKind ?? null)
          return {
            environmentRequirementIds: null,
            executionReceiptIds: null,
            fieldGateIds: null,
            ...caseValue,
            failureSource,
            failureKind,
            evidence: Array.isArray(caseValue.evidence)
              ? caseValue.evidence.map((evidence) => (
                  evidence && typeof evidence === 'object' && !Array.isArray(evidence)
                    ? {
                        path: null,
                        ...(evidence as Record<string, unknown>),
                        ...((evidence as Record<string, unknown>).path === '' ? { path: null } : {}),
                      }
                    : evidence
                ))
              : caseValue.evidence,
          }
        })
      : value.cases,
    environmentRequirements: Array.isArray(value.environmentRequirements)
      ? value.environmentRequirements.map((item) => (
          item && typeof item === 'object' && !Array.isArray(item)
            ? {
                origin: null,
                ...(item as Record<string, unknown>),
                ...((item as Record<string, unknown>).origin === '' ? { origin: null } : {}),
              }
            : item
        ))
      : value.environmentRequirements,
  }
}

function normalizeParsedResult(
  input: CodexTestAgentResult & { cases: Array<Record<string, unknown>>; environmentRequirements: Array<Record<string, unknown>> },
): CodexTestAgentResult {
  return {
    ...input,
    cases: input.cases.map((item) => {
      const { failureSource, failureKind, environmentRequirementIds, executionReceiptIds, fieldGateIds, evidence, ...rest } = item
      return {
        ...rest,
        ...(failureSource == null ? {} : { failureSource }),
        ...(failureKind == null ? {} : { failureKind }),
        ...(environmentRequirementIds == null ? {} : { environmentRequirementIds }),
        ...(executionReceiptIds == null ? {} : { executionReceiptIds }),
        ...(fieldGateIds == null ? {} : { fieldGateIds }),
        evidence: Array.isArray(evidence)
          ? evidence.map((entry) => {
              const value = entry as unknown as Record<string, unknown>
              const { path, ...withoutPath } = value
              return { ...withoutPath, ...(path == null ? {} : { path }) }
            })
          : evidence,
      }
    }) as CodexTestAgentResult['cases'],
    environmentRequirements: input.environmentRequirements.map((item) => {
      const { origin, ...rest } = item
      return { ...rest, ...(origin == null ? {} : { origin }) }
    }) as CodexTestAgentResult['environmentRequirements'],
  }
}

export function enforceMutationLedger(
  result: CodexTestAgentResult,
  ledger: CodexTestMutationLedgerEntry[],
): CodexTestAgentResult {
  const pending = ledger.filter((entry) => entry.status === 'pending')
  const mutations = ledger.map((entry) => ({
    id: entry.id,
    caseId: entry.caseId,
    description: entry.description,
    risk: entry.risk,
    status: entry.status,
    evidence: entry.evidence,
  }))
  if (pending.length === 0) return { ...result, mutations }
  const pendingCases = new Set(pending.map((entry) => entry.caseId))
  return {
    ...result,
    outcome: 'blocked',
    summary: `${result.summary} Unrecovered business mutations remain.`,
    mutations,
    cases: result.cases.map((item) => {
      if (!pendingCases.has(item.caseId)) return item
      const preserveBlockedClassification = item.outcome === 'blocked'
      return {
        ...item,
        outcome: 'blocked',
        summary: `${item.summary} Unrecovered business mutations remain for this case.`,
        failureSource: preserveBlockedClassification ? (item.failureSource ?? 'agent_execution') : 'agent_execution',
        failureKind: preserveBlockedClassification ? (item.failureKind ?? 'execution') : 'execution',
        evidence: [
          ...item.evidence,
          ...pending.filter((entry) => entry.caseId === item.caseId).map((entry) => ({
            kind: 'mutation' as const,
            description: `Pending mutation ${entry.id}: ${entry.description}`,
          })),
        ],
      }
    }),
    blockers: [
      ...result.blockers,
      `Unrecovered mutations: ${pending.map((entry) => entry.id).join(', ')}`,
    ],
  }
}

/** Host-neutral result contract exports. */
export const agentTestResultSchema = codexTestResultSchema

function parseWrappedAgentResult(
  value: string,
  parser: (candidate: string) => CodexTestAgentResult,
): CodexTestAgentResult {
  try {
    return parser(value)
  } catch (originalError) {
    const candidates = [...value.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)]
      .map((match) => match[1])
      .filter((candidate): candidate is string => Boolean(candidate))
    const start = value.indexOf('{')
    const end = value.lastIndexOf('}')
    if (start >= 0 && end > start) candidates.push(value.slice(start, end + 1))
    for (const candidate of candidates) {
      try {
        return parser(candidate)
      } catch {
        // Continue through all transport wrappers before failing closed.
      }
    }
    throw originalError
  }
}

/**
 * Some non-schema transports wrap an otherwise valid JSON delivery in a
 * Markdown fence or a short leading/trailing sentence. Normalize only those
 * transport wrappers; business fields still go through the same strict AJV
 * contract and deterministic Runner checks.
 */
export function parseAgentTestResult(value: string): CodexTestAgentResult {
  return parseWrappedAgentResult(value, parseCodexTestResult)
}

/**
 * The Runner owns the authoritative Mutation Ledger and environment
 * requirements. Ignore the AgentHost's duplicate projection of those two
 * collections while keeping every business-authored field under the same
 * strict schema and deterministic validation.
 */
export function parseAgentTestCandidate(value: string): CodexTestAgentResult {
  return parseWrappedAgentResult(value, (candidate) => {
    const parsed = JSON.parse(candidate) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parseCodexTestResult(candidate)
    return parseCodexTestResult(JSON.stringify({
      ...(parsed as Record<string, unknown>),
      mutations: [],
      environmentRequirements: [],
    }))
  })
}
