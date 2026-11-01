import { afterEach, beforeEach, expect, it } from 'vitest'
import { startHarness, type Harness } from './harness'

let h: Harness
beforeEach(async () => {
  h = await startHarness()
})
afterEach(async () => {
  await h.dispose()
})

// Guards the harness itself: the suites must run on a migration-built database, like production,
// not on the tables the Worker would create at runtime.
it('the test database is built from migrations (indexes and foreign keys that only migrations define)', async () => {
  const db = await h.mf.getD1Database('DB')
  const indexes = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all<{ name: string }>()).results.map((r) => r.name)
  expect(indexes).toEqual(expect.arrayContaining(['idx_contacts_user_updated', 'idx_contacts_user_name', 'idx_jobs_contact', 'idx_login_tokens_email', 'idx_users_email']))
  const jobFks = (await db.prepare('PRAGMA foreign_key_list(extraction_jobs)').all<{ table: string }>()).results.map((r) => r.table).sort()
  expect(jobFks).toEqual(['contacts', 'users'])
})

it('an extraction job cannot reference a contact that does not exist (production foreign key)', async () => {
  const db = await h.mf.getD1Database('DB')
  await db.prepare("INSERT INTO users (id, email, name, created_at, updated_at) VALUES ('u1','u1@example.test','u1','t','t')").run()
  await expect(
    db
      .prepare("INSERT INTO extraction_jobs (id, user_id, contact_id, source_image_key, status, created_at, updated_at) VALUES ('j1','u1','missing','k','extracted','t','t')")
      .run(),
  ).rejects.toThrow(/FOREIGN KEY/i)
})
