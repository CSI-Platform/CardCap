import { afterEach, beforeEach, describe, expect, it, onTestFailed } from 'vitest'
import { saveTrace, startHarness, uploadForm, type Harness, type Session } from './harness'

// Password sign-in and Realtor text normalization exist only in the canonical working tree (not in main HEAD).

let h: Harness

beforeEach(async () => {
  h = await startHarness()
  h.openai.mode = {
    kind: 'card',
    card: { name: 'Maria Okafor', company: 'Sunrise Realty Group', role: 'Broker', emails: ['maria@sunrise.example'], phones: ['(602) 555-0142'], website: '', address: '', tags: [], notes: '', confidence: 0.95, needs_review: false },
  }
})

afterEach(async () => {
  await h.dispose()
})

function scenario(name: string, fn: () => Promise<void>) {
  it(name, async () => {
    onTestFailed((result) => saveTrace(name, h.trace, result.errors?.[0]?.message))
    await fn()
  })
}

const json = { 'content-type': 'application/json' }
const login = (email: string, password: string) =>
  h.anonymous().request('/api/auth/password-login', { method: 'POST', headers: json, body: JSON.stringify({ email, password }) })
const setPassword = (session: Session, password: string) =>
  session.request('/api/auth/set-password', { method: 'POST', headers: json, body: JSON.stringify({ password }) })
const cookieOf = (res: Response) => (res.headers.get('set-cookie') || '').split(';')[0]

describe('password sign-in', () => {
  scenario('a signed-in user can set a password, then sign in with it and reach their own contacts', async () => {
    const alice = await h.signIn('alice@example.test')
    await alice.request('/api/cards/upload', { method: 'POST', body: uploadForm('maria.png') })

    const set = await setPassword(alice, 'correct horse battery')
    expect(set.status).toBe(200)
    expect(await set.json()).toEqual({ ok: true })

    const res = await login('alice@example.test', 'correct horse battery')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, email: 'alice@example.test' })
    const cookie = cookieOf(res)
    expect(cookie.startsWith('cardcap_session=')).toBe(true)

    const viaPassword = await h.anonymous().request('/api/contacts', { headers: { Cookie: cookie } })
    expect(viaPassword.status).toBe(200)
    const list = (await viaPassword.json()) as { contacts: Array<{ name: string }> }
    expect(list.contacts.map((c) => c.name)).toEqual(['Maria Okafor'])
  })

  scenario('setting a password requires a session', async () => {
    const res = await h.anonymous().request('/api/auth/set-password', { method: 'POST', headers: json, body: JSON.stringify({ password: 'correct horse battery' }) })
    expect(res.status).toBe(401)
  })

  scenario('a too-short password is rejected with a clear message and does not enable password login', async () => {
    const alice = await h.signIn('alice@example.test')
    const res = await setPassword(alice, 'short')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Password must be at least 8 characters.' })
    expect((await login('alice@example.test', 'short')).status).toBe(401)
  })

  scenario('wrong password, unknown email and a never-set password all fail identically (no account enumeration)', async () => {
    const alice = await h.signIn('alice@example.test')
    await h.signIn('carol@example.test')
    await setPassword(alice, 'correct horse battery')

    const bodies: string[] = []
    for (const [email, password] of [
      ['alice@example.test', 'wrong password here'],
      ['nobody@example.test', 'correct horse battery'],
      ['carol@example.test', 'correct horse battery'],
    ]) {
      const res = await login(email, password)
      expect(res.status, email).toBe(401)
      expect(res.headers.get('set-cookie'), email).toBeNull()
      bodies.push(await res.text())
    }
    expect(new Set(bodies).size).toBe(1)
    expect(JSON.parse(bodies[0])).toEqual({ error: 'Invalid email or password.' })
  })

  scenario('malformed sign-in requests are rejected with 400', async () => {
    expect((await login('not-an-email', 'correct horse battery')).status).toBe(400)
    expect((await login('alice@example.test', '')).status).toBe(400)
  })

  scenario('email matching at sign-in is case-insensitive', async () => {
    const alice = await h.signIn('alice@example.test')
    await setPassword(alice, 'correct horse battery')
    const res = await login('Alice@Example.TEST', 'correct horse battery')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, email: 'alice@example.test' })
  })

  scenario('one user password cannot sign in to, or be changed by, another user', async () => {
    const alice = await h.signIn('alice@example.test')
    const bob = await h.signIn('bob@example.test')
    await setPassword(alice, 'alice password one')
    await setPassword(bob, 'bob password one')

    expect((await login('bob@example.test', 'alice password one')).status).toBe(401)
    await setPassword(bob, 'bob password two')
    expect((await login('alice@example.test', 'alice password one')).status).toBe(200)
    expect((await login('bob@example.test', 'bob password one')).status).toBe(401)
    expect((await login('bob@example.test', 'bob password two')).status).toBe(200)
  })

  scenario('the password is stored hashed, never in plaintext, and is not returned by any response', async () => {
    const alice = await h.signIn('alice@example.test')
    const secret = 'correct horse battery'
    const set = await setPassword(alice, secret)
    expect(await set.text()).not.toContain(secret)

    const db = await h.mf.getD1Database('DB')
    const rows = (await db.prepare('SELECT password_hash FROM user_passwords').all<{ password_hash: string }>()).results
    expect(rows).toHaveLength(1)
    expect(rows[0].password_hash.startsWith('pbkdf2-sha256$')).toBe(true)
    expect(rows[0].password_hash).not.toContain(secret)
    expect(await (await alice.request('/api/me')).text()).not.toContain(rows[0].password_hash)
  })

  scenario('a password session sees only its own contacts', async () => {
    const alice = await h.signIn('alice@example.test')
    const bob = await h.signIn('bob@example.test')
    await alice.request('/api/cards/upload', { method: 'POST', body: uploadForm('maria.png') })
    await setPassword(bob, 'bob password one')
    const cookie = cookieOf(await login('bob@example.test', 'bob password one'))
    const list = (await (await h.anonymous().request('/api/contacts', { headers: { Cookie: cookie } })).json()) as { contacts: unknown[] }
    expect(list.contacts).toEqual([])
  })
})

describe('Realtor text normalization on save and export', () => {
  scenario('trademark marks and casing are cleaned when a contact is saved, and exports show the cleaned text', async () => {
    const alice = await h.signIn('alice@example.test')
    const created = await alice.request('/api/contacts', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        name: 'Dana Reyes',
        company: 'Sunrise REALTOR® Group',
        role: 'realtor',
        email: 'dana@sunrise.example',
        tags: ['REALTORS', 'Luxury', 'realtor®'],
        notes: 'Top REALTOR™ in Mesa',
        status: 'Active',
      }),
    })
    expect(created.status).toBe(201)

    const list = (await (await alice.request('/api/contacts')).json()) as { contacts: Array<Record<string, unknown>> }
    expect(list.contacts).toHaveLength(1)
    expect(list.contacts[0]).toMatchObject({
      company: 'Sunrise Realtor Group',
      role: 'Realtor',
      tags: ['Realtors', 'Luxury', 'Realtor'],
      notes: 'Top Realtor in Mesa',
    })

    expect(await (await alice.request('/api/export.csv')).text()).toBe(
      [
        'name,company,role,email,phones,website,address,tags,status,next_step,notes',
        'Dana Reyes,Sunrise Realtor Group,Realtor,dana@sunrise.example,,,,"Realtors; Luxury; Realtor",Active,,Top Realtor in Mesa',
      ].join('\n'),
    )
  })
})
