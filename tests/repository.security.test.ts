import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { Contact } from '../src/shared/types'
import { getContact, saveContact } from '../src/worker/repository'

function d1MemoryDatabase(): D1Database {
  const sqlite = new DatabaseSync(':memory:')
  return {
    prepare(sql: string) {
      let args: unknown[] = []
      const statement = {
        bind(...values: unknown[]) { args = values; return statement },
        async run() {
          const result = sqlite.prepare(sql).run(...args as [])
          return { meta: { changes: Number(result.changes) } }
        },
        async all() { return { results: sqlite.prepare(sql).all(...args as []) } },
        async first() { return sqlite.prepare(sql).get(...args as []) ?? null },
      }
      return statement
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      return results
    },
  } as unknown as D1Database
}

function contact(name: string): Omit<Contact, 'sourceImageUrl'> {
  return {
    id: 'shared-id', name, company: '', role: '', email: '', phones: [], website: '',
    address: '', tags: [], notes: '', nextStep: '', status: 'New', sourceImageKey: '',
    extractionConfidence: 0, needsReview: false,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }
}

describe('contact upsert ownership', () => {
  it('rejects a cross-user ID collision without changing or exposing the victim row', async () => {
    const db = d1MemoryDatabase()
    await saveContact(db, contact('Victim private contact'), 'email:victim@example.invalid')

    await expect(
      saveContact(db, contact('Attacker overwrite'), 'email:attacker@example.invalid'),
    ).rejects.toThrow('Contact id is not available')

    expect((await getContact(db, 'shared-id', 'email:victim@example.invalid'))?.name).toBe('Victim private contact')
    expect(await getContact(db, 'shared-id', 'email:attacker@example.invalid')).toBeNull()
  })

  it('still updates a contact owned by the same user', async () => {
    const db = d1MemoryDatabase()
    await saveContact(db, contact('Before'), 'email:owner@example.invalid')
    await saveContact(db, contact('After'), 'email:owner@example.invalid')
    expect((await getContact(db, 'shared-id', 'email:owner@example.invalid'))?.name).toBe('After')
  })
})
