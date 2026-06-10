import { describe, expect, it } from 'vitest'
import type { Contact } from './types'
import {
  exportContactsCsv,
  exportContactsHtml,
  exportContactsIContactCsv,
  exportContactsJson,
  exportContactsVcard,
  splitContactName,
} from './exporters'

const contacts: Contact[] = [
  {
    id: 'c1',
    name: 'Gail Robertson',
    company: 'WestUSA Realty',
    role: 'Realtor',
    email: 'gail@gailsellsaz.com',
    phones: ['480-246-0540'],
    website: 'https://www.gailsellsaz.com',
    address: '1850 E. Northrop Blvd., #170, Chandler, AZ 85286',
    tags: ['Real estate', 'Chandler'],
    notes: 'Met at a networking event, follow up this week.',
    nextStep: 'Send intro email',
    status: 'New',
    sourceImageKey: 'cards/c1.jpeg',
    sourceImageUrl: '/api/images/cards/c1.jpeg',
    extractionConfidence: 0.92,
    needsReview: false,
    createdAt: '2026-06-07T12:00:00.000Z',
    updatedAt: '2026-06-07T12:00:00.000Z',
  },
]

describe('contact exports', () => {
  it('exports CSV with escaped comma-containing fields', () => {
    const csv = exportContactsCsv(contacts)

    expect(csv).toContain('name,company,role,email,phones,website,address,tags,status,next_step,notes')
    expect(csv).toContain('"1850 E. Northrop Blvd., #170, Chandler, AZ 85286"')
    expect(csv).toContain('"Real estate; Chandler"')
  })

  it('exports vCard 3.0 records with phone, email, url, and address', () => {
    const vcard = exportContactsVcard(contacts)

    expect(vcard).toContain('BEGIN:VCARD')
    expect(vcard).toContain('VERSION:3.0')
    expect(vcard).toContain('FN:Gail Robertson')
    expect(vcard).toContain('ORG:WestUSA Realty')
    expect(vcard).toContain('TEL;TYPE=CELL:480-246-0540')
    expect(vcard).toContain('EMAIL:gail@gailsellsaz.com')
    expect(vcard).toContain('URL:https://www.gailsellsaz.com')
    expect(vcard).toContain('ADR;TYPE=WORK:;;1850 E. Northrop Blvd.\\, #170\\, Chandler\\, AZ 85286;;;;')
    expect(vcard).toContain('END:VCARD')
  })

  it('exports JSON as stable pretty-printed contact data', () => {
    const json = exportContactsJson(contacts)
    const parsed = JSON.parse(json)

    expect(parsed).toEqual(contacts)
    expect(json).toContain('\n  {')
  })

  it('exports standalone HTML with clickable contact links', () => {
    const html = exportContactsHtml(contacts)

    expect(html).toContain('<title>CardCap Export</title>')
    expect(html).toContain('mailto:gail@gailsellsaz.com')
    expect(html).toContain('tel:4802460540')
    expect(html).toContain('https://www.gailsellsaz.com')
    expect(html).toContain('https://www.google.com/maps/search/?api=1&amp;query=')
  })
})

function iContactFixture(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'c2',
    name: 'Maria de la Cruz',
    company: 'Desert Title',
    role: 'Escrow Officer',
    email: 'maria@deserttitle.com',
    phones: ['(602) 555-0101', '(602) 555-0102'],
    website: 'https://deserttitle.com',
    address: '100 N Central Ave, Phoenix, AZ 85004',
    tags: ['title'],
    notes: 'Met at expo, "great" contact',
    nextStep: 'Send intro email',
    status: 'Follow up',
    sourceImageKey: '',
    sourceImageUrl: '',
    extractionConfidence: 1,
    needsReview: false,
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    ...overrides,
  }
}

describe('splitContactName', () => {
  it('splits first token from the rest', () => {
    expect(splitContactName('Maria de la Cruz')).toEqual({ firstName: 'Maria', lastName: 'de la Cruz' })
  })

  it('handles single-token names', () => {
    expect(splitContactName('Cher')).toEqual({ firstName: 'Cher', lastName: '' })
  })

  it('handles empty and whitespace names', () => {
    expect(splitContactName('   ')).toEqual({ firstName: '', lastName: '' })
  })
})

describe('exportContactsIContactCsv', () => {
  it('emits the iContact header row', () => {
    const lines = exportContactsIContactCsv([]).split('\n')
    expect(lines[0]).toBe('Email,First Name,Last Name,Company,Job Title,Phone,Street,City,State,Zip,Notes')
  })

  it('maps contact fields, splits name, and keeps City/State/Zip blank', () => {
    const lines = exportContactsIContactCsv([iContactFixture()]).split('\n')
    expect(lines[1]).toBe(
      'maria@deserttitle.com,Maria,de la Cruz,Desert Title,Escrow Officer,(602) 555-0101,' +
        '"100 N Central Ave, Phoenix, AZ 85004",,,,' +
        '"Met at expo, ""great"" contact | Other phones: (602) 555-0102"',
    )
  })

  it('includes rows without email and without phones', () => {
    const lines = exportContactsIContactCsv([
      iContactFixture({ email: '', phones: [], notes: '', name: 'Solo' }),
    ]).split('\n')
    expect(lines[1]).toBe(',Solo,,Desert Title,Escrow Officer,,"100 N Central Ave, Phoenix, AZ 85004",,,,')
  })
})
