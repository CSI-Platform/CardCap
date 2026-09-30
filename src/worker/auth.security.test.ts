import { describe, expect, it } from 'vitest'
import { currentUser, requestLoginLink } from './auth'
import { createSessionCookieValue } from './session'

const SECRET = 'test-session-secret-at-least-32-bytes'
const USER_ID = 'email:owner@example.invalid'

function unsignedAccessToken(): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  return `${encode({ alg: 'none' })}.${encode({ sub: 'victim', email: 'victim@example.invalid' })}.`
}

describe('currentUser', () => {
  it.each([
    ['Access email header', { 'Cf-Access-Authenticated-User-Email': 'victim@example.invalid' }],
    ['unsigned Access assertion', { 'Cf-Access-Jwt-Assertion': unsignedAccessToken() }],
    ['unsigned Access cookie', { Cookie: `CF_Authorization=${unsignedAccessToken()}` }],
  ])('rejects a %s without a signed session', async (_label, headers) => {
    const request = new Request('https://cardcap.example.invalid/api/me', { headers })
    expect(await currentUser(request, { SESSION_SECRET: SECRET } as unknown as Env)).toBeNull()
  })

  it('fails closed when SESSION_SECRET is missing', async () => {
    const request = new Request('https://cardcap.example.invalid/api/me')
    expect(await currentUser(request, {} as Env)).toBeNull()
  })

  it('accepts a valid signed session', async () => {
    const cookie = await createSessionCookieValue(USER_ID, SECRET)
    const request = new Request('https://cardcap.example.invalid/api/me', {
      headers: { Cookie: `cardcap_session=${encodeURIComponent(cookie)}` },
    })
    expect(await currentUser(request, { SESSION_SECRET: SECRET } as unknown as Env)).toEqual({
      id: USER_ID,
      email: 'owner@example.invalid',
    })
  })

  it('rejects a tampered signed session', async () => {
    const cookie = await createSessionCookieValue(USER_ID, SECRET)
    const parts = cookie.split('.')
    parts[1] = btoa('email:attacker@example.invalid').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    const request = new Request('https://cardcap.example.invalid/api/me', {
      headers: { Cookie: `cardcap_session=${parts.join('.')}` },
    })
    expect(await currentUser(request, { SESSION_SECRET: SECRET } as unknown as Env)).toBeNull()
  })

  it('rejects a malformed session cookie without throwing', async () => {
    const request = new Request('https://cardcap.example.invalid/api/me', {
      headers: { Cookie: 'cardcap_session=%broken' },
    })
    expect(await currentUser(request, { SESSION_SECRET: SECRET } as unknown as Env)).toBeNull()
  })
})

describe('requestLoginLink', () => {
  it('does not create or send a link without SESSION_SECRET', async () => {
    const request = new Request('https://cardcap.example.invalid/api/auth/request-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.invalid' }),
    })
    const response = await requestLoginLink(request, {} as Env, new URL(request.url))
    expect(response.status).toBe(503)
  })
})
