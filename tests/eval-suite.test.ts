import { describe, expect, it } from 'vitest'
import { canonicalEvalSuite, evalSuiteProblems, parseEvalSuite } from '../src/eval/eval-suite.js'

describe('fixed eval suite', () => {
  it('declares a versioned, non-empty canonical task set', () => {
    const suite = canonicalEvalSuite()
    expect(suite.version).toBe('1.0')
    expect(suite.kind).toBe('eval-suite')
    expect(suite.tasks.length).toBeGreaterThanOrEqual(4)
    expect(evalSuiteProblems(suite)).toEqual([])
  })

  it('covers all eight failure modes with at least one task', () => {
    const suite = canonicalEvalSuite()
    const covered = new Set(suite.tasks.flatMap((task) => task.probes))
    for (const mode of ['input', 'authentication', 'environment', 'locator_navigation', 'business_assertion', 'mutation_cleanup', 'agent_execution', 'infrastructure']) {
      expect(covered.has(mode as never)).toBe(true)
    }
  })

  it('rejects a suite that leaves a failure mode unprobed', () => {
    const suite = canonicalEvalSuite()
    suite.tasks = suite.tasks.map((task) => ({ ...task, probes: ['business_assertion'] }))
    expect(evalSuiteProblems(suite)).toContain('eval suite does not probe failure mode input')
  })

  it('rejects duplicate task ids and unknown probe names', () => {
    const suite = canonicalEvalSuite()
    suite.tasks.push({ ...suite.tasks[0]! })
    suite.tasks[1]!.probes = ['not-a-mode' as never]
    const problems = evalSuiteProblems(suite)
    expect(problems.some((problem) => problem.includes('duplicate eval suite task'))).toBe(true)
    expect(problems.some((problem) => problem.includes('unknown failure-mode probe'))).toBe(true)
  })

  it('parses a valid suite and fails closed on invalid input', () => {
    expect(parseEvalSuite(canonicalEvalSuite()).problems).toEqual([])
    expect(parseEvalSuite(null).problems).toContain('eval suite must be a JSON object')
    expect(parseEvalSuite({ version: '1.0', kind: 'eval-suite', suiteId: 'x', tasks: [] }).problems)
      .toContain('eval suite must declare at least one task')
  })
})
