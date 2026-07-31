const { existsSync } = require('node:fs')

async function main() {
  const { chromium } = require('@playwright/test')
  const executablePath = chromium.executablePath()
  if (!existsSync(executablePath)) {
    throw new Error(`Chromium executable not found: ${executablePath}`)
  }
  const browser = await chromium.launch({ headless: true })
  await browser.close()
  console.log('AUTO_TEST_CHROMIUM_READY')
}

main().catch((error) => {
  console.error(`[Auto-Test] Chromium readiness check failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
