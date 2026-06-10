# CardCap Auth + iContact Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace shared beta-code auth with per-user email magic-link login, add an iContact-formatted CSV export, and add cost guards (Turnstile + rate limits + 25/day extraction quota).

**Architecture:** Everything stays on the existing Cloudflare Worker. Magic-link tokens live in a new D1 `login_tokens` table; sessions are stateless HMAC-signed cookies. Resend (plain `fetch`) sends login emails; Turnstile gates the login form; Workers Rate Limiting bindings stop bursts; a D1 count enforces the daily quota. iContact CSV is one new pure exporter function.

**Tech Stack:** TypeScript, Cloudflare Workers + D1 + R2, Workers Rate Limiting binding, Turnstile, Resend REST API, React 19, Vitest. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-06-09-auth-icontact-design.md`

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `src/shared/quota.ts` | Create | `DAILY_EXTRACTION_LIMIT`, pure UTC-day-window helper |
| `src/shared/quota.test.ts` | Create | Tests for the window helper |
| `src/shared/exporters.ts` | Modify | Add `splitContactName`, `exportContactsIContactCsv` |
| `src/shared/exporters.test.ts` | Modify | Tests for both new functions |
| `src/worker/session.ts` | Create | Sign/verify stateless session cookie values (HMAC-SHA256) |
| `src/worker/session.test.ts` | Create | Round-trip, tamper, expiry, malformed tests |
| `src/worker/config.ts` | Create | `envValue()` helper (moved from auth.ts) |
| `src/worker/email.ts` | Create | `sendLoginEmail()` — Resend or console fallback |
| `src/worker/auth.ts` | Rewrite | Magic-link request/verify, `currentUser`, logout; beta code path deleted |
| `src/worker/repository.ts` | Modify | `login_tokens` in `ensureSchema`, `upsertUser`, `countExtractionJobsSince`, token CRUD |
| `src/worker/index.ts` | Modify | New auth routes, `/api/me`, quota + burst checks in upload, iContact export route |
| `migrations/0002_login_tokens.sql` | Create | `login_tokens` table |
| `wrangler.jsonc` | Modify | `SENDER_EMAIL`/`TURNSTILE_SITE_KEY` vars, 3 ratelimit bindings |
| `worker-configuration.d.ts` | Regenerate | `npx wrangler types` |
| `.dev.vars.example` | Modify | Document new local vars |
| `src/components/LoginGate.tsx` | Create | Email form + Turnstile + "check your email" state |
| `src/App.tsx` | Modify | `/api/me` boot, LoginGate, logout, iContact button; beta unlock UI deleted |
| `src/App.css` | Modify | Minimal styles for LoginGate reusing `.unlock-*` classes |
| `README.md`, `DEPLOYMENT.md` | Modify | Auth + new secrets + deploy steps |

Conventions to follow (existing): no semicolons except where present, single quotes, pure logic in `src/shared/` with sibling `.test.ts`, worker glue untested, JSON error shape `{ error: string }`, `envValue()` escape hatch for secrets not in generated `Env`.

---

### Task 1: Quota window helper (pure, TDD)

**Files:**
- Create: `src/shared/quota.ts`
- Create: `src/shared/quota.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/quota.test.ts
import { describe, expect, it } from 'vitest'
import { DAILY_EXTRACTION_LIMIT, utcDayStartIso } from './quota'

describe('utcDayStartIso', () => {
  it('returns midnight UTC for a mid-day UTC time', () => {
    expect(utcDayStartIso(new Date('2026-06-09T17:42:13.000Z'))).toBe('2026-06-09T00:00:00.000Z')
  })

  it('stays on the UTC date even when local dates differ', () => {
    expect(utcDayStartIso(new Date('2026-06-09T00:00:00.000Z'))).toBe('2026-06-09T00:00:00.000Z')
    expect(utcDayStartIso(new Date('2026-06-09T23:59:59.999Z'))).toBe('2026-06-09T00:00:00.000Z')
  })
})

describe('DAILY_EXTRACTION_LIMIT', () => {
  it('is 25 per the spec', () => {
    expect(DAILY_EXTRACTION_LIMIT).toBe(25)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/quota.test.ts`
Expected: FAIL — cannot resolve `./quota`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/quota.ts
export const DAILY_EXTRACTION_LIMIT = 25

export function utcDayStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/quota.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/quota.ts src/shared/quota.test.ts
git commit -m "feat: add daily extraction quota constants and UTC day window helper"
```

---

### Task 2: iContact CSV exporter (pure, TDD)

**Files:**
- Modify: `src/shared/exporters.ts` (append at end of file)
- Modify: `src/shared/exporters.test.ts` (append new describe blocks)

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/exporters.test.ts` (it already imports from `./exporters`; extend the import list with `exportContactsIContactCsv, splitContactName` and reuse the file's existing contact fixture helper if one exists — otherwise define the minimal contact inline as below):

```ts
import { describe, expect, it } from 'vitest'
import { exportContactsIContactCsv, splitContactName } from './exporters'
import type { Contact } from './types'

function contactFixture(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'c1',
    name: 'Maria de la Cruz',
    company: 'Desert Title',
    role: 'Escrow Officer',
    email: 'maria@deserttitle.com',
    phones: ['(602) 555-0101', '(602) 555-0102'],
    website: 'https://deserttitle.com',
    address: '100 N Central Ave, Phoenix, AZ 85004',
    tags: ['title'],
    notes: 'Met at expo, "great" contact',
    nextStep: 'Send intro email',
    status: 'Follow up',
    sourceImageKey: '',
    sourceImageUrl: '',
    extractionConfidence: 1,
    needsReview: false,
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    ...overrides,
  }
}

describe('splitContactName', () => {
  it('splits first token from the rest', () => {
    expect(splitContactName('Maria de la Cruz')).toEqual({ firstName: 'Maria', lastName: 'de la Cruz' })
  })
  it('handles single-token names', () => {
    expect(splitContactName('Cher')).toEqual({ firstName: 'Cher', lastName: '' })
  })
  it('handles empty and whitespace names', () => {
    expect(splitContactName('   ')).toEqual({ firstName: '', lastName: '' })
  })
})

describe('exportContactsIContactCsv', () => {
  it('emits the iContact header row', () => {
    const lines = exportContactsIContactCsv([]).split('\n')
    expect(lines[0]).toBe('Email,First Name,Last Name,Company,Job Title,Phone,Street,City,State,Zip,Notes')
  })

  it('maps contact fields, splits name, and keeps City/State/Zip blank', () => {
    const lines = exportContactsIContactCsv([contactFixture()]).split('\n')
    expect(lines[1]).toBe(
      'maria@deserttitle.com,Maria,de la Cruz,Desert Title,Escrow Officer,(602) 555-0101,' +
        '"100 N Central Ave, Phoenix, AZ 85004",,,,' +
        '"Met at expo, ""great"" contact | Other phones: (602) 555-0102"',
    )
  })

  it('includes rows without email and without phones', () => {
    const lines = exportContactsIContactCsv([
      contactFixture({ email: '', phones: [], notes: '', name: 'Solo' }),
    ]).split('\n')
    expect(lines[1]).toBe(',Solo,,Desert Title,Escrow Officer,,"100 N Central Ave, Phoenix, AZ 85004",,,,')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/exporters.test.ts`
Expected: FAIL — `splitContactName` / `exportContactsIContactCsv` not exported

- [ ] **Step 3: Implement (append to `src/shared/exporters.ts`)**

```ts
const ICONTACT_HEADERS = ['Email', 'First Name', 'Last Name', 'Company', 'Job Title', 'Phone', 'Street', 'City', 'State', 'Zip', 'Notes']

export function splitContactName(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim()
  if (!trimmed) return { firstName: '', lastName: '' }
  const spaceIndex = trimmed.indexOf(' ')
  if (spaceIndex === -1) return { firstName: trimmed, lastName: '' }
  return { firstName: trimmed.slice(0, spaceIndex), lastName: trimmed.slice(spaceIndex + 1).trim() }
}

export function exportContactsIContactCsv(contacts: Contact[]): string {
  const rows = contacts.map((contact) => {
    const { firstName, lastName } = splitContactName(contact.name)
    const extraPhones = contact.phones.slice(1)
    const notes = [contact.notes, extraPhones.length ? `Other phones: ${extraPhones.join('; ')}` : '']
      .filter(Boolean)
      .join(' | ')
    return [
      contact.email,
      firstName,
      lastName,
      contact.company,
      contact.role,
      contact.phones[0] || '',
      contact.address,
      '',
      '',
      '',
      notes,
    ]
      .map((value) => csvCell(value))
      .join(',')
  })
  return [ICONTACT_HEADERS.join(','), ...rows].join('\n')
}
```

(`csvCell` already exists at the top of the file — reuse it, do not redefine.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/exporters.test.ts`
Expected: PASS (existing + new tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/exporters.ts src/shared/exporters.test.ts
git commit -m "feat: add iContact-format CSV exporter with name splitting"
```

---

### Task 3: Session cookie module (TDD)

**Files:**
- Create: `src/worker/session.ts`
- Create: `src/worker/session.test.ts`

WebCrypto (`crypto.subtle`) is available globally in both Workers and vitest's Node runtime — no imports needed.

- [ ] **Step 1: Write the failing tests**

```ts
// src/worker/session.test.ts
import { describe, expect, it } from 'vitest'
import { createSessionCookieValue, verifySessionCookieValue } from './session'

const SECRET = 'test-secret-at-least-32-bytes-long!!'
const NOW = new Date('2026-06-09T12:00:00.000Z')

describe('session cookie', () => {
  it('round-trips a user id', async () => {
    const value = await createSessionCookieValue('email:mom@title.com', SECRET, NOW)
    expect(await verifySessionCookieValue(value, SECRET, NOW)).toBe('email:mom@title.com')
  })

  it('rejects a tampered payload', async () => {
    const value = await createSessionCookieValue('email:mom@title.com', SECRET, NOW)
    const parts = value.split('.')
    const forged = await createSessionCookieValue('email:evil@x.com', SECRET, NOW)
    const swapped = [parts[0], forged.split('.')[1], parts[2], parts[3]].join('.')
    expect(await verifySessionCookieValue(swapped, SECRET, NOW)).toBeNull()
  })

  it('rejects the wrong secret', async () => {
    const value = await createSessionCookieValue('email:mom@title.com', SECRET, NOW)
    expect(await verifySessionCookieValue(value, 'different-secret-also-long-enough!!', NOW)).toBeNull()
  })

  it('rejects an expired cookie', async () => {
    const value = await createSessionCookieValue('email:mom@title.com', SECRET, NOW)
    const later = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000)
    expect(await verifySessionCookieValue(value, SECRET, later)).toBeNull()
  })

  it('rejects malformed values', async () => {
    expect(await verifySessionCookieValue('', SECRET, NOW)).toBeNull()
    expect(await verifySessionCookieValue('v1.only.three', SECRET, NOW)).toBeNull()
    expect(await verifySessionCookieValue('v2.a.123.sig', SECRET, NOW)).toBeNull()
    expect(await verifySessionCookieValue('v1.!!!.123.sig', SECRET, NOW)).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/worker/session.test.ts`
Expected: FAIL — cannot resolve `./session`

- [ ] **Step 3: Implement**

```ts
// src/worker/session.ts
export const SESSION_COOKIE = 'cardcap_session'
export const SESSION_DURATION_SECONDS = 30 * 24 * 60 * 60

const encoder = new TextEncoder()

export async function createSessionCookieValue(userId: string, secret: string, now = new Date()): Promise<string> {
  const expires = Math.floor(now.getTime() / 1000) + SESSION_DURATION_SECONDS
  const signature = b64urlEncode(await hmac(secret, `${userId}.${expires}`))
  return `v1.${b64urlEncode(encoder.encode(userId))}.${expires}.${signature}`
}

export async function verifySessionCookieValue(value: string, secret: string, now = new Date()): Promise<string | null> {
  const parts = value.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') return null
  const idBytes = b64urlDecode(parts[1])
  const expires = Number(parts[2])
  if (!idBytes || !Number.isInteger(expires)) return null
  if (expires * 1000 <= now.getTime()) return null
  const userId = new TextDecoder().decode(idBytes)
  const expected = b64urlEncode(await hmac(secret, `${userId}.${expires}`))
  return timingSafeEqual(expected, parts[3]) ? userId : null
}

export function sessionSetCookieHeader(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_DURATION_SECONDS}; HttpOnly; Secure; SameSite=Lax`
}

export function sessionClearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

export function sessionCookieFromHeader(cookieHeader: string): string {
  const match = cookieHeader.match(/(?:^|;\s*)cardcap_session=([^;]+)/)
  return match ? match[1] : ''
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
}

function b64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function b64urlDecode(value: string): Uint8Array | null {
  if (!value || /[^A-Za-z0-9_-]/.test(value)) return null
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const binary = atob(padded)
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  } catch {
    return null
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/worker/session.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/worker/session.ts src/worker/session.test.ts
git commit -m "feat: add HMAC-signed stateless session cookies"
```

---

### Task 4: Migration + repository support

**Files:**
- Create: `migrations/0002_login_tokens.sql`
- Modify: `src/worker/repository.ts`

No unit tests (D1-coupled; house convention). Verified by lint + build + the dev-server smoke in Task 9.

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0002_login_tokens.sql
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_login_tokens_email ON login_tokens(email);
```

- [ ] **Step 2: Mirror in `ensureSchema` and add helpers to `repository.ts`**

Add a fourth statement to the existing `db.batch([...])` array inside `ensureSchema`:

```ts
      db.prepare(
        `CREATE TABLE IF NOT EXISTS login_tokens (
          token_hash TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT NOT NULL DEFAULT ''
        )`,
      ),
```

Append these exported functions at the bottom of `repository.ts`:

```ts
export async function upsertUser(db: D1Database, userId: string, email: string, authProvider: string): Promise<void> {
  await ensureSchema(db)
  const now = new Date().toISOString()
  await ensureUser(db, userId, email, email, authProvider, now)
}

export async function countExtractionJobsSince(db: D1Database, userId: string, sinceIso: string): Promise<number> {
  await ensureSchema(db)
  const row = await db
    .prepare('SELECT COUNT(*) AS total FROM extraction_jobs WHERE user_id = ? AND created_at >= ?')
    .bind(userId, sinceIso)
    .first<{ total: number }>()
  return row?.total ?? 0
}

export async function createLoginToken(db: D1Database, tokenHash: string, email: string, expiresAt: string): Promise<void> {
  await ensureSchema(db)
  await db
    .prepare('INSERT INTO login_tokens (token_hash, email, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, email, expiresAt)
    .run()
}

export async function consumeLoginToken(db: D1Database, tokenHash: string, now = new Date()): Promise<string | null> {
  await ensureSchema(db)
  const row = await db
    .prepare('SELECT email, expires_at, used_at FROM login_tokens WHERE token_hash = ?')
    .bind(tokenHash)
    .first<{ email: string; expires_at: string; used_at: string }>()
  if (!row || row.used_at || row.expires_at <= now.toISOString()) return null
  await db
    .prepare('UPDATE login_tokens SET used_at = ? WHERE token_hash = ?')
    .bind(now.toISOString(), tokenHash)
    .run()
  return row.email
}
```

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add migrations/0002_login_tokens.sql src/worker/repository.ts
git commit -m "feat: add login_tokens storage, quota count, and user upsert"
```

---

### Task 5: Worker auth rewrite (config, email, auth modules)

**Files:**
- Create: `src/worker/config.ts`
- Create: `src/worker/email.ts`
- Rewrite: `src/worker/auth.ts`

No unit tests (fetch/D1-coupled glue; the pure crypto lives in Task 3). Verified by lint + existing suite + dev smoke.

- [ ] **Step 1: Create `src/worker/config.ts`**

```ts
// src/worker/config.ts
export function envValue(env: Env, key: string): string {
  const value = (env as unknown as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}
```

- [ ] **Step 2: Create `src/worker/email.ts`**

```ts
// src/worker/email.ts
import { envValue } from './config'

export async function sendLoginEmail(env: Env, to: string, link: string): Promise<void> {
  const apiKey = envValue(env, 'RESEND_API_KEY')
  if (!apiKey) {
    console.log(JSON.stringify({ level: 'info', message: 'magic link (dev, email not sent)', to, link }))
    return
  }
  const sender = envValue(env, 'SENDER_EMAIL')
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: `CardCap <${sender}>`,
      to: [to],
      subject: 'Your CardCap sign-in link',
      text: `Sign in to CardCap:\n\n${link}\n\nThis link works once and expires in 15 minutes. If you didn't request it, ignore this email.`,
      html: `<p>Sign in to CardCap:</p><p><a href="${link}">Open CardCap</a></p><p>This link works once and expires in 15 minutes. If you didn't request it, ignore this email.</p>`,
    }),
  })
  if (!response.ok) {
    console.error(JSON.stringify({ level: 'error', message: 'resend send failed', status: response.status }))
    throw new Error("Couldn't send the email — try again")
  }
}
```

- [ ] **Step 3: Rewrite `src/worker/auth.ts`** (replace entire file)

```ts
// src/worker/auth.ts
import { envValue } from './config'
import { sendLoginEmail } from './email'
import { consumeLoginToken, createLoginToken, localUserId, upsertUser } from './repository'
import {
  createSessionCookieValue,
  sessionClearCookieHeader,
  sessionCookieFromHeader,
  sessionSetCookieHeader,
  verifySessionCookieValue,
} from './session'

export type CurrentUser = {
  id: string
  email: string
}

type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> }

const TOKEN_TTL_MS = 15 * 60 * 1000

export async function currentUser(request: Request, env: Env): Promise<CurrentUser | null> {
  const secret = envValue(env, 'SESSION_SECRET')
  if (secret) {
    const cookieValue = sessionCookieFromHeader(request.headers.get('Cookie') || '')
    if (cookieValue) {
      const userId = await verifySessionCookieValue(decodeURIComponent(cookieValue), secret)
      if (userId) return { id: userId, email: emailFromUserId(userId) }
    }
  }

  const accessUser = cloudflareAccessUser(request)
  if (accessUser) return accessUser

  if (!secret) {
    return { id: localUserId(), email: 'local@cardcap.dev' }
  }

  return null
}

export async function requestLoginLink(request: Request, env: Env, url: URL): Promise<Response> {
  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  const turnstileToken = typeof payload.turnstileToken === 'string' ? payload.turnstileToken : ''

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: 'Enter a valid email address.' }, { status: 400 })
  }

  const ip = request.headers.get('CF-Connecting-IP') || ''
  if (!(await verifyTurnstile(env, turnstileToken, ip))) {
    return Response.json({ error: 'Verification failed, try again.' }, { status: 400 })
  }

  const emailAllowed = await allowed(rateLimiter(env, 'RL_LINK_EMAIL'), email)
  const ipAllowed = await allowed(rateLimiter(env, 'RL_LINK_IP'), ip || 'unknown')
  if (!emailAllowed || !ipAllowed) {
    return Response.json({ error: 'Too many requests — wait a minute.' }, { status: 429 })
  }

  const rawToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '')
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString()
  await createLoginToken(env.DB, await sha256Hex(rawToken), email, expiresAt)

  const link = `${url.origin}/api/auth/verify?token=${rawToken}`
  try {
    await sendLoginEmail(env, email, link)
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Email failed' }, { status: 502 })
  }

  return Response.json({ ok: true })
}

export async function verifyLogin(request: Request, env: Env, url: URL): Promise<Response> {
  const rawToken = url.searchParams.get('token') || ''
  const secret = envValue(env, 'SESSION_SECRET')
  if (!rawToken || !secret) return expiredLinkPage()

  const email = await consumeLoginToken(env.DB, await sha256Hex(rawToken))
  if (!email) return expiredLinkPage()

  const userId = `email:${email}`
  await upsertUser(env.DB, userId, email, 'magic-link')
  const cookie = await createSessionCookieValue(userId, secret)
  return new Response(null, {
    status: 302,
    headers: {
      location: '/',
      'set-cookie': sessionSetCookieHeader(encodeURIComponent(cookie)),
      'cache-control': 'no-store',
    },
  })
}

export function logout(): Response {
  return Response.json(
    { ok: true },
    { headers: { 'set-cookie': sessionClearCookieHeader(), 'cache-control': 'no-store' } },
  )
}

export function authConfig(env: Env): Response {
  return Response.json({ turnstileSiteKey: envValue(env, 'TURNSTILE_SITE_KEY') })
}

export function rateLimiter(env: Env, name: string): RateLimiter | undefined {
  const binding = (env as unknown as Record<string, unknown>)[name]
  return binding && typeof (binding as RateLimiter).limit === 'function' ? (binding as RateLimiter) : undefined
}

export async function allowed(limiter: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return true
  const { success } = await limiter.limit({ key })
  return success
}

async function verifyTurnstile(env: Env, token: string, ip: string): Promise<boolean> {
  const secret = envValue(env, 'TURNSTILE_SECRET_KEY')
  if (!secret) return true
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret, response: token, remoteip: ip || undefined }),
  })
  const data = (await response.json().catch(() => ({}))) as { success?: boolean }
  return Boolean(data.success)
}

function emailFromUserId(userId: string): string {
  return userId.startsWith('email:') ? userId.slice('email:'.length) : ''
}

function cloudflareAccessUser(request: Request): CurrentUser | null {
  const emailHeader = request.headers.get('Cf-Access-Authenticated-User-Email')
  if (emailHeader) {
    const email = emailHeader.trim().toLowerCase()
    return { id: `email:${email}`, email }
  }

  const jwt = request.headers.get('Cf-Access-Jwt-Assertion') || authorizationCookie(request)
  const payload = jwt ? decodeJwtPayload(jwt) : null
  const email = typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : ''
  const sub = typeof payload?.sub === 'string' ? payload.sub.trim() : ''

  if (sub || email) {
    return { id: sub ? `access:${sub}` : `email:${email}`, email }
  }

  return null
}

function authorizationCookie(request: Request): string {
  const cookie = request.headers.get('Cookie') || ''
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : ''
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const payload = jwt.split('.')[1]
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    return JSON.parse(atob(padded)) as Record<string, unknown>
  } catch {
    return null
  }
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cardcap:${input}`))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function expiredLinkPage(): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CardCap</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f8;color:#20242a}main{text-align:center;padding:24px}a{color:#146c5f}</style></head>
<body><main><h1>That link expired or was already used</h1><p>Sign-in links work once and expire after 15 minutes.</p><p><a href="/">Request a new link</a></p></main></body></html>`,
    { status: 410, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )
}
```

Notes: `createBetaSession`, `hasBetaSession`, `betaCookieValue` are gone. Local-dev fallback rule: no `SESSION_SECRET` → local user (same net behavior as today's no-`BETA_ACCESS_CODE` path). `REQUIRE_ACCESS` var is retired.

- [ ] **Step 4: Lint + full test run**

Run: `npm run lint && npm test`
Expected: lint clean; suite passes (worker/index.ts still imports `createBetaSession` — if lint/type errors surface from that, Task 6 fixes them; in that case run lint again at end of Task 6 instead. To keep every commit green, you may fold Step 4 into Task 6's verification.)

- [ ] **Step 5: Commit** (combined with Task 6 if the build is only green after routing changes)

```bash
git add src/worker/config.ts src/worker/email.ts src/worker/auth.ts
git commit -m "feat: replace beta-code auth with magic-link auth"
```

---

### Task 6: Route wiring (index.ts)

**Files:**
- Modify: `src/worker/index.ts`

- [ ] **Step 1: Update imports**

Replace the line `import { createBetaSession, currentUser } from './auth'` with:

```ts
import { allowed, authConfig, currentUser, logout, rateLimiter, requestLoginLink, verifyLogin } from './auth'
import { DAILY_EXTRACTION_LIMIT, utcDayStartIso } from '../shared/quota'
```

Extend the exporters import with `exportContactsIContactCsv`, and the repository import with `countExtractionJobsSince`.

- [ ] **Step 2: Replace the session route and 401 message in `route()`**

Replace:

```ts
  if (request.method === 'POST' && url.pathname === '/api/session') {
    return createBetaSession(request, env)
  }

  const user = await currentUser(request, env)
  if (!user) {
    return json({ error: 'Private beta code or Cloudflare Access sign-in is required.' }, 401)
  }
```

with:

```ts
  if (request.method === 'GET' && url.pathname === '/api/auth/config') {
    return authConfig(env)
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/request-link') {
    return requestLoginLink(request, env, url)
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/verify') {
    return verifyLogin(request, env, url)
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    return logout()
  }

  const user = await currentUser(request, env)
  if (!user) {
    return json({ error: 'Sign in to continue.' }, 401)
  }

  if (request.method === 'GET' && url.pathname === '/api/me') {
    return json({ email: user.email, id: user.id })
  }
```

- [ ] **Step 3: Add quota + burst guard at the top of `uploadCard()`**, immediately after the function signature line:

```ts
  if (!(await allowed(rateLimiter(env, 'RL_UPLOAD'), userId))) {
    return json({ error: 'Slow down a moment — too many uploads at once.' }, 429)
  }
  const usedToday = await countExtractionJobsSince(env.DB, userId, utcDayStartIso())
  if (usedToday >= DAILY_EXTRACTION_LIMIT) {
    return json(
      { error: `Daily limit of ${DAILY_EXTRACTION_LIMIT} cards reached — resets tonight (UTC). Email cody@copperstateit.com if you need more.` },
      429,
    )
  }
```

- [ ] **Step 4: Add the iContact export route** next to the other export routes:

```ts
  if (request.method === 'GET' && url.pathname === '/api/export.icontact.csv') {
    return download(
      exportContactsIContactCsv(sortContactsByName(await listContacts(env.DB, user.id))),
      'text/csv; charset=utf-8',
      'cardcap-icontact.csv',
    )
  }
```

- [ ] **Step 5: Lint, test, build**

Run: `npm run lint && npm test && npm run build`
Expected: all green (build includes `tsc -b`)

- [ ] **Step 6: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat: wire auth routes, daily quota guard, and iContact export endpoint"
```

---

### Task 7: Wrangler config + types + dev vars

**Files:**
- Modify: `wrangler.jsonc`
- Regenerate: `worker-configuration.d.ts`
- Modify: `.dev.vars.example`

- [ ] **Step 1: Update `wrangler.jsonc`** — replace the `vars` block and add `ratelimits` after `r2_buckets`:

```jsonc
  "vars": {
    "AI_EXTRACTOR": "openai",
    "OPENAI_MODEL": "gpt-5.4-mini",
    "SENDER_EMAIL": "cardcap@copperstateit.com",
    "TURNSTILE_SITE_KEY": ""
  },
```

```jsonc
  "ratelimits": [
    { "name": "RL_LINK_EMAIL", "namespace_id": "1001", "simple": { "limit": 2, "period": 60 } },
    { "name": "RL_LINK_IP", "namespace_id": "1002", "simple": { "limit": 5, "period": 60 } },
    { "name": "RL_UPLOAD", "namespace_id": "1003", "simple": { "limit": 10, "period": 60 } }
  ],
```

(`TURNSTILE_SITE_KEY` stays empty in the repo until the Turnstile site is created at deploy time; empty = widget skipped, dev-friendly. Site keys are public, so committing the real value later is fine.)

- [ ] **Step 2: Regenerate types**

Run: `npx wrangler types`
Expected: `worker-configuration.d.ts` regenerated; `Env` now includes `SENDER_EMAIL`, `TURNSTILE_SITE_KEY`, and the three `RateLimit` bindings.

- [ ] **Step 3: Update `.dev.vars.example`** — append:

```text
# Auth (local dev: leave SESSION_SECRET unset to auto-login as the local user)
SESSION_SECRET=
RESEND_API_KEY=
TURNSTILE_SECRET_KEY=
```

- [ ] **Step 4: Lint + build**

Run: `npm run lint && npm run build`
Expected: green

- [ ] **Step 5: Commit**

```bash
git add wrangler.jsonc worker-configuration.d.ts .dev.vars.example
git commit -m "chore: add auth vars and rate-limit bindings to wrangler config"
```

---

### Task 8: Frontend — LoginGate + App wiring

**Files:**
- Create: `src/components/LoginGate.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css` (only if `.unlock-*` styles need a tweak; reuse them)

- [ ] **Step 1: Create `src/components/LoginGate.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import { apiGet, apiJson } from '../lib/api'

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, options: { sitekey: string; callback: (token: string) => void; 'expired-callback'?: () => void }) => string
      reset: (widgetId?: string) => void
    }
  }
}

type LoginGateProps = {
  onSignedIn: () => void
}

export function LoginGate({ onSignedIn }: LoginGateProps) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [siteKey, setSiteKey] = useState('')
  const [turnstileToken, setTurnstileToken] = useState('')
  const widgetRef = useRef<HTMLDivElement | null>(null)
  const widgetIdRef = useRef('')

  useEffect(() => {
    let cancelled = false
    apiGet<{ turnstileSiteKey: string }>('/api/auth/config')
      .then((config) => {
        if (!cancelled) setSiteKey(config.turnstileSiteKey)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!siteKey || !widgetRef.current) return
    const renderWidget = () => {
      if (widgetRef.current && window.turnstile && !widgetIdRef.current) {
        widgetIdRef.current = window.turnstile.render(widgetRef.current, {
          sitekey: siteKey,
          callback: (token) => setTurnstileToken(token),
          'expired-callback': () => setTurnstileToken(''),
        })
      }
    }
    if (window.turnstile) {
      renderWidget()
      return
    }
    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
    script.async = true
    script.onload = renderWidget
    document.head.appendChild(script)
  }, [siteKey])

  async function requestLink() {
    const trimmed = email.trim()
    if (!trimmed) return
    setBusy(true)
    setError('')
    try {
      await apiJson<{ ok: boolean }>('/api/auth/request-link', 'POST', {
        email: trimmed,
        turnstileToken,
      })
      setSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      if (window.turnstile && widgetIdRef.current) {
        window.turnstile.reset(widgetIdRef.current)
        setTurnstileToken('')
      }
    } finally {
      setBusy(false)
    }
  }

  // Dev convenience: with no SESSION_SECRET the API auto-authenticates, so /api/me succeeds.
  useEffect(() => {
    apiGet<{ email: string }>('/api/me')
      .then(() => onSignedIn())
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <main className="unlock-screen">
      <section className="unlock-panel">
        <h2>Sign in to CardCap</h2>
        {!sent && (
          <>
            <p>Enter your email and we&apos;ll send you a one-time sign-in link. No password needed.</p>
            <label>
              Email
              <input
                type="email"
                value={email}
                autoComplete="email"
                placeholder="you@company.com"
                onChange={(event) => setEmail(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void requestLink()
                }}
              />
            </label>
            {siteKey && <div ref={widgetRef} className="turnstile-slot" />}
            <button
              className="btn primary"
              type="button"
              onClick={() => void requestLink()}
              disabled={busy || !email.trim() || (Boolean(siteKey) && !turnstileToken)}
            >
              Email me a sign-in link
            </button>
          </>
        )}
        {sent && (
          <>
            <p>
              <strong>Check your email.</strong> We sent a sign-in link to {email.trim()}. It works once and expires in 15
              minutes.
            </p>
            <p>Don&apos;t see it? Check your spam or junk folder.</p>
            <button className="btn" type="button" onClick={() => void requestLink()} disabled={busy}>
              Send it again
            </button>
          </>
        )}
        {error && <div className="banner error">{error}</div>}
        <p className="privacy-note">Your contacts are private and yours — export or delete them anytime.</p>
      </section>
    </main>
  )
}
```

- [ ] **Step 2: Wire `App.tsx`**

2a. Replace the import line `import { apiGet, apiJson, apiUpload } from './lib/api'` — unchanged — and add below the other imports:

```ts
import { LoginGate } from './components/LoginGate'
```

2b. Replace state `const [accessCode, setAccessCode] = useState('')` with:

```ts
const [userEmail, setUserEmail] = useState('')
```

2c. Replace the `loadContacts` catch block's beta-message sniffing:

```ts
      } catch (err) {
        const message = messageFrom(err)
        if (message.includes('Sign in to continue')) {
          setAuthRequired(true)
          setError('')
        } else {
          setError(message)
        }
      } finally {
```

2d. Replace the boot effect with an auth-aware boot:

```ts
  useEffect(() => {
    let cancelled = false
    async function boot() {
      try {
        const me = await apiGet<{ email: string }>('/api/me')
        if (cancelled) return
        setUserEmail(me.email)
        await loadContacts()
      } catch {
        if (cancelled) return
        setAuthRequired(true)
        setLoading(false)
      }
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [loadContacts])
```

2e. Delete the whole `unlockBeta` function. Add in its place:

```ts
  async function handleSignedIn() {
    setAuthRequired(false)
    const me = await apiGet<{ email: string }>('/api/me').catch(() => null)
    setUserEmail(me?.email || '')
    await loadContacts()
  }

  async function signOut() {
    await apiJson<{ ok: boolean }>('/api/auth/logout', 'POST').catch(() => undefined)
    setUserEmail('')
    setContacts([])
    selectContact(null)
    setAuthRequired(true)
  }
```

2f. In the toolbar, after the HTML export button, add the iContact button and the sign-out control:

```tsx
          <button className="btn" type="button" onClick={() => exportUrl('/api/export.icontact.csv')}>
            iContact CSV
          </button>
          {userEmail && (
            <button className="btn" type="button" onClick={() => void signOut()} title={userEmail}>
              Sign out
            </button>
          )}
```

2g. Replace the entire `{authRequired && ( <main className="unlock-screen"> ... </main> )}` block with:

```tsx
      {authRequired && <LoginGate onSignedIn={() => void handleSignedIn()} />}
```

- [ ] **Step 3: Add minimal CSS** (append to `src/App.css`):

```css
.turnstile-slot {
  min-height: 65px;
  margin: 8px 0;
}

.privacy-note {
  font-size: 12px;
  opacity: 0.7;
  margin-top: 16px;
}
```

- [ ] **Step 4: Lint, test, build**

Run: `npm run lint && npm test && npm run build`
Expected: green

- [ ] **Step 5: Local smoke**

Run: `npm run dev -- --host 127.0.0.1` (background), then `Invoke-RestMethod http://127.0.0.1:5173/api/health` and `Invoke-RestMethod http://127.0.0.1:5173/api/me`
Expected: health `ok: true`; `/api/me` returns the local dev user (`local@cardcap.dev`) since `SESSION_SECRET` is unset locally. Then to exercise the real flow locally: set `SESSION_SECRET=dev-secret-32-chars-xxxxxxxxxxxxx` in `.dev.vars`, restart, load `http://127.0.0.1:5173/` → LoginGate renders → submit an email → magic link prints to the dev-server console → open it → app loads signed in → Sign out returns to LoginGate. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add src/components/LoginGate.tsx src/App.tsx src/App.css
git commit -m "feat: add magic-link login gate, sign-out, and iContact export button"
```

---

### Task 9: Docs + final verification

**Files:**
- Modify: `README.md` (auth section: replace beta-code mentions; document new dev vars + iContact export)
- Modify: `DEPLOYMENT.md` (secrets list + deploy sequence from the spec)

- [ ] **Step 1: Update README.md** — in "What Works Now" add `- Sign in with a one-time email link (magic link); each user has a private contact list.` and `- Export an iContact-ready CSV for email-marketing imports.`; under "Turn On OpenAI Extraction Locally" add the new `.dev.vars` keys with one line each; replace the "Auth is not wired yet" production gap with the new reality.

- [ ] **Step 2: Update DEPLOYMENT.md** — Secrets section becomes: `OPENAI_API_KEY`, `SESSION_SECRET`, `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY` (and remove `BETA_ACCESS_CODE`). Add the spec's deploy sequence verbatim (snapshot → wipe → migrations → Turnstile site → secrets → delete BETA_ACCESS_CODE → build/deploy → smoke incl. corporate-inbox spam check).

- [ ] **Step 3: Full verification suite**

Run: `npm run lint && npm test && npm run build && npx wrangler deploy --dry-run`
Expected: all green

- [ ] **Step 4: Commit**

```bash
git add README.md DEPLOYMENT.md
git commit -m "docs: document magic-link auth, quotas, and iContact export"
```

---

### Task 10: Deploy (requires Cody — dashboard + secrets)

Not automatable end-to-end; checklist for when Cody is present:

- [ ] `npx wrangler d1 export cardcap-db --remote --output backup-2026-06-09.sql`
- [ ] `npx wrangler d1 execute cardcap-db --remote --command "DELETE FROM extraction_jobs; DELETE FROM contacts; DELETE FROM users;"`
- [ ] `npx wrangler d1 migrations apply cardcap-db --remote`
- [ ] Create Turnstile widget in Cloudflare dash (Managed mode, domain `cardcap.codylecates.workers.dev`); paste site key into `wrangler.jsonc` `TURNSTILE_SITE_KEY`; `npx wrangler secret put TURNSTILE_SECRET_KEY`
- [ ] `npx wrangler secret put SESSION_SECRET` (32+ random chars), `npx wrangler secret put RESEND_API_KEY`
- [ ] Confirm `SENDER_EMAIL` domain verified in Resend (DKIM green); adjust `SENDER_EMAIL` var if using a different domain
- [ ] `npx wrangler secret delete BETA_ACCESS_CODE`
- [ ] `npm run build && npx wrangler deploy`
- [ ] Smoke: `/api/health` → `ok`; full login round-trip on a phone; check a corporate-ish inbox's spam folder; upload one card (`extractionMode: "openai"`); download iContact CSV and test-import into mom's iContact

---

## Self-review notes

- Spec coverage: auth flow (Tasks 3–6, 8), quota 25 + bursts (Tasks 1, 6, 7), iContact CSV (Tasks 2, 6, 8), Turnstile (5, 7, 8), fresh start + snapshot (10), docs (9), no-enumeration response (Task 5 `requestLoginLink` returns `ok` regardless of account existence — and there are no pre-existing accounts to enumerate), spam-folder UX + resend button (Task 8), admin Access backdoor kept (Task 5).
- Type consistency: `RateLimiter` structural type used in auth.ts only; index.ts imports `allowed`/`rateLimiter` from auth.ts. `consumeLoginToken` returns `string | null` email. Cookie value is `encodeURIComponent`-wrapped at set and decoded at read.
- Intentional deviation: lint/test may be transiently red between Tasks 5 and 6 (index.ts references old auth exports until rewired); if so, commit Tasks 5+6 together after Task 6's verification.
