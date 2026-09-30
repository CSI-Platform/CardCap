const HASH_ALGORITHM = 'pbkdf2-sha256'
// Cloudflare Workers caps native PBKDF2 at 100,000 iterations per invocation.
const DEFAULT_ITERATIONS = 100_000
const DEFAULT_SALT_BYTES = 16
const DERIVED_BITS = 256

const encoder = new TextEncoder()

export type PasswordHashOptions = {
  iterations?: number
  saltBytes?: number
}

export function validatePassword(password: string): string {
  if (password.length < 8) return 'Password must be at least 8 characters.'
  if (password.length > 256) return 'Password must be 256 characters or fewer.'
  return ''
}

export async function hashPassword(password: string, options: PasswordHashOptions = {}): Promise<string> {
  const validationError = validatePassword(password)
  if (validationError) throw new Error(validationError)

  const iterations = options.iterations || DEFAULT_ITERATIONS
  const salt = crypto.getRandomValues(new Uint8Array(options.saltBytes || DEFAULT_SALT_BYTES))
  const derived = await derivePassword(password, salt, iterations)
  return [HASH_ALGORITHM, String(iterations), b64urlEncode(salt), b64urlEncode(derived)].join('$')
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (validatePassword(password)) return false

  const parsed = parseStoredHash(storedHash)
  if (!parsed) return false

  const derived = b64urlEncode(await derivePassword(password, parsed.salt, parsed.iterations))
  return timingSafeEqual(derived, parsed.hash)
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations,
    },
    key,
    DERIVED_BITS,
  )
  return new Uint8Array(bits)
}

function parseStoredHash(value: string): { salt: Uint8Array; iterations: number; hash: string } | null {
  const parts = value.split('$')
  if (parts.length !== 4 || parts[0] !== HASH_ALGORITHM) return null

  const iterations = Number(parts[1])
  if (!Number.isInteger(iterations) || iterations <= 0 || iterations > DEFAULT_ITERATIONS) return null

  const salt = b64urlDecode(parts[2])
  if (!salt || !parts[3] || /[^A-Za-z0-9_-]/.test(parts[3])) return null

  return { salt, iterations, hash: parts[3] }
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
