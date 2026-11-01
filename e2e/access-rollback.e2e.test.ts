import { afterEach, beforeEach, expect, it, onTestFailed } from 'vitest'
import { saveTrace, startHarness, type Harness } from './harness'

// Rollback hazard check (evidence for the release plan, not a product fix): after someone has signed in through Access,
// their account row is access:<hash>. If the release is rolled back to the legacy sign-in (AUTH_MODE unset), can that
// person still reach their contacts by the legacy email link, and does the legacy path avoid creating a second account
// with the same email (which would make Access sign-in fail closed with "Account access requires review" after a re-enable)?
// Skipped unless ROLLBACK_CHECK=1 because it documents a known gap that is being reported, not a passing expectation.

let h: Harness
beforeEach(async () => {
  h = await startHarness()
})
afterEach(async () => {
  await h.dispose()
})

async function seedAccessAccount(email: string, contactName: string) {
  const db = await h.mf.getD1Database('DB')
  const id = `access:${'a'.repeat(64)}`
  await db.prepare("INSERT INTO users (id, email, name, auth_provider, created_at, updated_at) VALUES (?, ?, ?, 'access', 't', 't')").bind(id, email, email).run()
  await db
    .prepare("INSERT INTO contacts (id, user_id, name, created_at, updated_at) VALUES ('c1', ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
    .bind(id, contactName)
    .run()
  return { db, id }
}

it.skipIf(process.env.ROLLBACK_CHECK !== '1')('after a rollback, the legacy email link reaches the contacts of a person who signed in through Access', async () => {
  onTestFailed((r) => saveTrace('access-rollback-contacts', h.trace, r.errors?.[0]?.message))
  await seedAccessAccount('alice@example.test', 'Alice Contact')
  const alice = await h.signIn('alice@example.test')
  const list = (await (await alice.request('/api/contacts')).json()) as { contacts: Array<{ name: string }> }
  expect(list.contacts.map((c) => c.name)).toEqual(['Alice Contact'])
})

it.skipIf(process.env.ROLLBACK_CHECK !== '1')('after a rollback, the legacy email link does not create a second account with the same email', async () => {
  onTestFailed((r) => saveTrace('access-rollback-duplicate', h.trace, r.errors?.[0]?.message))
  const { db } = await seedAccessAccount('alice@example.test', 'Alice Contact')
  await h.signIn('alice@example.test')
  const count = (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE lower(trim(email)) = 'alice@example.test'").first<{ n: number }>())!.n
  expect(count).toBe(1)
})
