import { spawnSync } from 'node:child_process'

const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.e2e.config.ts', 'e2e/access-rollback.e2e.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, ROLLBACK_CHECK: '1' },
})
process.exit(result.status ?? 1)
