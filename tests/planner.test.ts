import { describe, expect, it } from 'vitest'
import { extractGhToken, parsePlanOutput } from '../.sandcastle/planner.js'

describe('extractGhToken', () => {
  it('extracts the oauth_token from a gh hosts.yml', () => {
    const yaml = [
      'github.com:',
      '    oauth_token: gho_abc123',
      '    git_protocol: ssh',
      '    users:',
      '        kilbertert:',
      '            oauth_token: gho_def456',
    ].join('\n')

    expect(extractGhToken(yaml)).toBe('gho_abc123')
  })

  it('returns undefined when there is no token', () => {
    expect(extractGhToken('github.com:\n    git_protocol: https\n')).toBeUndefined()
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
