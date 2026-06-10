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
