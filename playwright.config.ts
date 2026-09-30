import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e/browser',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/browser',
  use: { baseURL: 'http://127.0.0.1:5199', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run test:browser:server', url: 'http://127.0.0.1:5199', reuseExistingServer: false, timeout: 60_000 },
})
