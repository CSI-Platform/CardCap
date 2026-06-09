import type { Contact } from './types'

export type DuplicateMatch = {
  contact: Contact
  reasons: string[]
}

export function findDuplicateContact(candidate: Contact, contacts: Contact[]): DuplicateMatch | null {
  const candidateEmail = normalizeEmail(candidate.email)
  const candidatePhones = candidate.phones.map(normalizePhone).filter(Boolean)
  const candidateWebsite = normalizeWebsite(candidate.website)
  const candidateName = normalizeWords(candidate.name)
  const candidateCompany = normalizeWords(candidate.company)

  for (const contact of contacts) {
    const reasons: string[] = []
    if (candidateEmail && candidateEmail === normalizeEmail(contact.email)) reasons.push('email')

    const existingPhones = contact.phones.map(normalizePhone).filter(Boolean)
    if (candidatePhones.some((phone) => existingPhones.includes(phone))) reasons.push('phone')

    if (candidateWebsite && candidateWebsite === normalizeWebsite(contact.website)) reasons.push('website')

    if (
      candidateName &&
      candidateCompany &&
      candidateName === normalizeWords(contact.name) &&
      candidateCompany === normalizeWords(contact.company)
    ) {
      reasons.push('name/company')
    }

    if (reasons.length > 0) return { contact, reasons }
  }

  return null
}

export function mergeDuplicateContact(existing: Contact, candidate: Contact): Contact {
  return {
    ...existing,
    name: existing.name || candidate.name,
    company: existing.company || candidate.company,
    role: existing.role || candidate.role,
    email: existing.email || candidate.email,
    phones: unique([...existing.phones, ...candidate.phones]),
    website: existing.website || candidate.website,
    address: existing.address || candidate.address,
    tags: unique([...existing.tags, ...candidate.tags]),
    notes: existing.notes || candidate.notes,
    nextStep: existing.nextStep || candidate.nextStep,
    status: existing.status === 'Archived' ? existing.status : candidate.needsReview ? 'Follow up' : existing.status,
    sourceImageKey: existing.sourceImageKey || candidate.sourceImageKey,
    sourceImageUrl: existing.sourceImageUrl || candidate.sourceImageUrl,
    extractionConfidence: Math.max(existing.extractionConfidence, candidate.extractionConfidence),
    needsReview: existing.needsReview || candidate.needsReview,
    updatedAt: candidate.updatedAt,
  }
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '')
  return digits.length > 10 && digits.startsWith('1') ? digits.slice(1) : digits
}

function normalizeWebsite(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
}

function normalizeWords(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}
