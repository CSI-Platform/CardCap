import {
  exportContactsCsv,
  exportContactsHtml,
  exportContactsJson,
  exportContactsVcard,
} from '../shared/exporters'
import { sortContactsByName } from '../shared/contacts'
import { findDuplicateContact, mergeDuplicateContact } from '../shared/duplicates'
import { parseContactsImport, type ImportedContact } from '../shared/importers'
import type { Contact, ContactStatus } from '../shared/types'
import { createBetaSession, currentUser } from './auth'
import { extractCard } from './extract'
import {
  deleteContact,
  getContact,
  listContacts,
  saveContact,
  saveExtractionJob,
} from './repository'

type JsonObject = Record<string, unknown>

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) {
      return new Response('Not found', { status: 404 })
    }

    try {
      const response = await route(request, env, url)
      ctx.waitUntil(Promise.resolve())
      return response
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: String(error), path: url.pathname }))
      return json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500)
    }
  },
} satisfies ExportedHandler<Env>

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    return json({ ok: true, extractor: env.AI_EXTRACTOR })
  }

  if (request.method === 'POST' && url.pathname === '/api/session') {
    return createBetaSession(request, env)
  }

  const user = await currentUser(request, env)
  if (!user) {
    return json({ error: 'Private beta code or Cloudflare Access sign-in is required.' }, 401)
  }

  if (request.method === 'GET' && url.pathname === '/api/contacts') {
    return json({ contacts: sortContactsByName(await listContacts(env.DB, user.id)) })
  }

  if (request.method === 'POST' && url.pathname === '/api/contacts') {
    return json({ contact: await saveContact(env.DB, contactFromJson(await request.json()), user.id) }, 201)
  }

  const contactMatch = url.pathname.match(/^\/api\/contacts\/([^/]+)$/)
  if (contactMatch) {
    const id = decodeURIComponent(contactMatch[1])
    if (request.method === 'GET') {
      const contact = await getContact(env.DB, id, user.id)
      return contact ? json({ contact }) : json({ error: 'Contact not found' }, 404)
    }
    if (request.method === 'PUT') {
      const existing = await getContact(env.DB, id, user.id)
      const next = contactFromJson(await request.json(), existing || undefined, id)
      return json({ contact: await saveContact(env.DB, next, user.id) })
    }
    if (request.method === 'DELETE') {
      const existing = await getContact(env.DB, id, user.id)
      const deleted = await deleteContact(env.DB, id, user.id)
      if (deleted && existing?.sourceImageKey) {
        await env.CARD_IMAGES.delete(existing.sourceImageKey)
      }
      return json({ deleted })
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/cards/upload') {
    return uploadCard(request, env, user.id)
  }

  if (request.method === 'POST' && url.pathname === '/api/contacts/import') {
    return importContacts(request, env, user.id)
  }

  const imageMatch = url.pathname.match(/^\/api\/images\/(.+)$/)
  if (request.method === 'GET' && imageMatch) {
    return getImage(env, decodeURIComponent(imageMatch[1]))
  }

  if (request.method === 'GET' && url.pathname === '/api/export.csv') {
    return download(exportContactsCsv(sortContactsByName(await listContacts(env.DB, user.id))), 'text/csv; charset=utf-8', 'cardcap-contacts.csv')
  }

  if (request.method === 'GET' && url.pathname === '/api/export.vcf') {
    return download(exportContactsVcard(sortContactsByName(await listContacts(env.DB, user.id))), 'text/vcard; charset=utf-8', 'cardcap-contacts.vcf')
  }

  if (request.method === 'GET' && url.pathname === '/api/export.json') {
    return download(exportContactsJson(sortContactsByName(await listContacts(env.DB, user.id))), 'application/json; charset=utf-8', 'cardcap-contacts.json')
  }

  if (request.method === 'GET' && url.pathname === '/api/export.html') {
    return download(exportContactsHtml(sortContactsByName(await listContacts(env.DB, user.id))), 'text/html; charset=utf-8', 'cardcap-contacts.html')
  }

  return json({ error: 'Route not found' }, 404)
}

async function uploadCard(request: Request, env: Env, userId: string): Promise<Response> {
  const form = await request.formData()
  const file = form.get('file')
  if (!(file instanceof File)) {
    return json({ error: 'file is required' }, 400)
  }
  if (!file.type.startsWith('image/')) {
    return json({ error: 'file must be an image' }, 400)
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const bytes = await file.arrayBuffer()
  const key = `cards/${id}-${safeFileName(file.name || 'card.jpeg')}`
  await env.CARD_IMAGES.put(key, bytes, {
    httpMetadata: { contentType: file.type || 'image/jpeg' },
    customMetadata: { originalName: file.name || 'card.jpeg' },
  })

  const extraction = await extractCard({
    fileName: file.name || 'card.jpeg',
    bytes,
    contentType: file.type || 'image/jpeg',
    env,
  })

  const contact: Contact = {
    id,
    name: extraction.draft.name,
    company: extraction.draft.company,
    role: extraction.draft.role,
    email: extraction.draft.email,
    phones: extraction.draft.phones,
    website: extraction.draft.website,
    address: extraction.draft.address,
    tags: extraction.draft.tags,
    notes: extraction.draft.notes,
    nextStep: 'Review extracted card',
    status: 'Follow up',
    sourceImageKey: key,
    sourceImageUrl: `/api/images/${encodeURIComponent(key)}`,
    extractionConfidence: extraction.draft.confidence,
    needsReview: true,
    createdAt: now,
    updatedAt: now,
  }

  const duplicate = findDuplicateContact(contact, await listContacts(env.DB, userId))
  const contactToSave = duplicate
    ? {
        ...mergeDuplicateContact(duplicate.contact, contact),
        needsReview: duplicate.contact.needsReview,
        nextStep: duplicate.contact.nextStep,
        status: duplicate.contact.status,
      }
    : contact
  const saved = await saveContact(env.DB, withoutImageUrl(contactToSave), userId)

  if (duplicate && duplicate.contact.sourceImageKey && duplicate.contact.sourceImageKey !== key) {
    await env.CARD_IMAGES.delete(key)
  }

  await saveExtractionJob(
    env.DB,
    {
      id: crypto.randomUUID(),
      contactId: saved.id,
      sourceImageKey: saved.sourceImageKey || key,
      status: duplicate ? 'duplicate' : extraction.mode === 'openai' ? 'extracted' : 'mocked',
      rawExtractionJson: JSON.stringify(extraction.raw),
    },
    userId,
  )

  return json(
    {
      contact: saved,
      extractionMode: extraction.mode,
      duplicate: duplicate ? { id: duplicate.contact.id, reasons: duplicate.reasons } : null,
    },
    duplicate ? 200 : 201,
  )
}

async function importContacts(request: Request, env: Env, userId: string): Promise<Response> {
  const form = await request.formData()
  const file = form.get('file')
  if (!(file instanceof File)) {
    return json({ error: 'file is required' }, 400)
  }

  const parsed = parseContactsImport(file.name || 'contacts.csv', await file.text())
  const now = new Date().toISOString()
  const knownContacts = await listContacts(env.DB, userId)
  const savedContacts: Contact[] = []
  let created = 0
  let merged = 0

  for (const imported of parsed.contacts) {
    const candidate = contactFromImported(imported, now)
    const duplicate = findDuplicateContact(candidate, [...knownContacts, ...savedContacts])
    if (duplicate) {
      const saved = await saveContact(env.DB, withoutImageUrl(mergeDuplicateContact(duplicate.contact, candidate)), userId)
      savedContacts.push(saved)
      merged += 1
      continue
    }

    const saved = await saveContact(env.DB, withoutImageUrl(candidate), userId)
    savedContacts.push(saved)
    created += 1
  }

  return json({
    format: parsed.format,
    imported: parsed.contacts.length,
    created,
    merged,
    skipped: Math.max(0, parsed.contacts.length - created - merged),
    contacts: sortContactsByName(savedContacts),
  })
}

async function getImage(env: Env, key: string): Promise<Response> {
  const object = await env.CARD_IMAGES.get(key)
  if (!object) return new Response('Not found', { status: 404 })

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('cache-control', 'private, max-age=3600')
  return new Response(object.body, { headers })
}

function contactFromJson(payload: unknown, existing?: Contact, forcedId?: string): Omit<Contact, 'sourceImageUrl'> {
  const input = isObject(payload) && isObject(payload.contact) ? payload.contact : payload
  const value = isObject(input) ? input : {}
  const now = new Date().toISOString()
  const createdAt = text(value.createdAt) || existing?.createdAt || now
  return {
    id: forcedId || text(value.id) || existing?.id || crypto.randomUUID(),
    name: text(value.name),
    company: text(value.company),
    role: text(value.role),
    email: text(value.email),
    phones: stringArray(value.phones),
    website: text(value.website),
    address: text(value.address),
    tags: stringArray(value.tags),
    notes: text(value.notes),
    nextStep: text(value.nextStep),
    status: contactStatus(text(value.status)),
    sourceImageKey: text(value.sourceImageKey) || existing?.sourceImageKey || '',
    extractionConfidence: number(value.extractionConfidence, existing?.extractionConfidence || 0),
    needsReview: boolean(value.needsReview, existing?.needsReview || false),
    createdAt,
    updatedAt: now,
  }
}

function withoutImageUrl(contact: Contact): Omit<Contact, 'sourceImageUrl'> {
  return {
    id: contact.id,
    name: contact.name,
    company: contact.company,
    role: contact.role,
    email: contact.email,
    phones: contact.phones,
    website: contact.website,
    address: contact.address,
    tags: contact.tags,
    notes: contact.notes,
    nextStep: contact.nextStep,
    status: contact.status,
    sourceImageKey: contact.sourceImageKey,
    extractionConfidence: contact.extractionConfidence,
    needsReview: contact.needsReview,
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  }
}

function contactFromImported(imported: ImportedContact, now: string): Contact {
  return {
    id: crypto.randomUUID(),
    name: imported.name,
    company: imported.company,
    role: imported.role,
    email: imported.email,
    phones: imported.phones,
    website: imported.website,
    address: imported.address,
    tags: imported.tags,
    notes: imported.notes,
    nextStep: imported.nextStep,
    status: imported.status,
    sourceImageKey: '',
    sourceImageUrl: '',
    extractionConfidence: 1,
    needsReview: false,
    createdAt: now,
    updatedAt: now,
  }
}

function json(body: JsonObject, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
    },
  })
}

function download(body: string, contentType: string, filename: string): Response {
  return new Response(body, {
    headers: {
      'content-type': contentType,
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  })
}

function safeFileName(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'card.jpeg'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : []
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function contactStatus(value: string): ContactStatus {
  if (value === 'Follow up' || value === 'Active' || value === 'Archived') return value
  return 'New'
}
