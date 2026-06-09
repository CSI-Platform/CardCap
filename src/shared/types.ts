export type ContactStatus = 'New' | 'Follow up' | 'Active' | 'Archived'

export type Contact = {
  id: string
  name: string
  company: string
  role: string
  email: string
  phones: string[]
  website: string
  address: string
  tags: string[]
  notes: string
  nextStep: string
  status: ContactStatus
  sourceImageKey: string
  sourceImageUrl: string
  extractionConfidence: number
  needsReview: boolean
  createdAt: string
  updatedAt: string
}

export type ContactDraft = {
  name: string
  company: string
  role: string
  email: string
  phones: string[]
  website: string
  address: string
  tags: string[]
  notes: string
  confidence: number
  needsReview: boolean
}

export type ExtractionResult = {
  name?: unknown
  company?: unknown
  role?: unknown
  emails?: unknown
  phones?: unknown
  website?: unknown
  address?: unknown
  tags?: unknown
  notes?: unknown
  confidence?: unknown
  needs_review?: unknown
}
