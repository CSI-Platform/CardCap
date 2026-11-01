import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, onTestFailed } from 'vitest'
import { ACCESS_AUDIENCE, ACCESS_ISSUER, defaultClaims, makeAccessKey, mintToken } from './access'
import { SESSION_SECRET, saveTrace, startHarness, uploadForm, type Harness } from './harness'

// Cloudflare Access sign-in, tested against the contract Codex posted (seq 59):
// AUTH_MODE=access, ACCESS_ISSUER/ACCESS_AUDIENCE/ACCESS_ALLOWED_HOSTS, RS256 JWT checked against the issuer's JWKS,
// every /api route gated, 401 {loginUrl:'/cdn-cgi/access/login'}, logoutUrl '/cdn-cgi/access/logout', legacy sign-in routes 410.
// The simulator's keys and JWKS exist only in the test process. These are SIMULATED checks, not live Access behavior.

const LOGIN_URL = '/cdn-cgi/access/login'
const LOGOUT_URL = '/cdn-cgi/access/logout'
const now = () => Math.floor(Date.now() / 1000)

let h: Harness

beforeEach(async () => {
  h = await startHarness({ access: true })
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
    onTestFailed((result) => saveTrace(`access-${name}`, h.trace, result.errors?.[0]?.message))
    await fn()
  })
}

async function db() {
  return h.mf.getD1Database('DB')
}

async function seedUser(id: string, email: string, contactName?: string) {
  const d = await db()
  await d.prepare("INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, 't', 't')").bind(id, email, email).run()
  if (contactName) {
    await d
      .prepare("INSERT INTO contacts (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
      .bind(`c-${id}`, id, contactName)
      .run()
  }
}

async function contactNames(res: Response): Promise<string[]> {
  return ((await res.json()) as { contacts: Array<{ name: string }> }).contacts.map((c) => c.name)
}

describe('valid Access sessions and existing-account mapping', () => {
  scenario('a valid token signs in as the existing canonical account and sees its contacts', async () => {
    await seedUser('email:alice@example.test', 'alice@example.test', 'Alice Contact')
    const alice = h.access.session('alice@example.test')
    const me = await alice.request('/api/me')
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual({ email: 'alice@example.test', id: 'email:alice@example.test' })
    expect(await contactNames(await alice.request('/api/contacts'))).toEqual(['Alice Contact'])
  })

  scenario('email case and spaces in the token do not create a second account', async () => {
    await seedUser('email:alice@example.test', 'alice@example.test', 'Alice Contact')
    const session = h.access.session('  Alice@Example.TEST ')
    const me = await session.request('/api/me')
    expect(me.status).toBe(200)
    expect((await me.json()) as { id: string }).toMatchObject({ id: 'email:alice@example.test' })
    expect(await contactNames(await session.request('/api/contacts'))).toEqual(['Alice Contact'])
  })

  scenario('an existing account with a non-canonical id keeps its id and its data', async () => {
    await seedUser('legacy-42', 'bob@example.test', 'Bob Legacy Contact')
    const bob = h.access.session('bob@example.test')
    const me = await bob.request('/api/me')
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual({ email: 'bob@example.test', id: 'legacy-42' })
    expect(await contactNames(await bob.request('/api/contacts'))).toEqual(['Bob Legacy Contact'])
  })

  scenario('the same person keeps the same account when their Access subject changes', async () => {
    await seedUser('email:alice@example.test', 'alice@example.test', 'Alice Contact')
    const first = await h.access.session('alice@example.test', { sub: 'subject-one' }).request('/api/me')
    const second = await h.access.session('alice@example.test', { sub: 'subject-two' }).request('/api/me')
    expect(((await first.json()) as { id: string }).id).toBe('email:alice@example.test')
    expect(((await second.json()) as { id: string }).id).toBe('email:alice@example.test')
  })

  scenario('a first-time person gets a new account with no data and no password row, and keeps it on later sign-ins', async () => {
    const carol = h.access.session('carol@example.test')
    const me = await carol.request('/api/me')
    expect(me.status).toBe(200)
    const created = (await me.json()) as { email: string; id: string }
    expect(created.email).toBe('carol@example.test')
    expect(created.id).toMatch(/^access:[0-9a-f]{64}$/)
    const again = (await (await h.access.session('carol@example.test').request('/api/me')).json()) as { id: string }
    expect(again.id).toBe(created.id)
    expect(await contactNames(await carol.request('/api/contacts'))).toEqual([])
    const rows = (await (await db()).prepare('SELECT COUNT(*) AS n FROM user_passwords').first<{ n: number }>())!.n
    expect(rows).toBe(0)
  })

  scenario('two accounts with the same normalized email fail closed and expose no data', async () => {
    await seedUser('dup-1', 'dana@example.test', 'Dana One')
    await seedUser('dup-2', 'Dana@Example.test', 'Dana Two')
    const dana = h.access.session('dana@example.test')
    const res = await dana.request('/api/contacts')
    expect([401, 403]).toContain(res.status)
    expect(JSON.stringify(await res.json())).not.toMatch(/Dana (One|Two)/)
  })
})

describe('forged, expired and malformed tokens are rejected', () => {
  async function expectRejected(token: string | null, label: string) {
    const headers: Record<string, string> = token === null ? {} : { 'Cf-Access-Jwt-Assertion': token }
    const res = await h.access.raw('/api/me', { headers })
    expect(res.status, label).toBe(401)
    const body = (await res.json()) as { loginUrl?: string }
    expect(body.loginUrl, label).toBe(LOGIN_URL)
  }

  const claims = (over: Record<string, unknown> = {}) => ({ ...defaultClaims('alice@example.test'), ...over })

  scenario('no token at all', async () => {
    await expectRejected(null, 'no token')
  })

  scenario('expired token', async () => {
    await expectRejected(mintToken({ key: h.access.keys[0], claims: claims({ exp: now() - 60, iat: now() - 3600 }) }), 'expired')
  })

  scenario('token issued in the future (iat) or not yet valid (nbf)', async () => {
    await expectRejected(mintToken({ key: h.access.keys[0], claims: claims({ iat: now() + 3600, nbf: now() + 3600, exp: now() + 7200 }) }), 'future iat/nbf')
  })

  scenario('wrong issuer', async () => {
    await expectRejected(mintToken({ key: h.access.keys[0], claims: claims({ iss: 'https://other-team.cloudflareaccess.com' }) }), 'wrong iss')
  })

  scenario('wrong audience (string and array forms)', async () => {
    await expectRejected(mintToken({ key: h.access.keys[0], claims: claims({ aud: ['some-other-app-aud'] }) }), 'wrong aud array')
    await expectRejected(mintToken({ key: h.access.keys[0], claims: claims({ aud: 'some-other-app-aud' }) }), 'wrong aud string')
  })

  scenario('missing audience, missing subject, missing email, or not an app token', async () => {
    const base = claims()
    const { aud: _aud, ...noAud } = base
    const { sub: _sub, ...noSub } = base
    const { email: _email, ...noEmail } = base
    void _aud
    void _sub
    void _email
    await expectRejected(mintToken({ key: h.access.keys[0], claims: noAud }), 'no aud')
    await expectRejected(mintToken({ key: h.access.keys[0], claims: noSub }), 'no sub')
    await expectRejected(mintToken({ key: h.access.keys[0], claims: noEmail }), 'no email')
    await expectRejected(mintToken({ key: h.access.keys[0], claims: claims({ type: 'service-token' }) }), 'type not app')
  })

  scenario('unsigned (alg none) and algorithm-confusion (HS256 with the public key) tokens', async () => {
    await expectRejected(mintToken({ key: h.access.keys[0], alg: 'none', claims: claims() }), 'alg none')
    await expectRejected(mintToken({ key: h.access.keys[0], alg: 'HS256', claims: claims() }), 'HS256 confusion')
  })

  scenario('tampered signature, tampered payload, unknown key id', async () => {
    const good = mintToken({ key: h.access.keys[0], claims: claims() })
    await expectRejected(mintToken({ key: h.access.keys[0], claims: claims(), tamperSignature: true }), 'tampered signature')
    const [head, , sig] = good.split('.')
    const evil = Buffer.from(JSON.stringify(claims({ email: 'victim@example.test' }))).toString('base64url')
    await expectRejected(`${head}.${evil}.${sig}`, 'tampered payload')
    await expectRejected(mintToken({ key: h.access.keys[0], kid: 'not-published', claims: claims() }), 'unknown kid')
  })

  scenario('token signed by a key that is not in the issuer JWKS', async () => {
    const rogue = makeAccessKey('test-key-1') // same kid, different key material
    await expectRejected(mintToken({ key: rogue, claims: claims() }), 'rogue key same kid')
  })

  scenario('garbage, empty and oversized tokens', async () => {
    await expectRejected('not-a-jwt', 'garbage')
    await expectRejected('a.b.c', 'three junk parts')
    await expectRejected('x'.repeat(20000), 'oversized')
    await expectRejected('', 'empty')
  })

  scenario('a rejected token never exposes data or creates an account', async () => {
    const rogue = makeAccessKey('test-key-1')
    const res = await h.access.raw('/api/contacts', { headers: { 'Cf-Access-Jwt-Assertion': mintToken({ key: rogue, claims: claims({ email: 'mallory@example.test' }) }) } })
    expect(res.status).toBe(401)
    const users = (await (await db()).prepare("SELECT COUNT(*) AS n FROM users WHERE email LIKE 'mallory%'").first<{ n: number }>())!.n
    expect(users).toBe(0)
  })
})

describe('old sign-in credentials no longer work in Access mode', () => {
  scenario('plain identity headers and a forged CF_Authorization cookie are ignored', async () => {
    const forgedPayload = Buffer.from(JSON.stringify(defaultClaims('alice@example.test'))).toString('base64url')
    for (const headers of [
      { 'Cf-Access-Authenticated-User-Email': 'alice@example.test' },
      { 'Cf-Access-Jwt-Assertion': `x.${forgedPayload}.y` },
      { Cookie: `CF_Authorization=x.${forgedPayload}.y` },
    ]) {
      expect((await h.access.raw('/api/me', { headers })).status).toBe(401)
    }
  })

  scenario('a validly signed legacy cardcap_session cookie does not authenticate', async () => {
    const userId = 'email:alice@example.test'
    const expires = now() + 3600
    const sig = createHmac('sha256', SESSION_SECRET).update(`${userId}.${expires}`).digest('base64url')
    const cookie = `cardcap_session=${encodeURIComponent(`v1.${Buffer.from(userId).toString('base64url')}.${expires}.${sig}`)}`
    const res = await h.access.raw('/api/me', { headers: { Cookie: cookie } })
    expect(res.status).toBe(401)
  })

  scenario('legacy sign-in routes answer 410 to an Access-authenticated caller and never issue a session', async () => {
    const alice = h.access.session('alice@example.test')
    const json = { 'content-type': 'application/json' }
    const attempts: Array<[string, string, string | undefined]> = [
      ['POST', '/api/auth/request-link', JSON.stringify({ email: 'alice@example.test' })],
      ['POST', '/api/auth/password-login', JSON.stringify({ email: 'alice@example.test', password: 'correct horse battery' })],
      ['POST', '/api/auth/set-password', JSON.stringify({ password: 'correct horse battery' })],
      ['GET', '/api/auth/verify?token=abc', undefined],
    ]
    for (const [method, path, body] of attempts) {
      const res = await alice.request(path, { method, headers: json, body })
      expect(res.status, `${method} ${path}`).toBe(410)
      expect(res.headers.get('set-cookie'), `${method} ${path}`).toBeNull()
    }
  })
})

describe('every API route is gated, and other hosts cannot bypass Access', () => {
  scenario('health and auth config are not public in Access mode', async () => {
    for (const path of ['/api/health', '/api/auth/config']) {
      const res = await h.access.raw(path)
      expect(res.status, path).toBe(401)
      expect(((await res.json()) as { loginUrl?: string }).loginUrl, path).toBe(LOGIN_URL)
    }
  })

  scenario('a valid token sent to an allowed host works, including case differences', async () => {
    for (const host of ['cardcap.test', 'CARDCAP.TEST', 'cardcap.example.test']) {
      const res = await h.access.session('alice@example.test', { host }).request('/api/me')
      expect(res.status, host).toBe(200)
    }
  })

  scenario('a valid token sent to a host that is not allowed (workers.dev, lookalikes, suffix tricks) is refused', async () => {
    for (const host of ['cardcap.codylecates.workers.dev', 'evilcardcap.test', 'cardcap.test.evil.example', 'cardcap.test.', 'localhost']) {
      const res = await h.access.session('alice@example.test', { host }).request('/api/me')
      expect([401, 403], host).toContain(res.status)
      expect(JSON.stringify(await res.json()), host).not.toContain('alice@example.test')
    }
  })

  scenario('a forwarded-host header cannot talk the Worker into accepting a disallowed host', async () => {
    const res = await h.access
      .session('alice@example.test', { host: 'cardcap.codylecates.workers.dev' })
      .request('/api/me', { headers: { 'X-Forwarded-Host': 'cardcap.test', Host: 'cardcap.test', Origin: 'https://cardcap.test' } })
    expect([401, 403]).toContain(res.status)
  })

  scenario('the published JWKS is actually fetched from the issuer certs URL', async () => {
    await h.access.session('alice@example.test').request('/api/me')
    expect(h.access.jwksFetches).toBeGreaterThan(0)
    const fetched = h.trace.filter((t) => t.kind === 'outbound' && t.note?.includes('access jwks'))
    expect(fetched.every((t) => t.url === `${ACCESS_ISSUER}/cdn-cgi/access/certs`)).toBe(true)
  })

  scenario('the token audience is bound to this app', async () => {
    const other = mintToken({ key: h.access.keys[0], claims: { ...defaultClaims('alice@example.test'), aud: [`${ACCESS_AUDIENCE}-other`] } })
    expect((await h.access.raw('/api/me', { headers: { 'Cf-Access-Jwt-Assertion': other } })).status).toBe(401)
  })
})

describe('logout', () => {
  scenario('logout clears the legacy cookie and returns the Access logout URL', async () => {
    const alice = h.access.session('alice@example.test')
    const res = await alice.request('/api/auth/logout', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ logoutUrl: LOGOUT_URL })
    expect(res.headers.get('set-cookie') || '').toMatch(/cardcap_session=;.*Max-Age=0/)
  })
})

describe('a refused account can still sign out', () => {
  scenario('with a valid token but an ambiguous account mapping, data is refused (403) yet logout answers with the Access logout URL', async () => {
    await seedUser('dup-1', 'dana@example.test', 'Dana One')
    await seedUser('dup-2', 'Dana@Example.test', 'Dana Two')
    const dana = h.access.session('dana@example.test')
    const data = await dana.request('/api/contacts')
    expect(data.status).toBe(403)
    expect(await data.json()).toEqual({ error: 'Account access requires review.' })
    const out = await dana.request('/api/auth/logout', { method: 'POST' })
    expect(out.status).toBe(200)
    expect(await out.json()).toEqual({ logoutUrl: LOGOUT_URL })
    expect(out.headers.get('set-cookie') || '').toMatch(/cardcap_session=;.*Max-Age=0/)
  })

  scenario('logout still requires a cryptographically valid token (a forged one gets nothing)', async () => {
    const rogue = makeAccessKey('test-key-1')
    const res = await h.access.raw('/api/auth/logout', {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': mintToken({ key: rogue, claims: defaultClaims('dana@example.test') }) },
    })
    expect(res.status).toBe(401)
  })
})

describe('cross-user isolation with Access sign-in', () => {
  scenario('another Access user cannot list, read, edit, delete or fetch the image of a contact', async () => {
    const alice = h.access.session('alice@example.test')
    const bob = h.access.session('bob@example.test')
    const upload = await alice.request('/api/cards/upload', { method: 'POST', body: uploadForm('maria.png') })
    expect(upload.status).toBe(201)
    const { contact } = (await upload.json()) as { contact: { id: string; sourceImageUrl: string; name: string } }
    expect(contact.name).toBe('Maria Okafor')
    expect((await alice.request(contact.sourceImageUrl)).status).toBe(200)

    expect(await contactNames(await bob.request('/api/contacts'))).toEqual([])
    expect((await bob.request(`/api/contacts/${contact.id}`)).status).toBe(404)
    expect((await bob.request(contact.sourceImageUrl)).status).toBe(404)
    const put = await bob.request(`/api/contacts/${contact.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Hijacked' }) })
    expect(put.status).toBe(404)
    const del = await bob.request(`/api/contacts/${contact.id}`, { method: 'DELETE' })
    expect(del.status).toBe(404)
    expect(await contactNames(await alice.request('/api/contacts'))).toEqual(['Maria Okafor'])
    expect((await alice.request(contact.sourceImageUrl)).status).toBe(200)
  })
})
