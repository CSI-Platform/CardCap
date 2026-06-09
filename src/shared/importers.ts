import type { ContactStatus } from './types'

export type ImportedContact = {
  name: string
  company: string
  role: string
  email: string
  phones: string[]
  website: string
  address: string
  tags: string[]
  notes: string
  status: ContactStatus
  nextStep: string
}

export type ImportResult = {
  format: 'csv' | 'json' | 'vcard'
  contacts: ImportedContact[]
}

type CsvRow = Record<string, string>

const EMPTY_CONTACT: ImportedContact = {
  name: '',
  company: '',
  role: '',
  email: '',
  phones: [],
  website: '',
  address: '',
  tags: [],
  notes: '',
  status: 'New',
  nextStep: '',
}

export function parseContactsImport(fileName: string, content: string): ImportResult {
  const trimmed = content.trim()
  if (!trimmed) return { format: 'csv', contacts: [] }

  if (isJsonFile(fileName, trimmed)) {
    return { format: 'json', contacts: parseJsonContacts(trimmed) }
  }

  if (isVcardFile(fileName, trimmed)) {
    return { format: 'vcard', contacts: parseVcardContacts(content) }
  }

  return { format: 'csv', contacts: parseCsvContacts(content) }
}

function parseJsonContacts(content: string): ImportedContact[] {
  const parsed = JSON.parse(content) as unknown
  const records = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.contacts) ? parsed.contacts : []
  return records.map(contactFromRecord).filter(isImportable)
}

function parseCsvContacts(content: string): ImportedContact[] {
  const rows = parseCsv(content)
  if (rows.length < 2) return []

  const headers = rows[0].map(normalizeHeader)
  return rows
    .slice(1)
    .map((cells) => {
      const row: CsvRow = {}
      headers.forEach((header, index) => {
        row[header] = cells[index]?.trim() || ''
      })
      return contactFromCsvRow(row)
    })
    .filter(isImportable)
}

function parseVcardContacts(content: string): ImportedContact[] {
  const lines = unfoldVcardLines(content)
  const contacts: ImportedContact[] = []
  let current: Record<string, string[]> | null = null

  for (const line of lines) {
    if (/^BEGIN:VCARD$/i.test(line.trim())) {
      current = {}
      continue
    }
    if (/^END:VCARD$/i.test(line.trim())) {
      if (current) {
        const contact = contactFromVcard(current)
        if (isImportable(contact)) contacts.push(contact)
      }
      current = null
      continue
    }
    if (!current) continue

    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue
    const rawKey = line.slice(0, colonIndex)
    const value = vcardText(line.slice(colonIndex + 1))
    const key = rawKey.split(';')[0].toUpperCase()
    current[key] = [...(current[key] || []), value]
  }

  return contacts
}

function contactFromCsvRow(row: CsvRow): ImportedContact {
  const first = pick(row, ['first name', 'firstname', 'given name'])
  const last = pick(row, ['last name', 'lastname', 'surname', 'family name'])
  const name = pick(row, ['name', 'full name', 'display name', 'contact name']) || [first, last].filter(Boolean).join(' ')
  const phones = [
    pick(row, ['phone', 'phones', 'phone number']),
    pick(row, ['mobile', 'mobile phone', 'cell', 'cell phone']),
    pick(row, ['work phone', 'business phone', 'office phone']),
    pick(row, ['home phone']),
  ].flatMap(splitMultiValue)

  return cleanContact({
    ...EMPTY_CONTACT,
    name,
    company: pick(row, ['company', 'organization', 'organisation', 'org']),
    role: pick(row, ['role', 'title', 'job title', 'position']),
    email: pick(row, ['email', 'e-mail', 'email address', 'email 1']),
    phones,
    website: normalizeUrl(pick(row, ['website', 'url', 'web page', 'homepage'])),
    address: pick(row, ['address', 'street address', 'mailing address', 'business address']),
    tags: splitMultiValue(pick(row, ['tags', 'tag', 'categories', 'category', 'groups'])),
    notes: pick(row, ['notes', 'note', 'description']),
    status: contactStatus(pick(row, ['status'])),
    nextStep: pick(row, ['next step', 'next_step', 'follow up', 'follow-up']),
  })
}

function contactFromRecord(value: unknown): ImportedContact {
  const record = isRecord(value) ? value : {}
  return cleanContact({
    ...EMPTY_CONTACT,
    name: text(record.name) || text(record.fullName) || text(record.full_name),
    company: text(record.company) || text(record.organization) || text(record.org),
    role: text(record.role) || text(record.title) || text(record.jobTitle) || text(record.job_title),
    email: text(record.email) || text(record.emailAddress) || text(record.email_address),
    phones: arrayOrSplit(record.phones || record.phone || record.phoneNumber || record.phone_number),
    website: normalizeUrl(text(record.website) || text(record.url)),
    address: text(record.address),
    tags: arrayOrSplit(record.tags || record.categories),
    notes: text(record.notes) || text(record.note),
    status: contactStatus(text(record.status)),
    nextStep: text(record.nextStep) || text(record.next_step),
  })
}

function contactFromVcard(card: Record<string, string[]>): ImportedContact {
  const name = first(card.FN) || structuredName(first(card.N))
  const address = first(card.ADR)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ')

  return cleanContact({
    ...EMPTY_CONTACT,
    name,
    company: first(card.ORG),
    role: first(card.TITLE),
    email: first(card.EMAIL),
    phones: (card.TEL || []).flatMap(splitMultiValue),
    website: normalizeUrl(first(card.URL)),
    address,
    notes: first(card.NOTE),
  })
}

function cleanContact(contact: ImportedContact): ImportedContact {
  return {
    ...contact,
    name: contact.name.trim(),
    company: contact.company.trim(),
    role: contact.role.trim(),
    email: contact.email.trim(),
    phones: unique(contact.phones.map((phone) => phone.trim()).filter(Boolean)),
    website: normalizeUrl(contact.website),
    address: contact.address.trim(),
    tags: unique(contact.tags.map((tag) => tag.trim()).filter(Boolean)),
    notes: contact.notes.trim(),
    nextStep: contact.nextStep.trim(),
  }
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  for (let index = 0; index < content.length; index += 1) {
    const ch = content[index]
    const next = content[index + 1]
    if (ch === '"' && inQuotes && next === '"') {
      cell += '"'
      index += 1
      continue
    }
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (ch === ',' && !inQuotes) {
      row.push(cell)
      cell = ''
      continue
    }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') index += 1
      row.push(cell)
      if (row.some((value) => value.trim())) rows.push(row)
      row = []
      cell = ''
      continue
    }
    cell += ch
  }

  row.push(cell)
  if (row.some((value) => value.trim())) rows.push(row)
  return rows
}

function unfoldVcardLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const unfolded: string[] = []
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1)
    } else {
      unfolded.push(line)
    }
  }
  return unfolded
}

function isJsonFile(fileName: string, content: string): boolean {
  return /\.json$/i.test(fileName) || content.startsWith('{') || content.startsWith('[')
}

function isVcardFile(fileName: string, content: string): boolean {
  return /\.(vcf|vcard)$/i.test(fileName) || /BEGIN:VCARD/i.test(content)
}

function isImportable(contact: ImportedContact): boolean {
  return Boolean(contact.name || contact.email || contact.phones.length > 0 || contact.company)
}

function pick(row: CsvRow, names: string[]): string {
  for (const name of names) {
    if (row[name]) return row[name]
  }
  return ''
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
}

function splitMultiValue(value: string): string[] {
  return value
    .split(/\r?\n|;|\|/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function arrayOrSplit(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean)
  return splitMultiValue(text(value))
}

function structuredName(value: string): string {
  const [last, first, middle] = value.split(';')
  return [first, middle, last].filter(Boolean).join(' ').trim()
}

function vcardText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

function first(values?: string[]): string {
  return values?.[0]?.trim() || ''
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function contactStatus(value: string): ContactStatus {
  if (value === 'Follow up' || value === 'Active' || value === 'Archived') return value
  return 'New'
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values))
}
