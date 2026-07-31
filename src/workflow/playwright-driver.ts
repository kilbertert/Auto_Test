import { chromium, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createLocator } from '../runtime/locator.js'
import { CodexCliWorkflowCaptchaSolver, type WorkflowCaptchaSolver } from './captcha-solver.js'
import { actionNameCandidates, alignedActionRowIndex, entityAlreadyStoppedForAction, missingTableHeaderLabels, selectUniqueEntityRow } from './table-entities.js'
import type {
  CaptureTableRowRequest,
  ClickAlignedTableActionRequest,
  WorkflowPageSession,
  WorkflowLocatorInspection,
  WorkflowPageEvidence,
  WorkflowEntityRow,
  WorkflowLocatorState,
  WorkflowRuntimeDriver,
  WorkflowRuntimeTarget,
  WorkflowTableSpec,
} from './runtime-types.js'

export interface PlaywrightWorkflowDriverOptions {
  headless?: boolean
  slowMo?: number
  storageStateByTarget?: Record<string, string>
  sessionStorageByTarget?: Record<string, string>
  captchaSolver?: WorkflowCaptchaSolver
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function exactTextPattern(value: string): RegExp {
  return new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i')
}

export class PlaywrightWorkflowPageSession implements WorkflowPageSession {
  constructor(
    private readonly page: Page,
    private readonly target: WorkflowRuntimeTarget,
    private readonly captchaSolver: WorkflowCaptchaSolver,
  ) {}

  private async ensureAllowedOrigin(): Promise<void> {
    const origin = new URL(this.page.url()).origin
    const allowed = this.target.allowedOrigins.map((value) => new URL(value).origin)
    if (!allowed.includes(origin)) throw new Error(`Browser left allowedOrigins for target ${this.target.id}: ${origin}`)
  }

  setDefaultTimeout(timeoutMs: number): void {
    this.page.setDefaultTimeout(timeoutMs)
    this.page.setDefaultNavigationTimeout(timeoutMs)
  }

  async url(): Promise<string> {
    return this.page.url()
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' })
    await this.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)
    await this.page.waitForTimeout(500)
    await this.ensureAllowedOrigin()
  }

  async click(locator: Parameters<typeof createLocator>[1]): Promise<void> {
    const beforeUrl = this.page.url()
    const target = createLocator(this.page, locator)
    const recoverSelectTrigger = await this.isReadonlyInput(target)
    await target.click()
    if (recoverSelectTrigger) await this.recoverElementUiSelectTrigger(target)
    await this.page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined)
    await this.page.waitForTimeout(1_000)
    await this.page.waitForFunction(() => !document.body?.innerText?.split(/\n+/).some((line) => line.trim() === 'Loading'), undefined, { timeout: 15_000 }).catch(() => undefined)
    if (this.page.url() === beforeUrl) {
      if (locator.strategy === 'role' && locator.value === 'tab') {
        await target.click()
        await this.page.waitForTimeout(250)
      } else if (locator.strategy === 'role' && locator.value === 'menuitem' && locator.name) {
        const tabName = locator.name.replace(/^[^\p{L}\p{N}]+/u, '').trim()
        const tab = this.page.getByRole('tab', { name: tabName, exact: false })
        if (await tab.count() === 1 && await tab.isVisible()) {
          await tab.click()
          await this.page.waitForTimeout(250)
          if (this.page.url() === beforeUrl) {
            await tab.click()
            await this.page.waitForTimeout(250)
          }
        }
      }
    }
    if (this.page.url() !== beforeUrl) {
      const hasContent = async (): Promise<boolean> => normalizedText(await this.page.locator('body').textContent() ?? '').length > 0
      await this.page.waitForFunction(() => Boolean(document.body?.textContent?.trim()), undefined, { timeout: 25_000 }).catch(() => undefined)
      if (!await hasContent()) {
        await this.page.reload({ waitUntil: 'domcontentloaded' })
        await this.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)
        await this.page.waitForFunction(() => Boolean(document.body?.textContent?.trim()), undefined, { timeout: 25_000 }).catch(() => undefined)
      }
    }
    await this.ensureAllowedOrigin()
  }

  private async visibleSelectPopup(): Promise<boolean> {
    const popup = this.page.locator(
      '.el-select-dropdown:visible, .el-select-dropdown__item:visible, [role="listbox"]:visible, [role="option"]:visible',
    )
    return (await popup.count()) > 0
  }

  private async isReadonlyInput(target: Locator): Promise<boolean> {
    return target.evaluate((element) => element.tagName === 'INPUT' && element.hasAttribute('readonly'))
  }

  private async recoverElementUiSelectTrigger(target: Locator): Promise<void> {
    await this.page.waitForTimeout(150)
    if (await this.visibleSelectPopup()) return

    const select = target.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " el-select ")][1]').first()
    if (await select.count() !== 1 || !await select.isVisible()) return
    await select.click()
    await this.page.waitForTimeout(250)
  }

  async fill(locator: Parameters<typeof createLocator>[1], value: string): Promise<void> {
    await createLocator(this.page, locator).fill(value)
  }

  async press(locator: Parameters<typeof createLocator>[1], key: string): Promise<void> {
    await createLocator(this.page, locator).press(key)
  }

  async check(locator: Parameters<typeof createLocator>[1]): Promise<void> {
    await createLocator(this.page, locator).check()
  }

  async ensureChecked(locator: Parameters<typeof createLocator>[1], expected: boolean): Promise<void> {
    const target = createLocator(this.page, locator)
    const handle = await target.elementHandle()
    if (!handle) throw new Error('Checked control is not attached')
    const checkedState = async (): Promise<boolean> => {
      const checkbox = await handle.$('input[type="checkbox"]')
      if (checkbox) return checkbox.isChecked()
      try {
        return await handle.isChecked()
      } catch {
        const ariaChecked = await handle.getAttribute('aria-checked')
        if (ariaChecked === 'true' || ariaChecked === 'false') return ariaChecked === 'true'
        return (await handle.getAttribute('class') ?? '').split(/\s+/).includes('is-checked')
      }
    }
    if (await checkedState() !== expected) {
      await handle.click()
      await this.page.waitForTimeout(500)
    }
    if (await checkedState() !== expected) throw new Error(`Locator did not reach checked=${expected}`)
    await this.ensureAllowedOrigin()
  }

  async select(locator: Parameters<typeof createLocator>[1], value: string): Promise<void> {
    const target = createLocator(this.page, locator)
    const tagName = await target.evaluate((element) => element.tagName)
    if (tagName === 'SELECT') {
      await target.selectOption(value)
      return
    }
    const recoverSelectTrigger = await this.isReadonlyInput(target)
    await target.click()
    if (recoverSelectTrigger) await this.recoverElementUiSelectTrigger(target)
    for (const option of [
      this.page.getByRole('option', { name: value, exact: true }),
      this.page.getByText(value, { exact: true }),
    ]) {
      if (await option.count() !== 1 || !await option.isVisible()) continue
      await option.click()
      return
    }
    throw new Error(`Custom select option was not found: ${value}`)
  }

  async solveCaptcha(
    imageLocator: Parameters<typeof createLocator>[1],
    inputLocator: Parameters<typeof createLocator>[1],
  ): Promise<void> {
    const image = createLocator(this.page, imageLocator)
    await image.waitFor({ state: 'visible' })
    const code = await this.captchaSolver.solve(await image.screenshot())
    await createLocator(this.page, inputLocator).fill(code)
  }

  async reload(): Promise<void> {
    const beforeUrl = this.page.url()
    await this.page.reload({ waitUntil: 'domcontentloaded' })
    await this.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)
    await this.page.waitForTimeout(500)
    if (this.page.url() !== beforeUrl && beforeUrl !== 'about:blank') {
      const before = new URL(beforeUrl)
      const after = new URL(this.page.url())
      if (before.origin === after.origin) {
        await this.page.goto(beforeUrl, { waitUntil: 'domcontentloaded' })
        await this.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)
        await this.page.waitForTimeout(500)
      }
    }
    await this.ensureAllowedOrigin()
  }

  async wait(timeoutMs: number): Promise<void> {
    await this.page.waitForTimeout(timeoutMs)
  }

  private async tableBodyLocator(spec: WorkflowTableSpec): Promise<Locator> {
    const matched: Locator[] = []
    const diagnostics: string[] = []
    const elementTables = this.page.locator('.el-table:visible')
    await elementTables.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
    for (let index = 0; index < await elementTables.count(); index++) {
      const root = elementTables.nth(index)
      const fixedRight = spec.region === 'fixedRight'
      let header = fixedRight
        ? root.locator(':scope .el-table__fixed-right .el-table__fixed-header-wrapper table.el-table__header').first()
        : root.locator(':scope > .el-table__header-wrapper table.el-table__header, :scope > .el-table__inner-wrapper > .el-table__header-wrapper table.el-table__header').first()
      let body = fixedRight
        ? root.locator(':scope .el-table__fixed-right .el-table__fixed-body-wrapper table.el-table__body').first()
        : root.locator(':scope > .el-table__body-wrapper table.el-table__body, :scope > .el-table__inner-wrapper > .el-table__body-wrapper table.el-table__body').first()
      if (await header.count() === 0 || await body.count() === 0) {
        header = fixedRight
          ? root.locator(':scope .el-table__fixed-right table.el-table__header').first()
          : root.locator(':scope table.el-table__header').first()
        body = fixedRight
          ? root.locator(':scope .el-table__fixed-right table.el-table__body').first()
          : root.locator(':scope table.el-table__body').first()
      }
      const headerCount = await header.count()
      const bodyCount = await body.count()
      if (headerCount === 0 || bodyCount === 0) {
        diagnostics.push(`root${index}:header=${headerCount},body=${bodyCount}`)
        continue
      }
      const headerText = normalizedText(await header.textContent() ?? '')
      const missingLabels = missingTableHeaderLabels(headerText, spec.headerLabels)
      diagnostics.push(`root${index}:header=${headerCount},body=${bodyCount},missing=${JSON.stringify(missingLabels)},text=${headerText.slice(0, 300)}`)
      if (missingLabels.length === 0) matched.push(body)
    }
    if (matched.length === 0 && spec.region !== 'fixedRight') {
      const tables = this.page.locator('table:visible')
      for (let index = 0; index < await tables.count(); index++) {
        const table = tables.nth(index)
        const head = table.locator('thead')
        if (await head.count() === 0 || await table.locator('tbody').count() === 0) continue
        const header = normalizedText(await head.textContent() ?? '')
        if (missingTableHeaderLabels(header, spec.headerLabels).length === 0) matched.push(table)
      }
    }
    if (matched.length !== 1) {
      throw new Error(`Expected exactly one table with headers [${spec.headerLabels.join(', ')}]; found ${matched.length}; url=${this.page.url()}; elementRoots=${await elementTables.count()}; ${diagnostics.join(' | ')}`)
    }
    return matched[0]!
  }

  private async rowLocators(spec: WorkflowTableSpec): Promise<Locator[]> {
    const table = await this.tableBodyLocator(spec)
    const bodyRows = table.locator('tbody > tr')
    const rows = await bodyRows.count() > 0 ? bodyRows : table.locator('tr')
    const result: Locator[] = []
    for (let index = spec.bodyOffset; index < await rows.count(); index++) result.push(rows.nth(index))
    return result
  }

  async tableRows(spec: WorkflowTableSpec): Promise<string[]> {
    const rows = await this.rowLocators(spec)
    return Promise.all(rows.map(async (row) => normalizedText(await row.innerText())))
  }

  async entityRow(spec: WorkflowTableSpec, entityId: string): Promise<WorkflowEntityRow> {
    const rows = await this.rowLocators(spec)
    const matches: WorkflowEntityRow[] = []
    for (const row of rows) {
      const rowText = normalizedText(await row.innerText())
      if (!rowText.includes(entityId)) continue
      const cells = await row.locator('td').allTextContents()
      matches.push({ rowText, cells: cells.map(normalizedText) })
    }
    if (matches.length !== 1) throw new Error(`Expected exactly one live table row for captured entity; found ${matches.length}`)
    return matches[0]!
  }

  private async performRefresh(refresh: CaptureTableRowRequest['refresh']): Promise<void> {
    if (!refresh) return
    if (refresh.kind === 'reload') await this.reload()
    else if (refresh.kind === 'navigate') await this.navigate(refresh.url)
    else await this.click(refresh.locator)
  }

  async captureTableRow(request: CaptureTableRowRequest) {
    const deadline = Date.now() + request.timeoutMs
    let lastError: unknown
    while (Date.now() <= deadline) {
      try {
        const row = selectUniqueEntityRow(await this.tableRows(request.table), request.match, new RegExp(request.idPattern), request.exclude)
        return { ...row, table: request.table, capturedAt: new Date().toISOString() }
      } catch (error) {
        lastError = error
        if (!String((error as Error).message).includes('found 0')) throw error
      }
      if (Date.now() >= deadline) break
      await this.performRefresh(request.refresh)
      await this.wait(Math.min(request.pollIntervalMs, Math.max(0, deadline - Date.now())))
    }
    throw new Error(`Timed out capturing a unique table entity: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  async clickAlignedTableAction(request: ClickAlignedTableActionRequest): Promise<void> {
    const dataRows = await this.rowLocators(request.dataTable)
    const actionRows = await this.rowLocators(request.actionTable)
    const dataTexts = await Promise.all(dataRows.map(async (row) => normalizedText(await row.innerText())))
    const actionTexts = await Promise.all(actionRows.map(async (row) => normalizedText(await row.innerText())))
    let rowIndex: number
    try {
      rowIndex = alignedActionRowIndex(dataTexts, actionTexts, request.entityId, request.actionNames)
    } catch (error) {
      if (entityAlreadyStoppedForAction(dataTexts, actionTexts, request.entityId, request.actionNames)) return
      throw error
    }
    const row = actionRows[rowIndex]!
    for (const actionName of actionNameCandidates(request.actionNames)) {
      const exactName = exactTextPattern(actionName)
      for (const candidate of [
        row.getByRole('button', { name: exactName }),
        row.getByRole('link', { name: exactName }),
        row.getByText(exactName),
      ]) {
        const count = await candidate.count()
        if (count > 1) throw new Error(`Aligned action row contains multiple exact actions named ${actionName}`)
        if (count === 1) {
          const acceptsNativeConfirmation = request.actionNames.some((name) => /删除|移除|停止|强停|结算|delete|remove|stop|settle/i.test(name))
          const dialogHandler = (dialog: import('@playwright/test').Dialog) => acceptsNativeConfirmation ? dialog.accept() : dialog.dismiss()
          this.page.once('dialog', dialogHandler)
          try {
            await candidate.click()
            const messageBoxes = this.page.locator('.el-message-box:visible')
            const messageBoxCount = await messageBoxes.count()
            if (messageBoxCount > 1) throw new Error('Multiple visible Element UI confirmation dialogs are ambiguous')
            if (messageBoxCount === 1 && acceptsNativeConfirmation) {
              const messageBox = messageBoxes.first()
              let confirmed = false
              for (const confirmName of ['确 定', '确定', 'Confirm', 'OK']) {
                const confirm = messageBox.getByRole('button', { name: confirmName, exact: true })
                const confirmCount = await confirm.count()
                if (confirmCount > 1) throw new Error(`Element UI confirmation dialog has multiple buttons named ${confirmName}`)
                if (confirmCount === 1) {
                  await confirm.click()
                  confirmed = true
                  break
                }
              }
              if (!confirmed) throw new Error('Visible Element UI confirmation dialog has no approved confirm button')
            }
          } finally {
            this.page.off('dialog', dialogHandler)
          }
          await this.ensureAllowedOrigin()
          return
        }
      }
    }
    throw new Error(`Aligned action row has no clickable allowed action for entity ${request.entityId}`)
  }

  async locatorText(locator: Parameters<typeof createLocator>[1]): Promise<string> {
    return normalizedText(await createLocator(this.page, locator).innerText())
  }

  async locatorState(locator: Parameters<typeof createLocator>[1], state: WorkflowLocatorState): Promise<boolean> {
    const target = createLocator(this.page, locator)
    if (state === 'visible') return target.isVisible()
    if (state === 'hidden') return target.isHidden()
    if (state === 'enabled') return target.isEnabled()
    return target.isChecked()
  }

  async locatorCount(locator: Parameters<typeof createLocator>[1]): Promise<number> {
    return createLocator(this.page, locator).count()
  }

  async inspectLocator(locator: Parameters<typeof createLocator>[1]): Promise<WorkflowLocatorInspection> {
    const target = createLocator(this.page, locator)
    const count = await target.count()
    if (count !== 1) return { count, visible: null, enabled: null, editable: null, clickable: null }
    const single = target.first()
    let editable = false
    try {
      editable = await single.isEditable()
    } catch {
      editable = false
    }
    const visible = await single.isVisible()
    const enabled = await single.isEnabled()
    let clickable = false
    try {
      await single.click({ trial: true, timeout: 1_000 })
      clickable = true
    } catch {
      clickable = false
    }
    const finalCount = await target.count()
    if (finalCount !== 1) return { count: finalCount, visible: null, enabled: null, editable: null, clickable: null }
    return {
      count: finalCount,
      visible,
      enabled,
      editable,
      clickable,
    }
  }

  async applicationErrors(): Promise<string[]> {
    return this.page.evaluate(`(() => {
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim().slice(0, 500);
      const visible = (element) => {
        const style = globalThis.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const errorPattern = /incorrect|invalid|error|failed|failure|insufficient|not allowed|unavailable|offline|occupied|not found|disabled|tenant|admin|格式(?:错误|不正确)|错误|失败|无效|异常|不能为空|余额不足|离线|占用|禁用|管理员|租户/i;
      const selector = [
        '[role="alert"]',
        '[aria-live="assertive"]',
        '.el-message--error',
        '.el-message',
        '.el-notification',
        '.el-form-item__error',
        '.ant-message-error',
        '.ant-notification-notice-error',
        '.van-toast',
        '.uni-modal',
        'uni-modal',
        '.toast',
        '.Toastify__toast--error'
      ].join(',');
      return [...new Set(Array.from(document.querySelectorAll(selector))
        .filter(visible)
        .map((element) => normalize(element.innerText || element.textContent))
        .filter((text) => text && errorPattern.test(text)))].slice(0, 20);
    })()`)
  }

  async pageEvidence(): Promise<WorkflowPageEvidence> {
    const ariaSnapshot = (await this.page.locator('body').ariaSnapshot()).slice(0, 30_000)
    const browserEvidence = await this.page.evaluate(`(() => {
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim().slice(0, 240);
      const escaped = (value) => globalThis.CSS && globalThis.CSS.escape
        ? globalThis.CSS.escape(value)
        : value.replace(/[^A-Za-z0-9_-]/g, '\\\\$&');
      const uniqueCss = (element) => {
        if (element.id) {
          const candidate = '#' + escaped(element.id);
          if (document.querySelectorAll(candidate).length === 1) return candidate;
        }
        const testId = element.getAttribute('data-testid');
        if (testId) {
          const candidate = '[data-testid="' + testId.replace(/"/g, '\\\\"') + '"]';
          if (document.querySelectorAll(candidate).length === 1) return candidate;
        }
        const classes = Array.from(element.classList)
          .filter((value) => value.length <= 64 && !/\\d{4,}/.test(value) && !/^(?:is-)?(?:active|checked|selected|open|disabled|focus|hover)$/i.test(value))
          .slice(0, 3);
        if (classes.length) {
          const candidate = element.tagName.toLowerCase() + '.' + classes.map(escaped).join('.');
          if (document.querySelectorAll(candidate).length === 1) return candidate;
        }
        return '';
      };
      const selector = 'a,button,input,textarea,select,[role],[aria-label],[data-testid],[contenteditable="true"],.uni-input-input,.el-switch,.el-tabs__item,.bulge_view,.bulge_image';
      const interactiveElements = Array.from(document.querySelectorAll(selector)).slice(0, 300).map((element) => ({
        tag: element.tagName.toLowerCase(),
        role: normalize(element.getAttribute('role')),
        name: normalize(element.getAttribute('aria-label') || element.getAttribute('title')),
        text: normalize(element.innerText || element.textContent),
        placeholder: normalize(element.placeholder),
        testId: normalize(element.getAttribute('data-testid')),
        id: normalize(element.id),
        href: normalize(element.getAttribute('href')),
        css: uniqueCss(element),
        visible: (() => {
          const style = globalThis.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        })(),
        enabled: !element.disabled && element.getAttribute('aria-disabled') !== 'true',
      }));
      const choiceCandidates = [...new Set(Array.from(document.querySelectorAll('.el-select-dropdown__item, [role="option"]'))
        .filter((element) => {
          const style = globalThis.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        })
        .map((element) => normalize(element.innerText || element.textContent))
        .filter(Boolean))].slice(0, 50);
      let tableCandidates = Array.from(document.querySelectorAll('.el-table')).filter((table) => {
        const style = globalThis.getComputedStyle(table);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }).slice(0, 30).flatMap((table) => {
        const headers = (selector) => Array.from(table.querySelectorAll(selector))
          .map((cell) => normalize(cell.textContent)).filter(Boolean);
        const main = headers(':scope > .el-table__header-wrapper table.el-table__header thead th');
        const fixedRight = headers(':scope > .el-table__fixed-right .el-table__fixed-header-wrapper table.el-table__header thead th');
        return [
          ...(main.length ? [{ headerLabels: main, region: 'main' }] : []),
          ...(fixedRight.length ? [{ headerLabels: fixedRight, region: 'fixedRight' }] : []),
        ];
      });
      if (tableCandidates.length === 0) {
        tableCandidates = Array.from(document.querySelectorAll('table')).slice(0, 30).map((table) => ({
          headerLabels: Array.from(table.querySelectorAll('thead th')).map((cell) => normalize(cell.textContent)).filter(Boolean),
          region: 'main',
        })).filter((candidate) => candidate.headerLabels.length > 0);
      }
      return { interactiveElements, choiceCandidates, tableCandidates };
    })()`) as Pick<WorkflowPageEvidence, 'interactiveElements' | 'choiceCandidates' | 'tableCandidates'>
    return {
      url: this.page.url(),
      title: await this.page.title(),
      ariaSnapshot,
      applicationErrors: await this.applicationErrors(),
      ...(browserEvidence.choiceCandidates ? { choiceCandidates: browserEvidence.choiceCandidates } : {}),
      interactiveElements: browserEvidence.interactiveElements,
      tableCandidates: browserEvidence.tableCandidates,
    }
  }
}

interface ManagedSession {
  context: BrowserContext
  session: PlaywrightWorkflowPageSession
}

export class PlaywrightWorkflowDriver implements WorkflowRuntimeDriver {
  private browser: Browser | undefined
  private readonly sessions = new Map<string, ManagedSession>()

  constructor(private readonly options: PlaywrightWorkflowDriverOptions = {}) {}

  private async getBrowser(): Promise<Browser> {
    this.browser ??= await chromium.launch({
      headless: this.options.headless ?? true,
      ...(this.options.slowMo !== undefined ? { slowMo: this.options.slowMo } : {}),
    })
    return this.browser
  }

  async session(key: string, target: WorkflowRuntimeTarget): Promise<WorkflowPageSession> {
    const existing = this.sessions.get(key)
    if (existing) return existing.session
    const browser = await this.getBrowser()
    const context = await browser.newContext({
      ...(target.viewport ? { viewport: target.viewport } : {}),
      ...(this.options.storageStateByTarget?.[target.id]
        ? { storageState: this.options.storageStateByTarget[target.id] }
        : {}),
    })
    const sessionStoragePath = this.options.sessionStorageByTarget?.[target.id]
    if (sessionStoragePath) {
      const input = JSON.parse(await readFile(sessionStoragePath, 'utf8')) as unknown
      if (
        typeof input !== 'object' || input === null ||
        !('origin' in input) || typeof input.origin !== 'string' ||
        !('entries' in input) || typeof input.entries !== 'object' || input.entries === null ||
        Object.values(input.entries).some((value) => typeof value !== 'string')
      ) {
        await context.close()
        throw new Error(`Invalid sessionStorage adapter for target ${target.id}`)
      }
      const payload = input as { origin: string; entries: Record<string, string> }
      await context.addInitScript(({ origin, entries }) => {
        const browserGlobal = globalThis as unknown as {
          location: { origin: string }
          sessionStorage: { setItem(key: string, value: string): void }
        }
        if (browserGlobal.location.origin !== origin) return
        for (const [key, value] of Object.entries(entries)) browserGlobal.sessionStorage.setItem(key, value)
      }, payload)
    }
    const page = await context.newPage()
    const session = new PlaywrightWorkflowPageSession(
      page,
      target,
      this.options.captchaSolver ?? new CodexCliWorkflowCaptchaSolver(),
    )
    this.sessions.set(key, { context, session })
    return session
  }

  async closeSession(key: string): Promise<void> {
    const managed = this.sessions.get(key)
    if (!managed) return
    this.sessions.delete(key)
    await managed.context.close()
  }

  async closeAll(): Promise<void> {
    const errors: unknown[] = []
    for (const key of [...this.sessions.keys()]) {
      try {
        await this.closeSession(key)
      } catch (error) {
        errors.push(error)
      }
    }
    if (this.browser) {
      try {
        await this.browser.close()
      } catch (error) {
        errors.push(error)
      }
      this.browser = undefined
    }
    if (errors.length) throw new AggregateError(errors, 'Failed to close one or more Playwright workflow sessions')
  }
}
