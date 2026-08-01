import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './artifacts/compiled',
  testMatch: 'local-login.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  outputDir: 'artifacts/playwright/test-results',
  reporter: [
    ['list'],
    ['json', { outputFile: 'artifacts/playwright/results.json' }],
    ['html', { outputFolder: 'artifacts/playwright/html-report', open: 'never' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node tests/fixtures/site/server.mjs',
    url: 'http://127.0.0.1:43117/health',
    timeout: 15_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
