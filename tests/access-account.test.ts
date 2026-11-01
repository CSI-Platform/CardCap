import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { authenticationMode, resolveAccessUser } from '../src/worker/access'
import { magicLinkUser } from '../src/worker/repository'

function database() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')
  for (const name of ['0001_initial.sql', '0002_login_tokens.sql', '0003_password_auth.sql', '0004_access_identities.sql']) {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'))
  }
  const db = {
    prepare(sql: string) {
      let args: unknown[] = []
      const statement = {
        bind(...values: unknown[]) { args = values; return statement },
        async run() { return sqlite.prepare(sql).run(...args as []) },
        async all() { return { results: sqlite.prepare(sql).all(...args as []) } },
        async first() { return sqlite.prepare(sql).get(...args as []) ?? null },
      }
      return statement
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        sqlite.exec('COMMIT')
        return results
      } catch (error) { sqlite.exec('ROLLBACK'); throw error }
    },
  } as unknown as D1Database
  function user(id: string, email: string) {
    sqlite.prepare("INSERT INTO users VALUES (?, ?, 'Owner', 'local', 'before', 'before')").run(id, email)
  }
  return { db, sqlite, user }
}

const identity = { issuer: 'https://test.cloudflareaccess.com', subject: 'google-subject', email: 'owner@example.invalid' }

describe('Access account compatibility using real migrations', () => {
  it('legacy login rejects duplicate normalized email owners without issuing an identity', async () => {
    const { db, sqlite, user } = database()
    user('one', 'owner@example.invalid'); user('two', ' Owner@Example.invalid ')
    expect(await magicLinkUser(db, identity.email)).toBeNull()
    expect(sqlite.prepare('SELECT count(*) AS count FROM users WHERE lower(trim(email)) = ?').get(identity.email)).toEqual({ count: 2 })
  })

  it('legacy login preserves an opaque owner ID and does not rewrite the account', async () => {
    const { db, sqlite, user } = database()
    user('opaque-owner', ' Owner@Example.invalid ')
    expect(await magicLinkUser(db, identity.email)).toEqual({ id: 'opaque-owner', email: ' Owner@Example.invalid ' })
    expect(sqlite.prepare("SELECT auth_provider,updated_at FROM users WHERE id = 'opaque-owner'").get()).toEqual({ auth_provider: 'local', updated_at: 'before' })
  })
  it('preserves noncanonical ownership and credentials across Google and PIN identities', async () => {
    const { db, sqlite, user } = database()
    user('old-opaque-id', 'Owner@Example.invalid')
    sqlite.prepare("INSERT INTO user_passwords VALUES ('old-opaque-id', 'preserved-hash', 'before')").run()
    sqlite.prepare("INSERT INTO contacts (id,user_id,name,source_image_key,created_at,updated_at) VALUES ('private-contact','old-opaque-id','Private name','private/image.png','before','before')").run()
    expect(await resolveAccessUser(db, identity)).toEqual({ id: 'old-opaque-id', email: 'Owner@Example.invalid' })
    expect((await resolveAccessUser(db, { ...identity, subject: 'pin-subject' })).id).toBe('old-opaque-id')
    expect(sqlite.prepare('SELECT user_id,name,source_image_key FROM contacts').get()).toEqual({ user_id: 'old-opaque-id', name: 'Private name', source_image_key: 'private/image.png' })
    expect(sqlite.prepare('SELECT password_hash FROM user_passwords').get()).toEqual({ password_hash: 'preserved-hash' })
    expect(sqlite.prepare('SELECT count(*) AS count FROM users').get()).toEqual({ count: 1 })
  })

  it('creates one stable account on repeated first login without a password row', async () => {
    const { db, sqlite } = database()
    const first = await resolveAccessUser(db, identity)
    expect(first.email).toBe('owner@example.invalid')
    expect(first.id).toMatch(/^access:[a-f0-9]{64}$/)
    expect(await resolveAccessUser(db, identity)).toEqual(first)
    expect(sqlite.prepare('SELECT count(*) AS count FROM users').get()).toEqual({ count: 1 })
    expect(sqlite.prepare('SELECT count(*) AS count FROM user_passwords').get()).toEqual({ count: 0 })
  })

  it('rejects ambiguous normalized emails without claiming either account', async () => {
    const { db, sqlite, user } = database()
    user('one', 'owner@example.invalid'); user('two', ' Owner@Example.invalid ')
    await expect(resolveAccessUser(db, identity)).rejects.toThrow('Account mapping requires review')
    expect(sqlite.prepare('SELECT count(*) AS count FROM access_identities').get()).toEqual({ count: 0 })
  })

  it('rejects a subject whose email changes instead of silently remapping data', async () => {
    const { db, user } = database()
    user('original', identity.email); user('other', 'other@example.invalid')
    await resolveAccessUser(db, identity)
    await expect(resolveAccessUser(db, { ...identity, email: 'other@example.invalid' })).rejects.toThrow('Account mapping requires review')
  })

  it('does not quietly create a missing migration or fall back to legacy auth', async () => {
    const { db, sqlite } = database()
    sqlite.exec('DROP TABLE access_identities')
    await expect(resolveAccessUser(db, identity)).rejects.toThrow('no such table')
    expect(authenticationMode({} as Env)).toBe('legacy')
    expect(() => authenticationMode({ AUTH_MODE: 'typo' } as unknown as Env)).toThrow('Invalid authentication mode')
  })
})


