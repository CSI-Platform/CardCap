import { describe, expect, it } from 'vitest'
import { contactNeedsReview, reviewedContact } from './review'
import type { Contact } from './types'

const contact: Contact = {
  id: 'c1',
  name: 'Review Contact',
  company: '',
  role: '',
  email: '',
  phones: ['480-555-0101'],
  website: '',
  address: '',
  tags: [],
  notes: '',
  nextStep: 'Review extracted card',
  status: 'Follow up',
  sourceImageKey: '',
  sourceImageUrl: '',
  extractionConfidence: 0.76,
  needsReview: true,
  createdAt: '2026-06-07T12:00:00.000Z',
  updatedAt: '2026-06-07T12:00:00.000Z',
}

describe('review queue helpers', () => {
  it('identifies contacts that need review', () => {
    expect(contactNeedsReview(contact)).toBe(true)
  })

  it('marks a contact reviewed without losing contact data', () => {
    const reviewed = reviewedContact(contact)

    expect(reviewed.needsReview).toBe(false)
    expect(reviewed.status).toBe('New')
    expect(reviewed.nextStep).toBe('')
    expect(reviewed.phones).toEqual(['480-555-0101'])
  })
})
