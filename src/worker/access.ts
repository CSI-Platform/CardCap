import { createRemoteJWKSet, jwtVerify } from 'jose'
import { envValue } from './config'
import type { CurrentUser } from './auth'

export class AccessConfigurationError extends Error {}
export class AccessAccountConflictError extends Error {}

export function authenticationMode(env: Env): 'legacy' | 'access' {
  const mode = envValue(env, 'AUTH_MODE') || 'legacy'
  if (mode !== 'legacy' && mode !== 'access') throw new AccessConfigurationError('Invalid authentication mode')
  return mode
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export async function accessIdentity(request: Request, env: Env): Promise<{ issuer: string; subject: string; email: string } | null> {
  const issuer = envValue(env, 'ACCESS_ISSUER')
  const audience = envValue(env, 'ACCESS_AUDIENCE')
  const hosts = envValue(env, 'ACCESS_ALLOWED_HOSTS').split(',').map(host => host.trim().toLowerCase()).filter(Boolean)
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !audience || !hosts.length ||
      hosts.some(host => !/^[a-z0-9.-]+(?::[0-9]+)?$/.test(host))) {
    throw new AccessConfigurationError('Access is not configured')
  }
  const url = new URL(request.url)
  if (!hosts.includes(url.host.toLowerCase())) return null
  const hostHeader = request.headers.get('host')
  if (hostHeader && hostHeader.toLowerCase() !== url.host.toLowerCase()) return null
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token || token.length > 16384) return null
  let keySet = keySets.get(issuer)
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 })
    keySets.set(issuer, keySet)
  }
  try {
    const { payload } = await jwtVerify(token, keySet, {
      issuer, audience, algorithms: ['RS256'], requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub'],
    })
    const now = Math.floor(Date.now() / 1000)
    if (payload.type !== 'app' || typeof payload.iat !== 'number' || payload.iat > now ||
        typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 512 ||
        typeof payload.email !== 'string' || payload.email.length > 254) return null
    const email = payload.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
    return { issuer, subject: payload.sub, email }
  } catch {
    return null
  }
}

export async function resolveAccessUser(db: D1Database, identity: { issuer: string; subject: string; email: string }): Promise<CurrentUser> {
  const { issuer, subject, email } = identity
  const readMapping = () => db.prepare(`SELECT users.id, users.email FROM access_identities
    JOIN users ON users.id = access_identities.user_id WHERE issuer = ? AND subject = ?`).bind(issuer, subject).first<CurrentUser>()
  const existing = await readMapping()
  const candidates = await db.prepare('SELECT id FROM users WHERE lower(trim(email)) = ? LIMIT 2').bind(email).all<{ id: string }>()
  if (candidates.results.length > 1 || (existing && existing.email.trim().toLowerCase() !== email)) {
    throw new AccessAccountConflictError('Account mapping requires review')
  }
  if (existing) return existing
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${issuer}\0${subject}`))
  const id = `access:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
  const now = new Date().toISOString()
  // D1 batches are transactional; a concurrent first login cannot replace an owner ID.
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO users (id, email, name, auth_provider, created_at, updated_at)
      SELECT ?, ?, ?, 'access', ?, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(trim(email)) = ?)`)
      .bind(id, email, email.split('@')[0], now, now, email),
    db.prepare(`INSERT OR IGNORE INTO access_identities (issuer, subject, user_id, created_at)
      SELECT ?, ?, id, ? FROM users WHERE lower(trim(email)) = ?
      AND (SELECT count(*) FROM users WHERE lower(trim(email)) = ?) = 1`).bind(issuer, subject, now, email, email),
  ])
  const mapped = await readMapping()
  if (!mapped || mapped.email.trim().toLowerCase() !== email) throw new AccessAccountConflictError('Account mapping requires review')
  return mapped
}
