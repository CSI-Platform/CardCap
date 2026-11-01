import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { accessIdentity } from '../src/worker/access'

const issuer = 'https://crypto-test.cloudflareaccess.com'
const audience = 'test-app-audience'
const env = { ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience, ACCESS_ALLOWED_HOSTS: 'cardcap.test' } as unknown as Env
let keys: Awaited<ReturnType<typeof generateKeyPair>>
let foreignKeys: Awaited<ReturnType<typeof generateKeyPair>>

beforeAll(async () => {
  keys = await generateKeyPair('RS256', { extractable: true })
  foreignKeys = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== `${issuer}/cdn-cgi/access/certs`) throw new Error('Unexpected key source')
    return Response.json({ keys: [jwk] })
  })
})
afterAll(() => vi.unstubAllGlobals())

async function token(changes: Record<string, unknown> = {}, foreign = false) {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ iss: issuer, aud: audience, sub: 'human-123', email: 'Owner@Example.invalid', type: 'app', iat: now, exp: now + 3600, ...changes })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(foreign ? foreignKeys.privateKey : keys.privateKey)
}
function request(jwt?: string, url = 'https://cardcap.test/api/me', headers: Record<string, string> = {}) {
  return new Request(url, { headers: { ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}), ...headers } })
}

describe('signed Access identity verification', () => {
  it('accepts a real RSA signature and normalizes the signed email', async () => {
    expect(await accessIdentity(request(await token()), env)).toEqual({ issuer, subject: 'human-123', email: 'owner@example.invalid' })
  })
  it.each([
    { iss: 'https://attacker.cloudflareaccess.com' }, { aud: 'other-app' },
    { exp: 1 }, { iat: 9999999999 }, { nbf: 9999999999 },
    { sub: '' }, { email: null }, { email: 'not-an-email' }, { type: 'org' },
    { exp: undefined }, { iat: undefined },
  ])('rejects invalid signed claims %j', async changes => {
    expect(await accessIdentity(request(await token(changes)), env)).toBeNull()
  })
  it('rejects a signature from an unrelated key', async () => {
    expect(await accessIdentity(request(await token({}, true)), env)).toBeNull()
  })
  it('rejects an unsigned token and header-only identity', async () => {
    const encoded = btoa(JSON.stringify({ email: 'owner@example.invalid', sub: 'human-123' }))
    expect(await accessIdentity(request(`eyJhbGciOiJub25lIn0.${encoded}.`), env)).toBeNull()
    expect(await accessIdentity(request(undefined, undefined, { 'Cf-Access-Authenticated-User-Email': 'owner@example.invalid', Cookie: 'cardcap_session=forged; CF_Authorization=forged' }), env)).toBeNull()
  })
  it('rejects alternate hosts even with a valid signed token and forwarded host', async () => {
    const jwt = await token()
    expect(await accessIdentity(request(jwt, 'https://alternate.workers.dev/api/me', { 'X-Forwarded-Host': 'cardcap.test' }), env)).toBeNull()
    expect(await accessIdentity(request(jwt, undefined, { Host: 'alternate.workers.dev' }), env)).toBeNull()
  })
})
