import { localUserId } from './repository'

export type CurrentUser = {
  id: string
  email: string
}

export async function currentUser(request: Request, env: Env): Promise<CurrentUser | null> {
  const accessUser = cloudflareAccessUser(request)
  if (accessUser) return accessUser

  if (envValue(env, 'BETA_ACCESS_CODE')) {
    const hasSession = await hasBetaSession(request, env)
    return hasSession ? { id: 'beta:user', email: 'beta@cardcap.dev' } : null
  }

  if (envValue(env, 'REQUIRE_ACCESS') === 'true') return null

  return {
    id: localUserId(),
    email: 'local@cardcap.dev',
  }
}

export async function createBetaSession(request: Request, env: Env): Promise<Response> {
  const code = envValue(env, 'BETA_ACCESS_CODE')
  if (!code) return Response.json({ ok: true, enabled: false })

  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>
  if (typeof payload.code !== 'string' || payload.code !== code) {
    return Response.json({ error: 'Private beta code did not match.' }, { status: 401 })
  }

  const cookie = await betaCookieValue(code)
  return Response.json(
    { ok: true, enabled: true },
    {
      headers: {
        'set-cookie': `cardcap_beta=${cookie}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
        'cache-control': 'no-store',
      },
    },
  )
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
    return {
      id: sub ? `access:${sub}` : `email:${email}`,
      email,
    }
  }

  return null
}

function authorizationCookie(request: Request): string {
  const cookie = request.headers.get('Cookie') || ''
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : ''
}

async function hasBetaSession(request: Request, env: Env): Promise<boolean> {
  const cookie = request.headers.get('Cookie') || ''
  const match = cookie.match(/(?:^|;\s*)cardcap_beta=([^;]+)/)
  if (!match) return false
  return decodeURIComponent(match[1]) === (await betaCookieValue(envValue(env, 'BETA_ACCESS_CODE')))
}

async function betaCookieValue(code: string): Promise<string> {
  const input = new TextEncoder().encode(`cardcap:${code}`)
  const digest = await crypto.subtle.digest('SHA-256', input)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
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

function envValue(env: Env, key: string): string {
  const value = (env as unknown as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}
