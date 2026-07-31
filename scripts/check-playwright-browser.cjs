const { existsSync } = require('node:fs')

try {
  const { chromium } = require('@playwright/test')
  const executablePath = chromium.executablePath()
  if (existsSync(executablePath)) {
    process.exit(0)
  }
  console.error(`[Auto-Test] Chromium executable not found: ${executablePath}`)
  process.exit(1)
} catch (error) {
  console.error(`[Auto-Test] Chromium readiness check failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
