import { describe, expect, it } from 'vitest'
import { DAILY_EXTRACTION_LIMIT, utcDayStartIso } from './quota'

describe('utcDayStartIso', () => {
  it('returns midnight UTC for a mid-day UTC time', () => {
    expect(utcDayStartIso(new Date('2026-06-09T17:42:13.000Z'))).toBe('2026-06-09T00:00:00.000Z')
  })

  it('stays on the UTC date even when local dates differ', () => {
    expect(utcDayStartIso(new Date('2026-06-09T00:00:00.000Z'))).toBe('2026-06-09T00:00:00.000Z')
    expect(utcDayStartIso(new Date('2026-06-09T23:59:59.999Z'))).toBe('2026-06-09T00:00:00.000Z')
  })
})

describe('DAILY_EXTRACTION_LIMIT', () => {
  it('is 25 per the spec', () => {
    expect(DAILY_EXTRACTION_LIMIT).toBe(25)
  })
})
