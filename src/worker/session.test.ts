import { describe, expect, it } from 'vitest'
import { createSessionCookieValue, verifySessionCookieValue } from './session'

const SECRET = 'test-secret-at-least-32-bytes-long!!'
const NOW = new Date('2026-06-09T12:00:00.000Z')

describe('session cookie', () => {
  it('round-trips a user id', async () => {
    const value = await createSessionCookieValue('email:mom@title.com', SECRET, NOW)
    expect(await verifySessionCookieValue(value, SECRET, NOW)).toBe('email:mom@title.com')
  })

  it('rejects a tampered payload', async () => {
    const value = await createSessionCookieValue('email:mom@title.com', SECRET, NOW)
    const parts = value.split('.')
    const forged = await createSessionCookieValue('email:evil@x.com', SECRET, NOW)
    const swapped = [parts[0], forged.split('.')[1], parts[2], parts[3]].join('.')
    expect(await verifySessionCookieValue(swapped, SECRET, NOW)).toBeNull()
  })

  it('rejects the wrong secret', async () => {
    const value = await createSessionCookieValue('email:mom@title.com', SECRET, NOW)
    expect(await verifySessionCookieValue(value, 'different-secret-also-long-enough!!', NOW)).toBeNull()
  })

  it('rejects an expired cookie', async () => {
    const value = await createSessionCookieValue('email:mom@title.com', SECRET, NOW)
    const later = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000)
    expect(await verifySessionCookieValue(value, SECRET, later)).toBeNull()
  })

  it('rejects malformed values', async () => {
    expect(await verifySessionCookieValue('', SECRET, NOW)).toBeNull()
    expect(await verifySessionCookieValue('v1.only.three', SECRET, NOW)).toBeNull()
    expect(await verifySessionCookieValue('v2.a.123.sig', SECRET, NOW)).toBeNull()
    expect(await verifySessionCookieValue('v1.!!!.123.sig', SECRET, NOW)).toBeNull()
  })
})
