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
          failureKind: { type: ['string', 'null'], enum: ['assertion', 'validation', 'authentication', 'environment', 'data', 'execution', null] },
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
          return {
            failureSource: null,
            failureKind: null,
            environmentRequirementIds: null,
            executionReceiptIds: null,
            fieldGateIds: null,
            ...caseValue,
            evidence: Array.isArray(caseValue.evidence)
              ? caseValue.evidence.map((evidence) => (
                  evidence && typeof evidence === 'object' && !Array.isArray(evidence)
                    ? { path: null, ...(evidence as Record<string, unknown>) }
                    : evidence
                ))
              : caseValue.evidence,
          }
        })
      : value.cases,
    environmentRequirements: Array.isArray(value.environmentRequirements)
      ? value.environmentRequirements.map((item) => (
          item && typeof item === 'object' && !Array.isArray(item)
            ? { origin: null, ...(item as Record<string, unknown>) }
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
      const { environmentRequirementIds: _environmentRequirementIds, ...withoutEnvironmentRequirement } = item
      return {
        ...withoutEnvironmentRequirement,
        outcome: 'blocked' as const,
        summary: `${item.summary} Unrecovered business mutations remain for this case.`,
        failureSource: 'agent_execution' as const,
        failureKind: 'execution' as const,
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
