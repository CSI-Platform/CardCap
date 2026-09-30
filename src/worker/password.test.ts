import { describe, expect, it } from 'vitest'
import { hashPassword, validatePassword, verifyPassword } from './password'

describe('password credentials', () => {
  it('hashes and verifies a matching password', async () => {
    const hash = await hashPassword('correct horse battery staple', { iterations: 1000, saltBytes: 16 })

    expect(hash).toMatch(/^pbkdf2-sha256\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/)
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
    expect(await verifyPassword('wrong password', hash)).toBe(false)
  })

  it('uses a different salt for each hash', async () => {
    const first = await hashPassword('same password', { iterations: 1000, saltBytes: 16 })
    const second = await hashPassword('same password', { iterations: 1000, saltBytes: 16 })

    expect(first).not.toBe(second)
    expect(await verifyPassword('same password', first)).toBe(true)
    expect(await verifyPassword('same password', second)).toBe(true)
  })

  it('rejects malformed stored hashes', async () => {
    await expect(verifyPassword('password', '')).resolves.toBe(false)
    await expect(verifyPassword('password', 'sha256$salt$hash')).resolves.toBe(false)
    await expect(verifyPassword('password', 'pbkdf2-sha256$nope$salt$hash')).resolves.toBe(false)
  })

  it('validates password length before hashing', () => {
    expect(validatePassword('short')).toBe('Password must be at least 8 characters.')
    expect(validatePassword('x'.repeat(257))).toBe('Password must be 256 characters or fewer.')
    expect(validatePassword('long enough')).toBe('')
  })
})
