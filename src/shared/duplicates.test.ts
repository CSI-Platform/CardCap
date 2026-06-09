import { describe, expect, it } from 'vitest'
import { findDuplicateContact, mergeDuplicateContact } from './duplicates'
import type { Contact } from './types'

const baseContact: Contact = {
  id: 'base',
  name: '',
  company: '',
  role: '',
  email: '',
  phones: [],
  website: '',
  address: '',
  tags: [],
  notes: '',
  nextStep: '',
  status: 'New',
  sourceImageKey: '',
  sourceImageUrl: '',
  extractionConfidence: 0,
  needsReview: false,
  createdAt: '2026-06-07T12:00:00.000Z',
  updatedAt: '2026-06-07T12:00:00.000Z',
}

function contact(overrides: Partial<Contact>): Contact {
  return { ...baseContact, ...overrides }
}

describe('duplicate matching', () => {
  it('matches contacts by email, phone, website, or name/company', () => {
    const existing = [
      contact({
        id: 'c1',
        name: 'Gail Robertson',
        company: 'WestUSA Realty',
        email: 'gail@example.com',
        phones: ['+1 (480) 246-0540'],
        website: 'https://www.gailsellsaz.com/',
      }),
    ]

    expect(findDuplicateContact(contact({ email: 'GAIL@example.com' }), existing)?.reasons).toContain('email')
    expect(findDuplicateContact(contact({ phones: ['4802460540'] }), existing)?.reasons).toContain('phone')
    expect(findDuplicateContact(contact({ website: 'http://gailsellsaz.com' }), existing)?.reasons).toContain('website')
    expect(findDuplicateContact(contact({ name: 'gail robertson', company: 'westusa realty' }), existing)?.reasons).toContain(
      'name/company',
    )
  })

  it('merges duplicate contacts without overwriting existing reviewed fields', () => {
    const merged = mergeDuplicateContact(
      contact({ id: 'existing', name: 'Gail Robertson', phones: ['480-246-0540'], tags: ['Realtor'], needsReview: false }),
      contact({
        id: 'candidate',
        name: 'Gail R.',
        email: 'gail@example.com',
        phones: ['480-246-0540', '602-555-0101'],
        tags: ['Chandler'],
        needsReview: true,
        updatedAt: '2026-06-08T12:00:00.000Z',
      }),
    )

    expect(merged.id).toBe('existing')
    expect(merged.name).toBe('Gail Robertson')
    expect(merged.email).toBe('gail@example.com')
    expect(merged.phones).toEqual(['480-246-0540', '602-555-0101'])
    expect(merged.tags).toEqual(['Realtor', 'Chandler'])
    expect(merged.needsReview).toBe(true)
  })
})
