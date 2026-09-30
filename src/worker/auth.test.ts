import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPassword, verifyPassword } from './password'
import { getUserByEmail, setUserPasswordHash } from './repository'
import { passwordLogin, requestLoginLink, setAccountPassword, type CurrentUser } from './auth'

vi.mock('./email', () => ({ sendLoginEmail: vi.fn() }))

vi.mock('./repository', () => ({
  consumeLoginToken: vi.fn(),
  createLoginToken: vi.fn(),
  getUserByEmail: vi.fn(),
  localUserId: vi.fn(() => 'local-user'),
  setUserPasswordHash: vi.fn(),
  upsertUser: vi.fn(),
}))

const SECRET = 'test-secret-at-least-32-bytes-long!!'

describe('password auth', () => {
  beforeEach(() => {
    vi.mocked(getUserByEmail).mockReset()
    vi.mocked(setUserPasswordHash).mockReset()
  })

  it('creates a session for matching email and password credentials', async () => {
    const passwordHash = await hashPassword('correct horse battery staple', { iterations: 1000, saltBytes: 16 })
    vi.mocked(getUserByEmail).mockResolvedValue({
      id: 'email:cody@example.com',
      email: 'cody@example.com',
      passwordHash,
    })

    const response = await passwordLogin(
      jsonRequest('/api/auth/password-login', {
        email: ' Cody@Example.com ',
        password: 'correct horse battery staple',
      }),
      { SESSION_SECRET: SECRET } as unknown as Env,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, email: 'cody@example.com' })
    expect(response.headers.get('set-cookie')).toContain('cardcap_session=')
    expect(vi.mocked(getUserByEmail)).toHaveBeenCalledWith(undefined, 'cody@example.com')
  })

  it('rejects missing users and wrong passwords with the same message', async () => {
    vi.mocked(getUserByEmail).mockResolvedValue(null)

    const missing = await passwordLogin(
      jsonRequest('/api/auth/password-login', {
        email: 'missing@example.com',
        password: 'correct horse battery staple',
      }),
      { SESSION_SECRET: SECRET } as unknown as Env,
    )

    expect(missing.status).toBe(401)
    await expect(missing.json()).resolves.toEqual({ error: 'Invalid email or password.' })

    vi.mocked(getUserByEmail).mockResolvedValue({
      id: 'email:cody@example.com',
      email: 'cody@example.com',
      passwordHash: await hashPassword('real password', { iterations: 1000, saltBytes: 16 }),
    })

    const wrong = await passwordLogin(
      jsonRequest('/api/auth/password-login', {
        email: 'cody@example.com',
        password: 'wrong password',
      }),
      { SESSION_SECRET: SECRET } as unknown as Env,
    )

    expect(wrong.status).toBe(401)
    await expect(wrong.json()).resolves.toEqual({ error: 'Invalid email or password.' })
  })

  it('stores a password hash for the signed-in user', async () => {
    const user: CurrentUser = { id: 'email:cody@example.com', email: 'cody@example.com' }

    const response = await setAccountPassword(
      jsonRequest('/api/auth/set-password', { password: 'new secure password' }),
      {} as Env,
      user,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    const [, userId, storedHash] = vi.mocked(setUserPasswordHash).mock.calls[0]
    expect(userId).toBe('email:cody@example.com')
    await expect(verifyPassword('new secure password', storedHash)).resolves.toBe(true)
  })

  it('keeps magic-link sign-in available after password attempts are exhausted', async () => {
    function quota(max: number) {
      const counts = new Map<string, number>()
      return { async limit({ key }: { key: string }) {
        const count = (counts.get(key) || 0) + 1
        counts.set(key, count)
        return { success: count <= max }
      } }
    }
    const env = {
      SESSION_SECRET: SECRET,
      RL_LINK_EMAIL: quota(2), RL_LINK_IP: quota(5),
      RL_PASSWORD_EMAIL: quota(2), RL_PASSWORD_IP: quota(5),
    } as unknown as Env
    const credentials = { email: 'synthetic@example.com', password: 'wrong password' }
    vi.mocked(getUserByEmail).mockResolvedValue(null)
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await passwordLogin(jsonRequest('/api/auth/password-login', credentials), env)).status).toBe(401)
    }
    expect((await passwordLogin(jsonRequest('/api/auth/password-login', credentials), env)).status).toBe(429)
    const link = await requestLoginLink(jsonRequest('/api/auth/request-link', { email: credentials.email }), env, new URL('https://cardcap.test'))
    expect(link.status).toBe(200)
    expect(await link.json()).toEqual({ ok: true })
    expect((await passwordLogin(jsonRequest('/api/auth/password-login', credentials), env)).status).toBe(429)
  })
})

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://cardcap.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
