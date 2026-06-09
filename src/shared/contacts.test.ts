import { describe, expect, it } from 'vitest'
import { groupContactsByInitial, sortContactsByName } from './contacts'
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

describe('contact list helpers', () => {
  it('sorts contacts alphabetically by visible display name', () => {
    const sorted = sortContactsByName([
      contact({ id: '3', name: 'zoe Adams' }),
      contact({ id: '1', name: 'Amy Chen' }),
      contact({ id: '2', name: '', company: 'Beta Builders' }),
    ])

    expect(sorted.map((item) => item.id)).toEqual(['1', '2', '3'])
  })

  it('groups an already sorted list by initial', () => {
    const groups = groupContactsByInitial([
      contact({ id: '1', name: 'Amy Chen' }),
      contact({ id: '2', name: 'Avery Stone' }),
      contact({ id: '3', name: 'Beta Jones' }),
      contact({ id: '4', name: '123 Main' }),
    ])

    expect(groups).toEqual([
      { letter: 'A', contacts: [expect.objectContaining({ id: '1' }), expect.objectContaining({ id: '2' })] },
      { letter: 'B', contacts: [expect.objectContaining({ id: '3' })] },
      { letter: '#', contacts: [expect.objectContaining({ id: '4' })] },
    ])
  })
})
