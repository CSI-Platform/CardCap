import type { Contact } from './types'

const CSV_HEADERS = [
  'name',
  'company',
  'role',
  'email',
  'phones',
  'website',
  'address',
  'tags',
  'status',
  'next_step',
  'notes',
]

function csvCell(value: unknown, forceQuote = false): string {
  const text = String(value ?? '')
  if (forceQuote || /[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function html(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return map[ch]
  })
}

function phoneHref(value: string): string {
  return value.replace(/[^\d+]/g, '')
}

function vcardText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
}

export function exportContactsCsv(contacts: Contact[]): string {
  const rows = contacts.map((contact) =>
    [
      contact.name,
      contact.company,
      contact.role,
      contact.email,
      contact.phones.join('; '),
      contact.website,
      contact.address,
      csvCell(contact.tags.join('; '), true),
      contact.status,
      contact.nextStep,
      contact.notes,
    ]
      .map((value) => (typeof value === 'string' && value.startsWith('"') && value.endsWith('"') ? value : csvCell(value)))
      .join(','),
  )
  return [CSV_HEADERS.join(','), ...rows].join('\n')
}

export function exportContactsJson(contacts: Contact[]): string {
  return JSON.stringify(contacts, null, 2)
}

export function exportContactsVcard(contacts: Contact[]): string {
  return contacts
    .map((contact) => {
      const lines = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${vcardText(contact.name)}`,
      ]
      if (contact.company) lines.push(`ORG:${vcardText(contact.company)}`)
      if (contact.role) lines.push(`TITLE:${vcardText(contact.role)}`)
      for (const phone of contact.phones) {
        lines.push(`TEL;TYPE=CELL:${vcardText(phone)}`)
      }
      if (contact.email) lines.push(`EMAIL:${vcardText(contact.email)}`)
      if (contact.website) lines.push(`URL:${vcardText(contact.website)}`)
      if (contact.address) lines.push(`ADR;TYPE=WORK:;;${vcardText(contact.address)};;;;`)
      if (contact.notes || contact.nextStep) {
        lines.push(`NOTE:${vcardText([contact.nextStep, contact.notes].filter(Boolean).join(' - '))}`)
      }
      lines.push('END:VCARD')
      return lines.join('\r\n')
    })
    .join('\r\n')
}

const ICONTACT_HEADERS = ['Email', 'First Name', 'Last Name', 'Company', 'Job Title', 'Phone', 'Street', 'City', 'State', 'Zip', 'Notes']

export function splitContactName(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim()
  if (!trimmed) return { firstName: '', lastName: '' }
  const spaceIndex = trimmed.indexOf(' ')
  if (spaceIndex === -1) return { firstName: trimmed, lastName: '' }
  return { firstName: trimmed.slice(0, spaceIndex), lastName: trimmed.slice(spaceIndex + 1).trim() }
}

export function exportContactsIContactCsv(contacts: Contact[]): string {
  const rows = contacts.map((contact) => {
    const { firstName, lastName } = splitContactName(contact.name)
    const extraPhones = contact.phones.slice(1)
    const notes = [contact.notes, extraPhones.length ? `Other phones: ${extraPhones.join('; ')}` : '']
      .filter(Boolean)
      .join(' | ')
    return [
      contact.email,
      firstName,
      lastName,
      contact.company,
      contact.role,
      contact.phones[0] || '',
      contact.address,
      '',
      '',
      '',
      notes,
    ]
      .map((value) => csvCell(value))
      .join(',')
  })
  return [ICONTACT_HEADERS.join(','), ...rows].join('\n')
}

export function exportContactsHtml(contacts: Contact[]): string {
  const cards = contacts
    .map((contact) => {
      const phone = contact.phones[0] || ''
      const mapHref = contact.address
        ? `https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(contact.address)}`
        : ''
      return `
        <article class="contact">
          <h2>${html(contact.name)}</h2>
          <p>${html([contact.company, contact.role].filter(Boolean).join(' - '))}</p>
          <div class="links">
            ${contact.email ? `<a href="mailto:${html(contact.email)}">Email</a>` : ''}
            ${phone ? `<a href="tel:${html(phoneHref(phone))}">Call</a>` : ''}
            ${contact.website ? `<a href="${html(contact.website)}">Website</a>` : ''}
            ${mapHref ? `<a href="${mapHref}">Map</a>` : ''}
          </div>
          <p>${html(contact.notes)}</p>
        </article>
      `
    })
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CardCap Export</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #f6f7f8; color: #20242a; }
    h1 { margin-top: 0; }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
    .contact { background: white; border: 1px solid #dfe3e8; border-radius: 8px; padding: 16px; }
    .links { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
    a { color: #146c5f; }
  </style>
</head>
<body>
  <h1>CardCap Export</h1>
  <main class="grid">${cards}</main>
</body>
</html>`
}
