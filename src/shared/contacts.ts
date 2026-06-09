import type { Contact } from './types'

export type ContactGroup = {
  letter: string
  contacts: Contact[]
}

export function sortContactsByName(contacts: Contact[]): Contact[] {
  return [...contacts].sort((a, b) => {
    const nameCompare = contactDisplayName(a).localeCompare(contactDisplayName(b), undefined, {
      numeric: true,
      sensitivity: 'base',
    })
    if (nameCompare !== 0) return nameCompare

    return a.updatedAt.localeCompare(b.updatedAt)
  })
}

export function groupContactsByInitial(contacts: Contact[]): ContactGroup[] {
  const groups: ContactGroup[] = []

  for (const contact of contacts) {
    const letter = initialFor(contactDisplayName(contact))
    const current = groups.at(-1)
    if (current?.letter === letter) {
      current.contacts.push(contact)
    } else {
      groups.push({ letter, contacts: [contact] })
    }
  }

  return groups
}

export function contactDisplayName(contact: Contact): string {
  return contact.name.trim() || contact.company.trim() || contact.email.trim() || 'Review Contact'
}

function initialFor(value: string): string {
  const first = value.trim().charAt(0).toUpperCase()
  return /^[A-Z]$/.test(first) ? first : '#'
}
