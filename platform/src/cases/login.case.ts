import type { RunTaskSpec } from '@open-multi-agent/core'
import type { Locator } from '../browser/locator.js'
import { config } from '../config.js'

export type StepAction = 'navigate' | 'click' | 'type' | 'select' | 'check'

export interface TestStep {
  action: StepAction
  targetDescription: string
  locator?: Locator
  value?: string
}

export interface TestAssertion {
  kind: 'text' | 'visible' | 'hidden' | 'url' | 'title'
  target: string
  locator?: Locator
  expected?: string
}

export interface TestCase {
  title: string
  url: string
  steps: TestStep[]
  assertions: TestAssertion[]
}

/** 硬编码登录用例(对本地 fixture 页)。 */
export const loginCase: TestCase = {
  title: '执行登录用例',
  url: config.TARGET_LOGIN_URL,
  steps: [
    { action: 'navigate', targetDescription: '登录页', value: config.TARGET_LOGIN_URL },
    { action: 'type', targetDescription: '用户名输入框', locator: { type: 'css', value: 'input[name="username"]' }, value: 'system' },
    { action: 'type', targetDescription: '密码输入框', locator: { type: 'css', value: 'input[name="password"]' }, value: 'Test1234' },
    { action: 'click', targetDescription: '登录按钮', locator: { type: 'role', value: 'button', name: '登录' } },
  ],
  assertions: [
    { kind: 'visible', target: '成功提示', locator: { type: 'css', value: '#success-msg' }, expected: 'true' },
  ],
}

function formatSteps(c: TestCase): string {
  const lines: string[] = []
  let i = 1
  for (const s of c.steps) {
    if (s.action === 'navigate') lines.push(`${i}. browser_navigate url=${s.value}`)
    else if (s.action === 'type') lines.push(`${i}. browser_type locator=${JSON.stringify(s.locator)} text="${s.value}"`)
    else if (s.action === 'click') lines.push(`${i}. browser_click locator=${JSON.stringify(s.locator)}`)
    i++
  }
  for (const a of c.assertions) {
    lines.push(`${i}. browser_assert kind="${a.kind}" locator=${JSON.stringify(a.locator)} expected="${a.expected ?? ''}"`)
    i++
  }
  return lines.join('\n')
}

/** 构建回归任务 DAG:执行登录用例 → 生成报告。 */
export function buildLoginTasks(): RunTaskSpec[] {
  return [
    {
      title: loginCase.title,
      assignee: 'executor',
      description: [
        `执行登录功能测试。目标 URL: ${loginCase.url}`,
        '严格按以下步骤顺序调用 browser_* 工具执行,不要跳步:',
        formatSteps(loginCase),
        '执行完上述步骤后,调用 browser_screenshot 截图保存证据。',
        '最终输出:verdict(passed/failed)、每步是否成功、截图路径。',
      ].join('\n'),
      maxRetries: 1,
      retryDelayMs: 1000,
      retryBackoff: 2,
    },
    {
      title: '生成报告',
      assignee: 'reporter',
      dependsOn: [loginCase.title],
      description: '根据上游"执行登录用例"任务的结果,聚合生成测试报告(严格符合 outputSchema):summary、total、passed、failed、cases。',
    },
  ]
}
