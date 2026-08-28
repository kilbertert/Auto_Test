import { describe, expect, it } from 'vitest'
import { extractClaimedIssues, parsePlanOutput } from '../.sandcastle/planner.js'

describe('extractClaimedIssues', () => {
  it('extracts issue numbers claimed by open PR bodies', () => {
    expect(extractClaimedIssues(['Closes #42', 'fixes #7 and Resolves #19'])).toEqual(new Set([42, 7, 19]))
  })

  it('ignores unrelated text', () => {
    expect(extractClaimedIssues(['Related to #42', 'No issue reference'])).toEqual(new Set())
  })
})

describe('parsePlanOutput', () => {
  it('parses a valid <plan> block', () => {
    const stdout = [
      'Here is my plan:',
      '<plan>',
      '{"issues": [{"number": 42, "title": "Fix auth bug", "branch": "agent/issue-42-fix-auth-bug"}]}',
      '</plan>',
    ].join('\n')

    expect(parsePlanOutput(stdout)).toEqual([
      { number: 42, title: 'Fix auth bug', branch: 'agent/issue-42-fix-auth-bug' },
    ])
  })

  it('returns an empty list for an empty plan', () => {
    expect(parsePlanOutput('<plan>{"issues": []}</plan>')).toEqual([])
  })

  it('throws when the planner did not emit a <plan> tag', () => {
    expect(() => parsePlanOutput('I could not plan this iteration.')).toThrow(/<plan>/)
  })
})
