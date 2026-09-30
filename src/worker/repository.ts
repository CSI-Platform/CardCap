import type { Contact, ContactStatus } from '../shared/types'
import { normalizeContactTextFields } from '../shared/contact-normalization'

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

export type UserAuth = {
  id: string
  email: string
  passwordHash: string
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
        `CREATE TABLE IF NOT EXISTS user_passwords (
          user_id TEXT PRIMARY KEY,
          password_hash TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id)
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
      db.prepare(
        `CREATE TABLE IF NOT EXISTS login_tokens (
          token_hash TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT NOT NULL DEFAULT ''
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

export class ContactConflictError extends Error {
  constructor() {
    super('Contact id is not available')
    this.name = 'ContactConflictError'
  }
}

export async function ownsImageKey(db: D1Database, userId: string, key: string): Promise<boolean> {
  await ensureSchema(db)
  const row = await db
    .prepare('SELECT 1 AS found FROM extraction_jobs WHERE user_id = ? AND source_image_key = ? LIMIT 1')
    .bind(userId, key)
    .first<{ found: number }>()
  return Boolean(row)
}

export async function saveContact(db: D1Database, contact: ContactWrite, userId = LOCAL_USER_ID): Promise<Contact> {
  await ensureSchema(db)
  await ensureUser(db, userId)
  const normalizedContact = normalizeContactTextFields(contact)
  const result = await db
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
        updated_at = excluded.updated_at
      WHERE contacts.user_id = excluded.user_id`,
    )
    .bind(
      normalizedContact.id,
      userId,
      normalizedContact.name,
      normalizedContact.company,
      normalizedContact.role,
      normalizedContact.email,
      JSON.stringify(normalizedContact.phones),
      normalizedContact.website,
      normalizedContact.address,
      JSON.stringify(normalizedContact.tags),
      normalizedContact.notes,
      normalizedContact.nextStep,
      normalizedContact.status,
      normalizedContact.sourceImageKey,
      normalizedContact.extractionConfidence,
      normalizedContact.needsReview ? 1 : 0,
      normalizedContact.createdAt,
      normalizedContact.updatedAt,
    )
    .run()
  if (result.meta.changes === 0) throw new ContactConflictError()
  return { ...normalizedContact, sourceImageUrl: imageUrl(normalizedContact.sourceImageKey) }
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
  return normalizeContactTextFields({
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
  })
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

export async function getUserByEmail(db: D1Database, email: string): Promise<UserAuth | null> {
  await ensureSchema(db)
  const row = await db
    .prepare(
      `SELECT users.id, users.email, COALESCE(user_passwords.password_hash, '') AS password_hash
       FROM users
       LEFT JOIN user_passwords ON user_passwords.user_id = users.id
       WHERE lower(users.email) = lower(?)
       LIMIT 1`,
    )
    .bind(email)
    .first<{ id: string; email: string; password_hash: string }>()
  return row ? { id: row.id, email: row.email, passwordHash: row.password_hash } : null
}

export async function setUserPasswordHash(db: D1Database, userId: string, passwordHash: string, email?: string): Promise<void> {
  await ensureSchema(db)
  const now = new Date().toISOString()
  await ensureUser(db, userId, email || emailFromUserId(userId) || `${userId}@cardcap.local`, email || userId, 'password', now)
  await db.batch([
    db.prepare('UPDATE users SET auth_provider = ?, updated_at = ? WHERE id = ?').bind('password', now, userId),
    db
      .prepare(
        `INSERT INTO user_passwords (user_id, password_hash, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           password_hash = excluded.password_hash,
           updated_at = excluded.updated_at`,
      )
      .bind(userId, passwordHash, now),
  ])
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

export async function upsertUser(db: D1Database, userId: string, email: string, authProvider: string): Promise<void> {
  await ensureSchema(db)
  const now = new Date().toISOString()
  await ensureUser(db, userId, email, email, authProvider, now)
}

function emailFromUserId(userId: string): string {
  return userId.startsWith('email:') ? userId.slice('email:'.length) : ''
}

export async function countExtractionJobsSince(db: D1Database, userId: string, sinceIso: string): Promise<number> {
  await ensureSchema(db)
  const row = await db
    .prepare('SELECT COUNT(*) AS total FROM extraction_jobs WHERE user_id = ? AND created_at >= ?')
    .bind(userId, sinceIso)
    .first<{ total: number }>()
  return row?.total ?? 0
}

export async function createLoginToken(db: D1Database, tokenHash: string, email: string, expiresAt: string): Promise<void> {
  await ensureSchema(db)
  await db
    .prepare('INSERT INTO login_tokens (token_hash, email, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, email, expiresAt)
    .run()
}

export async function consumeLoginToken(db: D1Database, tokenHash: string, now = new Date()): Promise<string | null> {
  await ensureSchema(db)
  const row = await db
    .prepare('SELECT email, expires_at, used_at FROM login_tokens WHERE token_hash = ?')
    .bind(tokenHash)
    .first<{ email: string; expires_at: string; used_at: string }>()
  if (!row || row.used_at || row.expires_at <= now.toISOString()) return null
  await db
    .prepare('UPDATE login_tokens SET used_at = ? WHERE token_hash = ?')
    .bind(now.toISOString(), tokenHash)
    .run()
  return row.email
}
