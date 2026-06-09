import { describe, expect, it } from 'vitest'
import { normalizeExtraction } from './extraction'

describe('normalizeExtraction', () => {
  it('normalizes AI card extraction into editable contact fields', () => {
    const draft = normalizeExtraction({
      name: ' Felicia Mandell-Snell ',
      company: 'Long Realty',
      role: 'REALTOR',
      emails: [' fmandell@msn.com '],
      phones: ['(480) 695-1296', ''],
      website: 'www.feliciamandell.com',
      address: null,
      tags: ['Real estate', 'Realtor', 'Real estate'],
      notes: 'Smart Move.',
      confidence: 0.81,
      needs_review: true,
    })

    expect(draft).toEqual({
      name: 'Felicia Mandell-Snell',
      company: 'Long Realty',
      role: 'REALTOR',
      email: 'fmandell@msn.com',
      phones: ['(480) 695-1296'],
      website: 'https://www.feliciamandell.com',
      address: '',
      tags: ['Real estate', 'Realtor'],
      notes: 'Smart Move.',
      confidence: 0.81,
      needsReview: true,
    })
  })

  it('bounds confidence and handles malformed values without throwing', () => {
    const draft = normalizeExtraction({
      name: 42,
      emails: 'bad shape',
      phones: ['480-555-1212'],
      confidence: 2,
      needs_review: false,
    })

    expect(draft.name).toBe('')
    expect(draft.email).toBe('')
    expect(draft.phones).toEqual(['480-555-1212'])
    expect(draft.confidence).toBe(1)
    expect(draft.needsReview).toBe(true)
  })

  it('promotes person-like company text when the model leaves name blank', () => {
    const draft = normalizeExtraction({
      name: '',
      company: 'Sharon Carstens',
      role: 'Designated Broker',
      emails: ['brokerandtrainer@gmail.com'],
      phones: ['480-628-9053'],
      website: 'www.brokerandtrainer.com',
      tags: ['Multi-State Licensed Broker & Real Estate Instructor', 'Present Properties', 'MLS'],
      confidence: 0.87,
      needs_review: true,
    })

    expect(draft.name).toBe('Sharon Carstens')
    expect(draft.company).toBe('Present Properties')
    expect(draft.needsReview).toBe(true)
  })

  it('replaces company text that contains the person name or role with an organization tag', () => {
    const draft = normalizeExtraction({
      name: 'Sharon Carsteus',
      company: 'Sharon Carsteus Designated Broker',
      role: 'Designated Broker',
      emails: ['brokerandtrainer@gmail.com'],
      phones: ['480-628-9053'],
      tags: ['PRESENT PROPERTIES', 'MLS'],
      confidence: 0.86,
      needs_review: true,
    })

    expect(draft.name).toBe('Sharon Carsteus')
    expect(draft.company).toBe('PRESENT PROPERTIES')
  })
})
