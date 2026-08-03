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
          failureSource: { type: 'string', enum: ['product', 'agent_execution', 'environment', 'input', 'infrastructure'] },
          failureKind: { type: 'string', enum: ['assertion', 'validation', 'authentication', 'environment', 'data', 'execution'] },
          environmentRequirementIds: { type: 'array', items: { type: 'string' } },
          executionReceiptIds: { type: 'array', items: { type: 'string' } },
          fieldGateIds: { type: 'array', items: { type: 'string' } },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['snapshot', 'screenshot', 'console', 'network', 'observation', 'mutation'] },
                path: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['kind', 'description'],
              additionalProperties: false,
            },
          },
        },
        required: ['caseId', 'title', 'outcome', 'summary', 'evidence'],
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
          origin: { type: 'string' },
          condition: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', enum: ['pending', 'satisfied', 'superseded'] },
          requestedAt: { type: 'string' },
        },
        required: ['id', 'caseIds', 'kind', 'condition', 'evidence', 'status', 'requestedAt'],
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
  const input = JSON.parse(value) as unknown
  if (validateResult(input)) return input
  throw new Error(`Codex test result failed schema validation: ${(validateResult.errors ?? []).map(validationMessage).join('; ')}`)
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
