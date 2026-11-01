import { afterEach, beforeEach, expect, it, onTestFailed } from 'vitest'
import { saveTrace, startHarness, type Harness } from './harness'

// Legacy email-link sign-in must fail closed when two accounts share one normalized email, and must keep
// reusing an existing account (whatever its id) instead of creating a parallel one.

let h: Harness
beforeEach(async () => {
  h = await startHarness()
})
afterEach(async () => {
  await h.dispose()
})

async function insertUser(id: string, email: string, contact?: string) {
  const db = await h.mf.getD1Database('DB')
  await db.prepare("INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, 't', 't')").bind(id, email, email).run()
  if (contact) {
    await db
      .prepare("INSERT INTO contacts (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
      .bind(`c-${id}`, id, contact)
      .run()
  }
  return db
}

it('two accounts with the same normalized email: the email link is refused and neither account is exposed', async () => {
  onTestFailed((r) => saveTrace('legacy-ambiguity-refused', h.trace, r.errors?.[0]?.message))
  await insertUser('dup-1', 'dana@example.test', 'Dana One')
  await insertUser('dup-2', ' Dana@Example.test ', 'Dana Two')
  await expect(h.signIn('dana@example.test')).rejects.toThrow(/verify failed: 410/)
})

it('an existing account with a non-canonical id is reused by the email link, without creating another', async () => {
  onTestFailed((r) => saveTrace('legacy-reuse-noncanonical', h.trace, r.errors?.[0]?.message))
  const db = await insertUser('legacy-42', 'bob@example.test', 'Bob Legacy Contact')
  const bob = await h.signIn('bob@example.test')
  const list = (await (await bob.request('/api/contacts')).json()) as { contacts: Array<{ name: string }> }
  expect(list.contacts.map((c) => c.name)).toEqual(['Bob Legacy Contact'])
  expect(((await (await bob.request('/api/me')).json()) as { id: string }).id).toBe('legacy-42')
  const count = (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE lower(trim(email)) = 'bob@example.test'").first<{ n: number }>())!.n
  expect(count).toBe(1)
})

it('a brand-new person still gets the canonical email:<address> id', async () => {
  onTestFailed((r) => saveTrace('legacy-new-canonical', h.trace, r.errors?.[0]?.message))
  const carol = await h.signIn('Carol@Example.Test')
  expect(((await (await carol.request('/api/me')).json()) as { id: string }).id).toBe('email:carol@example.test')
})

it('email-link tokens still work exactly once after the change', async () => {
  onTestFailed((r) => saveTrace('legacy-token-once', h.trace, r.errors?.[0]?.message))
  await insertUser('legacy-42', 'bob@example.test')
  await h.signIn('bob@example.test')
  const link = h.lastLoginLink('bob@example.test')!
  const replay = await h.anonymous().request(new URL(link).pathname + new URL(link).search)
  expect(replay.status).toBe(410)
})

it('many email links for one new person verified at the same moment still create exactly one account', async () => {
  onTestFailed((r) => saveTrace('legacy-concurrent-first-login', h.trace, r.errors?.[0]?.message))
  const email = 'erin@example.test'
  const links: string[] = []
  for (let i = 0; i < 8; i += 1) {
    const res = await h.anonymous().request('/api/auth/request-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    expect(res.status).toBe(200)
    links.push(h.lastLoginLink(email)!)
  }
  expect(new Set(links).size).toBe(8)
  // All eight links are opened at the same moment.
  const verifies = await Promise.all(links.map((link) => h.anonymous().request(new URL(link).pathname + new URL(link).search)))
  expect(verifies.map((r) => r.status)).toEqual(Array(8).fill(302))
  const cookies = verifies.map((r) => (r.headers.get('set-cookie') || '').split(';')[0])
  const ids = await Promise.all(
    cookies.map(async (cookie) => ((await (await h.anonymous().request('/api/me', { headers: { Cookie: cookie } })).json()) as { id: string }).id),
  )
  expect(new Set(ids)).toEqual(new Set(['email:erin@example.test']))
  const db = await h.mf.getD1Database('DB')
  const count = (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE lower(trim(email)) = 'erin@example.test'").first<{ n: number }>())!.n
  expect(count).toBe(1)
})
