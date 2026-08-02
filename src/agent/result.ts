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
          failureSource: { type: 'string', enum: ['product', 'agent_execution', 'environment', 'input'] },
          failureKind: { type: 'string', enum: ['assertion', 'validation', 'authentication', 'environment', 'data', 'execution'] },
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
          origin: { type: 'string' },
          reason: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', enum: ['pending', 'satisfied'] },
          requestedAt: { type: 'string' },
        },
        required: ['origin', 'reason', 'evidence', 'status', 'requestedAt'],
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
    cases: result.cases.map((item) => pendingCases.has(item.caseId) ? {
      ...item,
      outcome: 'blocked',
      summary: `${item.summary} Unrecovered business mutations remain for this case.`,
      failureSource: 'agent_execution',
      failureKind: 'execution',
      evidence: [
        ...item.evidence,
        ...pending.filter((entry) => entry.caseId === item.caseId).map((entry) => ({
          kind: 'mutation' as const,
          description: `Pending mutation ${entry.id}: ${entry.description}`,
        })),
      ],
    } : item),
    blockers: [
      ...result.blockers,
      `Unrecovered mutations: ${pending.map((entry) => entry.id).join(', ')}`,
    ],
  }
}
