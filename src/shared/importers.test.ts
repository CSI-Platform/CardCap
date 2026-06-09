import { describe, expect, it } from 'vitest'
import { parseContactsImport } from './importers'

describe('contact imports', () => {
  it('imports CSV contacts from common CRM headers', () => {
    const csv = [
      'First Name,Last Name,Company,Job Title,Email Address,Mobile Phone,Website,Categories,Notes',
      'Mary,Sample,"WestUSA Realty, Team",Broker,mary@example.com,480-111-2222,mary.example.com,"Real estate; Scottsdale","Met at open house"',
    ].join('\n')

    const result = parseContactsImport('contacts.csv', csv)

    expect(result.format).toBe('csv')
    expect(result.contacts).toEqual([
      expect.objectContaining({
        name: 'Mary Sample',
        company: 'WestUSA Realty, Team',
        role: 'Broker',
        email: 'mary@example.com',
        phones: ['480-111-2222'],
        website: 'https://mary.example.com',
        tags: ['Real estate', 'Scottsdale'],
        notes: 'Met at open house',
      }),
    ])
  })

  it('imports vCard contacts with clickable fields', () => {
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Gail Robertson',
      'ORG:WestUSA Realty',
      'TITLE:Realtor',
      'TEL;TYPE=CELL:480-246-0540',
      'EMAIL:gail@gailsellsaz.com',
      'URL:https://www.gailsellsaz.com',
      'ADR;TYPE=WORK:;;1850 E. Northrop Blvd.\\, #170\\, Chandler\\, AZ 85286;;;;',
      'END:VCARD',
    ].join('\r\n')

    const result = parseContactsImport('contacts.vcf', vcard)

    expect(result.format).toBe('vcard')
    expect(result.contacts[0]).toEqual(
      expect.objectContaining({
        name: 'Gail Robertson',
        company: 'WestUSA Realty',
        role: 'Realtor',
        email: 'gail@gailsellsaz.com',
        phones: ['480-246-0540'],
        website: 'https://www.gailsellsaz.com',
        address: '1850 E. Northrop Blvd., #170, Chandler, AZ 85286',
      }),
    )
  })

  it('imports CardCap JSON exports', () => {
    const json = JSON.stringify({
      contacts: [
        {
          name: 'John Vietze',
          company: 'HomeSmart',
          role: 'Realtor',
          email: 'John@KeeperHome.com',
          phones: ['480-825-1313'],
          website: 'https://KeeperHome.com',
          tags: ['Real estate'],
          status: 'Active',
          nextStep: 'Send listing',
        },
      ],
    })

    const result = parseContactsImport('cardcap.json', json)

    expect(result.format).toBe('json')
    expect(result.contacts[0]).toEqual(
      expect.objectContaining({
        name: 'John Vietze',
        company: 'HomeSmart',
        status: 'Active',
        nextStep: 'Send listing',
      }),
    )
  })
})
