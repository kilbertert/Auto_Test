import type { Locator, Page } from '@playwright/test'
import type { LocatorIR } from '../core/types.js'

function q(value: unknown): string {
  return JSON.stringify(value)
}

export function locatorExpression(locator: LocatorIR, receiver = 'page'): string {
  const prefix = receiver ? `${receiver}.` : ''
  switch (locator.strategy) {
    case 'role': {
      const options = [
        locator.name ? `name: ${q(locator.name)}` : '',
        locator.exact !== undefined ? `exact: ${locator.exact}` : '',
      ]
        .filter(Boolean)
        .join(', ')
      return `${prefix}getByRole(${q(locator.value)}${options ? `, { ${options} }` : ''})`
    }
    case 'testId':
      return `${prefix}getByTestId(${q(locator.value)})`
    case 'label':
      return `${prefix}getByLabel(${q(locator.value)}${locator.exact !== undefined ? `, { exact: ${locator.exact} }` : ''})`
    case 'placeholder':
      return `${prefix}getByPlaceholder(${q(locator.value)}${locator.exact !== undefined ? `, { exact: ${locator.exact} }` : ''})`
    case 'text':
      return `${prefix}getByText(${q(locator.value)}${locator.exact !== undefined ? `, { exact: ${locator.exact} }` : ''})`
    case 'css':
      return `${prefix}locator(${q(locator.value)})`
    case 'xpath':
      return `${prefix}locator(${q(`xpath=${locator.value}`)})`
  }
}

export function createLocator(page: Page, locator: LocatorIR): Locator {
  switch (locator.strategy) {
    case 'role':
      return page.getByRole(locator.value as Parameters<Page['getByRole']>[0], {
        ...(locator.name ? { name: locator.name } : {}),
        ...(locator.exact !== undefined ? { exact: locator.exact } : {}),
      })
    case 'testId':
      return page.getByTestId(locator.value)
    case 'label':
      return page.getByLabel(locator.value, locator.exact !== undefined ? { exact: locator.exact } : undefined)
    case 'placeholder':
      return page.getByPlaceholder(locator.value, locator.exact !== undefined ? { exact: locator.exact } : undefined)
    case 'text':
      return page.getByText(locator.value, locator.exact !== undefined ? { exact: locator.exact } : undefined)
    case 'css':
      return page.locator(locator.value)
    case 'xpath':
      return page.locator(`xpath=${locator.value}`)
  }
}
