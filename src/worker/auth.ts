import { envValue } from './config'
import { sendLoginEmail } from './email'
import { hashPassword, validatePassword, verifyPassword } from './password'
import { consumeLoginToken, createLoginToken, getUserByEmail, setUserPasswordHash, upsertUser } from './repository'
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

const DUMMY_PASSWORD_HASH = 'pbkdf2-sha256$100000$AAECAwQFBgcICQoLDA0ODw$yE52fSYE8F1KRwSGPxGtoexmPPJ-zYRWxZMDIEJ2CQY'

const TOKEN_TTL_MS = 15 * 60 * 1000

export async function currentUser(request: Request, env: Env): Promise<CurrentUser | null> {
  const secret = envValue(env, 'SESSION_SECRET')
  if (!secret) return null
  const cookieValue = sessionCookieFromHeader(request.headers.get('Cookie') || '')
  if (!cookieValue) return null
  try {
    const userId = await verifySessionCookieValue(decodeURIComponent(cookieValue), secret)
    return userId ? { id: userId, email: emailFromUserId(userId) } : null
  } catch {
    return null
  }
}

export async function requestLoginLink(request: Request, env: Env, url: URL): Promise<Response> {
  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  const turnstileToken = typeof payload.turnstileToken === 'string' ? payload.turnstileToken : ''

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: 'Enter a valid email address.' }, { status: 400 })
  }

  if (!envValue(env, 'SESSION_SECRET')) {
    return Response.json({ error: 'Sign-in is not configured.' }, { status: 503 })
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
  } catch {
    return Response.json({ error: 'Unable to send a sign-in link. Please try again.' }, { status: 502 })
  }

  return Response.json({ ok: true })
}

export async function passwordLogin(request: Request, env: Env): Promise<Response> {
  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  const password = typeof payload.password === 'string' ? payload.password : ''

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) {
    return Response.json({ error: 'Enter your email and password.' }, { status: 400 })
  }

  const secret = envValue(env, 'SESSION_SECRET')
  if (!secret) {
    return Response.json({ error: 'Password login is not configured.' }, { status: 503 })
  }

  const ip = request.headers.get('CF-Connecting-IP') || ''
  const emailAllowed = await allowed(rateLimiter(env, 'RL_PASSWORD_EMAIL'), `${ip || 'unknown'}:${email}`)
  const ipAllowed = await allowed(rateLimiter(env, 'RL_PASSWORD_IP'), ip || 'unknown')
  if (!emailAllowed || !ipAllowed) {
    return Response.json({ error: 'Too many requests — wait a minute.' }, { status: 429 })
  }

  const user = await getUserByEmail(env.DB, email)
  const passwordMatches = await verifyPassword(password, user?.passwordHash || DUMMY_PASSWORD_HASH)
  if (!user?.passwordHash || !passwordMatches) {
    return invalidPasswordResponse()
  }

  const cookie = await createSessionCookieValue(user.id, secret)
  return Response.json(
    { ok: true, email: user.email },
    {
      headers: {
        'set-cookie': sessionSetCookieHeader(encodeURIComponent(cookie)),
        'cache-control': 'no-store',
      },
    },
  )
}

export async function setAccountPassword(request: Request, env: Env, user: CurrentUser): Promise<Response> {
  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const password = typeof payload.password === 'string' ? payload.password : ''
  const validationError = validatePassword(password)
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 })
  }

  await setUserPasswordHash(env.DB, user.id, await hashPassword(password), user.email)
  return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
}

export async function verifyLogin(env: Env, url: URL): Promise<Response> {
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

function invalidPasswordResponse(): Response {
  return Response.json({ error: 'Invalid email or password.' }, { status: 401, headers: { 'cache-control': 'no-store' } })
}
