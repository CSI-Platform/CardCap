import type { Contact, ContactStatus } from '../shared/types'

const LOCAL_USER_ID = 'local-user'

type ContactRow = {
  id: string
  user_id: string
  name: string
  company: string
  role: string
  email: string
  phones_json: string
  website: string
  address: string
  tags_json: string
  notes: string
  next_step: string
  status: string
  source_image_key: string
  extraction_confidence: number
  needs_review: number
  created_at: string
  updated_at: string
}

type TableInfoRow = {
  name: string
}

export type ContactWrite = Omit<Contact, 'sourceImageUrl'>

export async function ensureSchema(db: D1Database): Promise<void> {
  await db
    .batch([
      db.prepare(
        `CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          name TEXT NOT NULL,
          auth_provider TEXT NOT NULL DEFAULT 'local',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
      ),
      db.prepare(
        `CREATE TABLE IF NOT EXISTS contacts (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          company TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL DEFAULT '',
          phones_json TEXT NOT NULL DEFAULT '[]',
          website TEXT NOT NULL DEFAULT '',
          address TEXT NOT NULL DEFAULT '',
          tags_json TEXT NOT NULL DEFAULT '[]',
          notes TEXT NOT NULL DEFAULT '',
          next_step TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'New',
          source_image_key TEXT NOT NULL DEFAULT '',
          extraction_confidence REAL NOT NULL DEFAULT 0,
          needs_review INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
      ),
      db.prepare(
        `CREATE TABLE IF NOT EXISTS extraction_jobs (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          contact_id TEXT NOT NULL,
          source_image_key TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT NOT NULL DEFAULT '',
          raw_extraction_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
      ),
    ])
    .catch((error: unknown) => {
      throw new Error(`Failed to ensure D1 schema: ${String(error)}`)
    })

  await addColumnIfMissing(db, 'contacts', 'needs_review', 'INTEGER NOT NULL DEFAULT 0')
  await db
    .prepare(
      `UPDATE contacts
       SET needs_review = 1
       WHERE needs_review = 0
         AND (
           lower(next_step) LIKE '%review%'
           OR name = ''
           OR (status = 'Follow up' AND extraction_confidence < 0.9)
         )`,
    )
    .run()

  const now = new Date().toISOString()
  await ensureUser(db, LOCAL_USER_ID, 'local@cardcap.dev', 'Local User', 'local', now)
}

export function localUserId(): string {
  return LOCAL_USER_ID
}

export async function listContacts(db: D1Database, userId = LOCAL_USER_ID): Promise<Contact[]> {
  await ensureSchema(db)
  const result = await db
    .prepare('SELECT * FROM contacts WHERE user_id = ? ORDER BY updated_at DESC')
    .bind(userId)
    .all<ContactRow>()
  return (result.results || []).map(rowToContact)
}

export async function getContact(db: D1Database, id: string, userId = LOCAL_USER_ID): Promise<Contact | null> {
  await ensureSchema(db)
  const row = await db
    .prepare('SELECT * FROM contacts WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first<ContactRow>()
  return row ? rowToContact(row) : null
}

export async function saveContact(db: D1Database, contact: ContactWrite, userId = LOCAL_USER_ID): Promise<Contact> {
  await ensureSchema(db)
  await ensureUser(db, userId)
  await db
    .prepare(
      `INSERT INTO contacts (
        id, user_id, name, company, role, email, phones_json, website, address,
        tags_json, notes, next_step, status, source_image_key,
        extraction_confidence, needs_review, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        company = excluded.company,
        role = excluded.role,
        email = excluded.email,
        phones_json = excluded.phones_json,
        website = excluded.website,
        address = excluded.address,
        tags_json = excluded.tags_json,
        notes = excluded.notes,
        next_step = excluded.next_step,
        status = excluded.status,
        source_image_key = excluded.source_image_key,
        extraction_confidence = excluded.extraction_confidence,
        needs_review = excluded.needs_review,
        updated_at = excluded.updated_at`,
    )
    .bind(
      contact.id,
      userId,
      contact.name,
      contact.company,
      contact.role,
      contact.email,
      JSON.stringify(contact.phones),
      contact.website,
      contact.address,
      JSON.stringify(contact.tags),
      contact.notes,
      contact.nextStep,
      contact.status,
      contact.sourceImageKey,
      contact.extractionConfidence,
      contact.needsReview ? 1 : 0,
      contact.createdAt,
      contact.updatedAt,
    )
    .run()
  return { ...contact, sourceImageUrl: imageUrl(contact.sourceImageKey) }
}

export async function deleteContact(db: D1Database, id: string, userId = LOCAL_USER_ID): Promise<boolean> {
  await ensureSchema(db)
  const result = await db
    .batch([
      db.prepare('DELETE FROM extraction_jobs WHERE contact_id = ? AND user_id = ?').bind(id, userId),
      db.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?').bind(id, userId),
    ])
    .then((results) => results[1])
  return result.meta.changes > 0
}

export async function saveExtractionJob(
  db: D1Database,
  input: {
    id: string
    contactId: string
    sourceImageKey: string
    status: string
    error?: string
    rawExtractionJson: string
  },
  userId = LOCAL_USER_ID,
): Promise<void> {
  await ensureSchema(db)
  const now = new Date().toISOString()
  await ensureUser(db, userId, undefined, undefined, undefined, now)
  await db
    .prepare(
      `INSERT INTO extraction_jobs (
        id, user_id, contact_id, source_image_key, status, error, raw_extraction_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      userId,
      input.contactId,
      input.sourceImageKey,
      input.status,
      input.error || '',
      input.rawExtractionJson,
      now,
      now,
    )
    .run()
}

export function rowToContact(row: ContactRow): Contact {
  return {
    id: row.id,
    name: row.name,
    company: row.company,
    role: row.role,
    email: row.email,
    phones: readJsonArray(row.phones_json),
    website: row.website,
    address: row.address,
    tags: readJsonArray(row.tags_json),
    notes: row.notes,
    nextStep: row.next_step,
    status: status(row.status),
    sourceImageKey: row.source_image_key,
    sourceImageUrl: imageUrl(row.source_image_key),
    extractionConfidence: row.extraction_confidence,
    needsReview: Boolean(row.needs_review),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function addColumnIfMissing(db: D1Database, tableName: string, columnName: string, definition: string): Promise<void> {
  const info = await db.prepare(`PRAGMA table_info(${tableName})`).all<TableInfoRow>()
  const hasColumn = (info.results || []).some((row) => row.name === columnName)
  if (!hasColumn) {
    await db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run()
  }
}

async function ensureUser(
  db: D1Database,
  userId: string,
  email = `${userId}@cardcap.local`,
  name = userId,
  authProvider = userId === LOCAL_USER_ID ? 'local' : 'beta',
  now = new Date().toISOString(),
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (id, email, name, auth_provider, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(userId, email, name, authProvider, now, now)
    .run()
}

function readJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function status(value: string): ContactStatus {
  if (value === 'Follow up' || value === 'Active' || value === 'Archived') return value
  return 'New'
}

function imageUrl(key: string): string {
  return key ? `/api/images/${encodeURIComponent(key)}` : ''
}
