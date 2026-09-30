import { defineConfig } from '@playwright/test'

// This is a synthetic edge for browser tests, never a production authentication bypass.
process.env.ACCESS_SIM = '1'

export default defineConfig({
  testDir: './e2e/browser',
  testMatch: '**/access.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/browser-access',
  use: { baseURL: 'http://127.0.0.1:5197', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'npm run build && npm run test:browser:server',
    env: { ACCESS_SIM: '1', PORT: '5197' },
    url: 'http://127.0.0.1:5197',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
