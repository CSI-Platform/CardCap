const REALTOR_LABEL_PATTERN = /\brealtors?(?:\s*(?:\u00c2?\u00ae|\u2122|\(r\)))?(?:\s*a)?(?=$|[^A-Za-z0-9_])/gi

type ContactTextFields = {
  company: string
  role: string
  address: string
  tags: string[]
  notes: string
  nextStep?: string
}

export function normalizeRealtorText(value: string): string {
  return value
    .replace(REALTOR_LABEL_PATTERN, (match) => (/\brealtors/i.test(match) ? 'Realtors' : 'Realtor'))
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function normalizeContactTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => normalizeRealtorText(tag)).filter(Boolean)))
}

export function normalizeContactTextFields<T extends ContactTextFields>(contact: T): T {
  return {
    ...contact,
    company: normalizeRealtorText(contact.company),
    role: normalizeRealtorText(contact.role),
    address: normalizeRealtorText(contact.address),
    tags: normalizeContactTags(contact.tags),
    notes: normalizeRealtorText(contact.notes),
    ...(typeof contact.nextStep === 'string' ? { nextStep: normalizeRealtorText(contact.nextStep) } : {}),
  } as T
}
