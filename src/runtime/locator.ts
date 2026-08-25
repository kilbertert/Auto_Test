import type { Locator, Page } from '@playwright/test'
import type { LocatorIR } from '../core/types.js'

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
