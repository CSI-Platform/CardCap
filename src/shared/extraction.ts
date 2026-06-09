import type { ContactDraft, ExtractionResult } from './types'

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function textArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .map((item) => text(item))
        .filter(Boolean),
    ),
  )
}

function normalizeWebsite(value: unknown): string {
  const raw = text(value)
  if (!raw) return ''
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
}

function confidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export function normalizeExtraction(input: ExtractionResult): ContactDraft {
  const score = confidence(input.confidence)
  const tags = textArray(input.tags)
  const rawName = text(input.name)
  const rawCompany = text(input.company)
  const role = text(input.role)
  const promotedName = !rawName && looksLikePersonName(rawCompany) ? rawCompany : rawName
  const recoveredCompany = cleanCompany(rawCompany, promotedName, role, tags)
  const email = textArray(input.emails)[0] || ''

  return {
    name: promotedName,
    company: recoveredCompany,
    role,
    email,
    phones: textArray(input.phones),
    website: normalizeWebsite(input.website),
    address: text(input.address),
    tags,
    notes: text(input.notes),
    confidence: score,
    needsReview:
      input.needs_review === true ||
      score < 0.9 ||
      !promotedName ||
      (!email && textArray(input.phones).length === 0),
  }
}

function looksLikePersonName(value: string): boolean {
  const parts = value.split(/\s+/).filter(Boolean)
  if (parts.length < 2 || parts.length > 4) return false
  if (/[0-9@/:]/.test(value)) return false
  if (organizationNameWords.test(value)) return false
  return parts.every((part) => /^[A-Z][A-Za-z'.-]+$/.test(part))
}

function findOrganizationTag(tags: string[]): string {
  return tags.find((tag) => organizationNameWords.test(tag)) || ''
}

function cleanCompany(company: string, name: string, role: string, tags: string[]): string {
  const organizationTag = findOrganizationTag(tags)
  if (!organizationTag) return company === name ? '' : company

  const normalizedCompany = company.toLowerCase()
  const hasName = Boolean(name) && normalizedCompany.includes(name.toLowerCase())
  const hasRole = Boolean(role) && normalizedCompany.includes(role.toLowerCase())
  const isPersonName = looksLikePersonName(company)

  return hasName || hasRole || isPersonName ? organizationTag : company
}

const organizationNameWords =
  /\b(properties|property|realty|realtors?|brokerage|agency|group|company|co\.?|llc|inc\.?|homes?|mortgage|title|insurance)\b/i
