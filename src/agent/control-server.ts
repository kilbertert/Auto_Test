#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'
import { writePrivateJson } from './state.js'
import { readEnvironmentRequirements, requestEnvironmentAccess } from './environment-requirements.js'
import type { CodexTestControlConfig } from './control-types.js'
import { resolveEvidenceArtifact } from './evidence-artifact.js'
import { validateFieldCompositionGate } from './field-composition.js'
import { getRunScopedTestValue, parseAgentSecretValues } from './test-data-access.js'
import type { CodexTestCaseDecision, CodexTestFailureKind, CodexTestFailureSource, CodexTestFieldCompositionGate, CodexTestMutationLedgerEntry, CodexTestRisk } from './types.js'

interface AgentPlan {
  summary: string
  updatedAt: string
  steps: Array<{
    id: string
    title: string
    status: 'pending' | 'in_progress' | 'passed' | 'failed' | 'blocked'
    evidenceRequired: string
  }>
}

interface AgentEvidenceNote {
  caseId: string
  kind: 'snapshot' | 'screenshot' | 'console' | 'network' | 'observation' | 'mutation'
  description: string
  path?: string
  recordedAt: string
}

const riskRank: Record<CodexTestRisk, number> = { read: 0, write: 1, destructive: 2 }

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

function allowedOrigins(config: CodexTestControlConfig): string[] {
  return config.allowedOrigins ?? config.targetUrls.map((url) => new URL(url).origin)
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

async function readSecretValues(path?: string): Promise<Record<string, string>> {
  if (!path) return {}
  return parseAgentSecretValues(await readFile(path, 'utf8'))
}

async function main(): Promise<void> {
  process.umask(0o077)
  const configPath = process.argv[2]
  if (!configPath) throw new Error('Control server requires a config path')
  const config = JSON.parse(await readFile(configPath, 'utf8')) as CodexTestControlConfig
  const environmentRequirementsPath = config.environmentRequirementsPath
    ?? resolve(config.evidenceDirectory, '..', '..', '.agent-private', 'environment-requirements.json')
  const fieldCompositionPath = config.fieldCompositionPath
    ?? resolve(config.evidenceDirectory, '..', '..', '.agent-private', 'field-compositions.json')
  const caseIds = new Set(config.caseIds)
  const server = new McpServer({ name: 'auto-test-control', version: '0.1.0' }, {
    instructions: [
      'These tools are an optional run journal; they do not replace Codex planning, shell work, Playwright exploration, or final structured delivery.',
      'Use test_plan_update, evidence_record, field_composition_check, and case_result_record only when they make the run easier to recover or audit.',
      'Use mutation_begin and mutation_resolve as a coarse crash-recovery journal for externally persisted business operations.',
      'One mutation entry may cover one coherent business operation; ordinary navigation, reads, and form composition do not need entries.',
      'Resolve each pending mutation only after verified compensation or an explicitly expected retained state.',
    ].join(' '),
  })

  server.registerTool('test_contract', {
    title: 'Get test contract',
    description: 'Return immutable workflow identity, allowed risk, target URLs, and required case IDs.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => text({
    workflowId: config.workflowId,
    sourceSha256: config.sourceSha256,
    allowedRisk: config.allowedRisk,
    targetUrls: config.targetUrls,
    allowedOrigins: allowedOrigins(config),
    caseIds: config.caseIds,
    testDataAccess: config.testDataAccess ?? 'opaque',
  }))

  server.registerTool('test_value_get', {
    title: 'Get a run-scoped test value',
    description: 'Return one Excel/Profile test value by alias when direct test-data access is enabled. Provider keys, cookies, browser storage, and host credentials are never available through this tool.',
    inputSchema: { alias: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ alias }) => {
    const values = await readSecretValues(config.secretValuesPath)
    const value = getRunScopedTestValue(config.testDataAccess ?? 'opaque', values, alias)
    return text({ alias, value })
  })

  server.registerTool('environment_requirements', {
    title: 'List environment access requirements',
    description: 'Return origins requested by the agent that are not in the registered environment allowlist.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => text(await readEnvironmentRequirements(environmentRequirementsPath)))

  server.registerTool('request_environment_access', {
    title: 'Request access to an origin',
    description: 'Check whether a newly discovered origin is registered. Missing origins are recorded as a resumable environment requirement; this tool never grants access or navigates the browser.',
    inputSchema: {
      origin: z.string().min(1),
      reason: z.string().min(1),
      evidence: z.array(z.string().min(1)).default([]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ origin, reason, evidence }) => {
    return text(await requestEnvironmentAccess({
      allowedOrigins: allowedOrigins(config),
      requirementsPath: environmentRequirementsPath,
      origin,
      reason,
      evidence,
    }))
  })

  server.registerTool('test_plan_update', {
    title: 'Update dynamic execution plan',
    description: 'Optionally persist a concise plan snapshot. Codex native todo lists, workspace notes, and scripts are equally valid.',
    inputSchema: {
      summary: z.string().min(1),
      steps: z.array(z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        status: z.enum(['pending', 'in_progress', 'passed', 'failed', 'blocked']),
        evidenceRequired: z.string().min(1),
      })).min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ summary, steps }) => {
    const plan: AgentPlan = { summary, steps, updatedAt: new Date().toISOString() }
    await writePrivateJson(config.planPath, plan)
    return text(plan)
  })

  server.registerTool('evidence_record', {
    title: 'Record test evidence',
    description: 'Record a concise assertion, observation, or artifact reference for one test case.',
    inputSchema: {
      caseId: z.string().min(1),
      kind: z.enum(['snapshot', 'screenshot', 'console', 'network', 'observation', 'mutation']),
      description: z.string().min(1),
      path: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ caseId, kind, description, path }) => {
    if (!caseIds.has(caseId)) throw new Error(`Unknown caseId: ${caseId}`)
    const artifact = await resolveEvidenceArtifact(config.evidenceDirectory, path)
    const notes = await readJson<AgentEvidenceNote[]>(config.evidencePath, [])
    const note: AgentEvidenceNote = {
      caseId,
      kind,
      description,
      ...(artifact ? { path: artifact } : {}),
      recordedAt: new Date().toISOString(),
    }
    notes.push(note)
    await writePrivateJson(config.evidencePath, notes)
    return text(note)
  })

  server.registerTool('field_composition_check', {
    title: 'Validate a composite field representation',
    description: 'Optional diagnostic for recording how one logical value is represented across multiple controls. It is not required for submission or final result classification.',
    inputSchema: {
      caseId: z.string().min(1),
      fieldId: z.string().min(1),
      logicalValueRef: z.string().min(1),
      purpose: z.string().min(1),
      components: z.array(z.object({
        id: z.string().min(1),
        role: z.enum(['selector', 'input', 'display', 'hidden']),
        label: z.string().min(1),
        source: z.enum(['static', 'secret', 'derived', 'unknown']),
        observedValue: z.string().optional(),
        representation: z.enum(['full', 'component', 'suffix', 'none', 'unknown']),
        contribution: z.enum(['segment', 'context', 'none']),
      })).min(2),
      rendered: z.array(z.object({
        componentId: z.string().min(1),
        valueKind: z.enum(['static', 'secret', 'derived', 'empty']),
        valueLength: z.number().int().nonnegative().optional(),
        literalValue: z.string().optional(),
        secretAlias: z.string().min(1).optional(),
      })).min(2),
      evidence: z.array(z.string().min(1)).min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    if (!caseIds.has(input.caseId)) throw new Error(`Unknown caseId: ${input.caseId}`)
    const gate = validateFieldCompositionGate({
      ...input,
      secretValues: await readSecretValues(config.secretValuesPath),
    })
    const gates = await readJson<CodexTestFieldCompositionGate[]>(fieldCompositionPath, [])
    const existing = gates.findIndex((item) => item.id === gate.id)
    if (existing >= 0) gates[existing] = gate
    else gates.push(gate)
    await writePrivateJson(fieldCompositionPath, gates)
    return text(gate)
  })

  server.registerTool('field_composition_list', {
    title: 'List composite field gates',
    description: 'Return recorded composite-field representation checks for this run.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => text(await readJson<CodexTestFieldCompositionGate[]>(fieldCompositionPath, [])))

  server.registerTool('case_result_record', {
    title: 'Record final case result',
    description: 'Optionally checkpoint one case outcome for recovery. The same Codex thread produces the authoritative final structured result.',
    inputSchema: {
      caseId: z.string().min(1),
      outcome: z.enum(['passed', 'product_failed', 'blocked']),
      summary: z.string().min(1),
      blockers: z.array(z.string().min(1)).default([]),
      productDefects: z.array(z.string().min(1)).default([]),
      failureSource: z.enum(['product', 'agent_execution', 'environment', 'input', 'infrastructure']).optional(),
      failureKind: z.enum(['assertion', 'validation', 'authentication', 'environment', 'data', 'execution']).optional(),
      fieldGateIds: z.array(z.string().min(1)).default([]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ caseId, outcome, summary, blockers, productDefects, failureSource, failureKind, fieldGateIds }) => {
    if (!caseIds.has(caseId)) throw new Error(`Unknown caseId: ${caseId}`)
    if (outcome === 'passed' && (blockers.length > 0 || productDefects.length > 0)) {
      throw new Error('Passed case results cannot include blockers or product defects')
    }
    if (outcome === 'blocked' && blockers.length === 0) throw new Error('Blocked case results require at least one blocker')
    if (outcome === 'product_failed' && productDefects.length === 0) throw new Error('Product-failed case results require at least one product defect')
    const decisions = await readJson<CodexTestCaseDecision[]>(config.caseResultsPath, [])
    const decision: CodexTestCaseDecision = {
      caseId,
      outcome,
      summary,
      blockers: [...new Set(blockers)],
      productDefects: [...new Set(productDefects)],
      ...(failureSource ? { failureSource: failureSource as CodexTestFailureSource } : {}),
      ...(failureKind ? { failureKind: failureKind as CodexTestFailureKind } : {}),
      ...(fieldGateIds.length > 0 ? { fieldGateIds: [...new Set(fieldGateIds)] } : {}),
      recordedAt: new Date().toISOString(),
    }
    const existing = decisions.findIndex((item) => item.caseId === caseId)
    if (existing >= 0) decisions[existing] = decision
    else decisions.push(decision)
    await writePrivateJson(config.caseResultsPath, decisions)
    return text(decision)
  })

  server.registerTool('mutation_begin', {
    title: 'Begin business mutation',
    description: 'Register a business-state mutation before performing it in the browser.',
    inputSchema: {
      id: z.string().min(1),
      caseId: z.string().min(1),
      description: z.string().min(1),
      risk: z.enum(['write', 'destructive']),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, caseId, description, risk }) => {
    if (!caseIds.has(caseId)) throw new Error(`Unknown caseId: ${caseId}`)
    const caseRisk = config.caseRisks[caseId]
    if (!caseRisk || riskRank[risk] > riskRank[caseRisk]) throw new Error(`Test case ${caseId} does not authorize ${risk} mutations`)
    if (riskRank[risk] > riskRank[config.allowedRisk]) throw new Error(`Environment policy does not authorize ${risk} mutations`)
    const entries = await readJson<CodexTestMutationLedgerEntry[]>(config.mutationLedgerPath, [])
    const existing = entries.find((entry) => entry.id === id)
    if (existing && existing.status === 'pending') return text(existing)
    if (existing) throw new Error(`Mutation id ${id} is already terminal; use a new id for a new business action`)
    const now = new Date().toISOString()
    const entry: CodexTestMutationLedgerEntry = {
      id,
      caseId,
      description,
      risk,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      evidence: [],
    }
    entries.push(entry)
    await writePrivateJson(config.mutationLedgerPath, entries)
    return text(entry)
  })

  server.registerTool('mutation_resolve', {
    title: 'Resolve business mutation',
    description: 'Mark a registered mutation as compensated or explicitly accepted, with verification evidence.',
    inputSchema: {
      id: z.string().min(1),
      status: z.enum(['compensated', 'accepted']),
      evidence: z.array(z.string().min(1)).min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, status, evidence }) => {
    const entries = await readJson<CodexTestMutationLedgerEntry[]>(config.mutationLedgerPath, [])
    const entry = entries.find((item) => item.id === id)
    if (!entry) throw new Error(`Unknown mutation id: ${id}`)
    entry.status = status
    entry.evidence = [...new Set([...entry.evidence, ...evidence])]
    entry.updatedAt = new Date().toISOString()
    await writePrivateJson(config.mutationLedgerPath, entries)
    return text(entry)
  })

  server.registerTool('mutation_list', {
    title: 'List business mutations',
    description: 'Return the current Mutation Ledger, including unresolved entries.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => text(await readJson<CodexTestMutationLedgerEntry[]>(config.mutationLedgerPath, [])))

  await server.connect(new StdioServerTransport())
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
