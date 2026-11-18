import { expect, it, vi } from 'vitest'
import worker from '../src/worker/index'
import type { Contact } from '../src/shared/types'
import { SESSION_SECRET, startHarness } from './harness'
import { utcDayStartIso } from '../src/shared/quota'

it('limits capture per account, returns an unsaved draft, and preserves its source after review', async () => {
  const h = await startHarness()
  try {
    const db = await h.mf.getD1Database('DB')
    const alice = await h.signIn('capture@example.test')
    const run = vi.fn(async () => ({ response: { company: 'Acme Studio', phones: ['480-555-0101'] } }))
    const env = { DB: db, SESSION_SECRET, AI: { run } } as unknown as Env
    const input = 'Acme Studio\n480-555-0101'
    const capture = (cookie: string) => worker.fetch(new Request('https://cardcap.test/api/contact-drafts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ input }),
    }), env, { waitUntil() {} } as unknown as ExecutionContext)
    expect((await capture('')).status).toBe(401)
    const response = await capture(alice.cookie)
    expect(response.status).toBe(200)
    const { contact } = await response.json() as { contact: Contact }
    expect(contact.source?.text).toBe(input)
    expect(await (await alice.request('/api/contacts')).json()).toEqual({ contacts: [] })
    const saved = await alice.request('/api/contacts', { method: 'POST', body: JSON.stringify({ contact: { ...contact, needsReview: false } }) })
    expect(saved.status).toBe(201)
    const list = await (await alice.request('/api/contacts')).json() as { contacts: Contact[] }
    expect(list.contacts[0]).toMatchObject({ name: '', company: 'Acme Studio', needsReview: false, source: contact.source })
    await db.prepare('UPDATE capture_usage SET attempts = 25 WHERE day = ?').bind(utcDayStartIso()).run()
    expect((await capture(alice.cookie)).status).toBe(429)
    expect(run).toHaveBeenCalledTimes(1)
  } finally {
    await h.dispose()
  }
})
