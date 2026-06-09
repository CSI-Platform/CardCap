import type { Contact } from './types'

export function contactNeedsReview(contact: Contact): boolean {
  return (
    contact.needsReview ||
    !contact.name.trim() ||
    contact.nextStep.toLowerCase().includes('review') ||
    (contact.status === 'Follow up' && contact.extractionConfidence < 0.9)
  )
}

export function reviewedContact(contact: Contact): Contact {
  return {
    ...contact,
    needsReview: false,
    status: contact.status === 'Follow up' ? 'New' : contact.status,
    nextStep: contact.nextStep.toLowerCase().includes('review') ? '' : contact.nextStep,
  }
}
