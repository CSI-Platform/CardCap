import { createHmac, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'

// Cloudflare Access simulator for tests: a throwaway RSA key pair, the JWKS the Worker will fetch from
// <issuer>/cdn-cgi/access/certs (served by the harness's outbound interceptor), and a signed-JWT minter.
// Nothing here can reach production: the keys exist only in the test process.

export const ACCESS_ISSUER = 'https://csi-test.cloudflareaccess.com'
export const ACCESS_AUDIENCE = 'aud-tag-for-cardcap-tests-0123456789'
export const ACCESS_HOSTS = ['cardcap.test', 'cardcap.example.test']
export const JWKS_URL = `${ACCESS_ISSUER}/cdn-cgi/access/certs`

export type AccessKey = { kid: string; privateKey: KeyObject; jwk: Record<string, unknown> }

export function makeAccessKey(kid: string): AccessKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
  return { kid, privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } }
}

export type TokenClaims = {
  iss?: string
  aud?: string | string[]
  sub?: string
  email?: string | null
  type?: string
  iat?: number
  nbf?: number
  exp?: number
  [key: string]: unknown
}

export type MintOptions = {
  key: AccessKey
  alg?: 'RS256' | 'HS256' | 'none'
  kid?: string | null
  claims?: TokenClaims
  /** flip a byte in the signature after signing */
  tamperSignature?: boolean
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url')

export function defaultClaims(email: string, sub = `sub-${email}`, now = Math.floor(Date.now() / 1000)): TokenClaims {
  return { iss: ACCESS_ISSUER, aud: [ACCESS_AUDIENCE], sub, email, type: 'app', iat: now - 5, nbf: now - 5, exp: now + 300 }
}

export function mintToken(options: MintOptions): string {
  const { key, alg = 'RS256', claims = {} } = options
  const header: Record<string, unknown> = { alg, typ: 'JWT' }
  const kid = options.kid === undefined ? key.kid : options.kid
  if (kid !== null) header.kid = kid
  const payload = claims
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  let signature: Buffer
  if (alg === 'none') {
    signature = Buffer.alloc(0)
  } else if (alg === 'HS256') {
    // Classic algorithm-confusion attempt: HMAC using the public key material as the secret.
    signature = createHmac('sha256', String(key.jwk.n)).update(signingInput).digest()
  } else {
    signature = createSign('RSA-SHA256').update(signingInput).sign(key.privateKey)
  }
  if (options.tamperSignature && signature.length > 0) {
    signature = Buffer.from(signature)
    signature[0] ^= 0xff
  }
  return `${signingInput}.${b64url(signature)}`
}
