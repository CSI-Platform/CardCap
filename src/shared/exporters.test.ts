import { describe, expect, it } from 'vitest'
import type { Contact } from './types'
import {
  exportContactsCsv,
  exportContactsHtml,
  exportContactsJson,
  exportContactsVcard,
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
