import type { AgentTestFailureMode } from '../agent/types.js'

/**
 * Fixed, versioned eval task set. This is the single place that declares which
 * existing scenarios (canary, local fixture, Windows acceptance, recovery) form
 * the regression matrix, and which of the eight failure modes each task is
 * able to expose. It is a data contract, not a new runner: comparison still
 * happens through `agent:compare`, and no task in this suite may require a new
 * service or a default parallel write fan-out.
 */

export type EvalSuiteTaskCategory = 'canary' | 'fixture' | 'windows-acceptance' | 'recovery'

export interface EvalSuiteTask {
  id: string
  category: EvalSuiteTaskCategory
  title: string
  description: string
  /** Failure modes a regression in this task would surface. */
  probes: AgentTestFailureMode[]
  /** Whether CI must require a full oracle match for this task. */
  requiresOracleMatch: boolean
  /** Immutable input contract this task is bound to. */
  inputContract: {
    kind: 'manifest' | 'oracle' | 'run-artifact'
    path: string
  }
}

export interface EvalSuite {
  version: '1.0'
  kind: 'eval-suite'
  /** Stable identity of the fixed task list; bump only on an intentional matrix change. */
  suiteId: string
  tasks: EvalSuiteTask[]
}

export const EVAL_SUITE_ID = 'canonical-regression-matrix-v1'

export const AGENT_TEST_FAILURE_MODE_PROBES: readonly AgentTestFailureMode[] = [
  'input',
  'authentication',
  'environment',
  'locator_navigation',
  'business_assertion',
  'mutation_cleanup',
  'agent_execution',
  'infrastructure',
]

/**
 * The canonical fixed task set. Every entry maps to an existing, exercised
 * scenario in this repository; no entry invents a new write path.
 */
export function canonicalEvalSuite(): EvalSuite {
  return {
    version: '1.0',
    kind: 'eval-suite',
    suiteId: EVAL_SUITE_ID,
    tasks: [
      {
        id: 'readonly-canary',
        category: 'canary',
        title: '只读 canary 回归',
        description: '用同一个只读输入包跑两个 AgentHost，比较业务 outcome、证据完整性和失败来源。',
        probes: ['business_assertion', 'environment', 'authentication'],
        requiresOracleMatch: true,
        inputContract: { kind: 'oracle', path: 'evals/readonly-canary.oracle.json' },
      },
      {
        id: 'local-fixture-site',
        category: 'fixture',
        title: '本地 fixture 站点回归',
        description: '在 tests/fixtures/agent-site 上验证定位、导航、断言和输入解析，不产生外部副作用。',
        probes: ['input', 'locator_navigation', 'business_assertion', 'environment'],
        requiresOracleMatch: true,
        inputContract: { kind: 'manifest', path: 'tests/fixtures/agent-site' },
      },
      {
        id: 'windows-acceptance',
        category: 'windows-acceptance',
        title: 'Windows 验收回归',
        description: '按 docs/windows-acceptance-runbook.md 的固定步骤验证启动、环境注册与结果交付。',
        probes: ['environment', 'infrastructure'],
        requiresOracleMatch: false,
        inputContract: { kind: 'run-artifact', path: 'docs/windows-acceptance-runbook.md' },
      },
      {
        id: 'delivery-recovery',
        category: 'recovery',
        title: '中断恢复与交付回归',
        description: '验证 interrupted run 的恢复、Mutation Ledger 终态和逐 case 交付校验。',
        probes: ['agent_execution', 'infrastructure', 'mutation_cleanup'],
        requiresOracleMatch: true,
        inputContract: { kind: 'run-artifact', path: 'artifacts' },
      },
    ],
  }
}

export function evalSuiteProblems(suite: EvalSuite): string[] {
  const problems: string[] = []
  if (suite.version !== '1.0') problems.push('eval suite version must be "1.0"')
  if (suite.kind !== 'eval-suite') problems.push('eval suite kind must be "eval-suite"')
  if (!suite.suiteId?.trim()) problems.push('eval suite suiteId is required')
  if (!Array.isArray(suite.tasks) || suite.tasks.length === 0) {
    problems.push('eval suite must declare at least one task')
    return problems
  }
  const ids = new Set<string>()
  const coveredModes = new Set<AgentTestFailureMode>()
  for (const task of suite.tasks) {
    if (!task.id?.trim()) {
      problems.push('eval suite task has no id')
      continue
    }
    if (ids.has(task.id)) problems.push(`duplicate eval suite task ${task.id}`)
    ids.add(task.id)
    if (!['canary', 'fixture', 'windows-acceptance', 'recovery'].includes(task.category)) {
      problems.push(`eval suite task ${task.id} has an unknown category`)
    }
    if (!task.title?.trim()) problems.push(`eval suite task ${task.id} has no title`)
    if (!task.description?.trim()) problems.push(`eval suite task ${task.id} has no description`)
    if (!Array.isArray(task.probes) || task.probes.length === 0) {
      problems.push(`eval suite task ${task.id} must declare at least one failure-mode probe`)
    }
    for (const probe of task.probes ?? []) {
      if (!AGENT_TEST_FAILURE_MODE_PROBES.includes(probe)) {
        problems.push(`eval suite task ${task.id} declares an unknown failure-mode probe`)
      } else {
        coveredModes.add(probe)
      }
    }
    if (task.requiresOracleMatch !== undefined && typeof task.requiresOracleMatch !== 'boolean') {
      problems.push(`eval suite task ${task.id} requiresOracleMatch must be a boolean`)
    }
    if (!task.inputContract?.path?.trim()) problems.push(`eval suite task ${task.id} has no input contract path`)
    if (task.inputContract && !['manifest', 'oracle', 'run-artifact'].includes(task.inputContract.kind)) {
      problems.push(`eval suite task ${task.id} has an unknown input contract kind`)
    }
  }
  for (const mode of AGENT_TEST_FAILURE_MODE_PROBES) {
    if (!coveredModes.has(mode)) problems.push(`eval suite does not probe failure mode ${mode}`)
  }
  return problems
}

/** Parse and validate an eval suite JSON document without throwing. */
export function parseEvalSuite(value: unknown): { suite?: EvalSuite; problems: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { problems: ['eval suite must be a JSON object'] }
  }
  const suite = value as EvalSuite
  const problems = evalSuiteProblems(suite)
  return problems.length === 0 ? { suite, problems } : { problems }
}
