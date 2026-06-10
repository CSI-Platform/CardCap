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
