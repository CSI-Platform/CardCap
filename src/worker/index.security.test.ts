import { describe, expect, it } from 'vitest'
import worker from './index'
import { createSessionCookieValue } from './session'

const SECRET = 'test-session-secret-at-least-32-bytes'
const USER_ID = 'email:reader@example.invalid'
const KEY = 'cards/private.jpeg'

function fakeDb(ownsImage: boolean, contactForDeletion = false): D1Database {
  const contact = {
    id: 'contact-1', user_id: USER_ID, name: 'Test', company: '', role: '', email: '',
    phones_json: '[]', website: '', address: '', tags_json: '[]', notes: '', next_step: '',
    status: 'New', source_image_key: KEY, extraction_confidence: 0, needs_review: 0,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  }
  return {
    prepare(sql: string) {
      let args: unknown[] = []
      const statement = {
        bind(...values: unknown[]) { args = values; return statement },
        async first() {
          if (sql.includes('FROM extraction_jobs') && sql.includes('source_image_key')) {
            return ownsImage && args[0] === USER_ID && args[1] === KEY ? { found: 1 } : null
          }
          if (sql.includes('SELECT * FROM contacts')) return contactForDeletion ? contact : null
          return null
        },
        async all() { return { results: [{ name: 'needs_review' }] } },
        async run() { return { meta: { changes: 1 } } },
      }
      return statement
    },
    async batch(statements: unknown[]) { return statements.map(() => ({ meta: { changes: 1 } })) },
  } as unknown as D1Database
}

async function signedRequest(path: string, method = 'GET'): Promise<Request> {
  const cookie = await createSessionCookieValue(USER_ID, SECRET)
  return new Request(`https://cardcap.example.invalid${path}`, {
    method,
    headers: { Cookie: `cardcap_session=${encodeURIComponent(cookie)}` },
  })
}

function fakeEnv(ownsImage: boolean, contactForDeletion = false) {
  const calls = { gets: 0, deletes: 0 }
  const env = {
    SESSION_SECRET: SECRET,
    DB: fakeDb(ownsImage, contactForDeletion),
    CARD_IMAGES: {
      async get() {
        calls.gets += 1
        return { body: 'private image', httpEtag: '"etag"', writeHttpMetadata() {} }
      },
      async delete() { calls.deletes += 1 },
    },
  } as unknown as Env
  return { env, calls }
}

async function handle(request: Request, env: Env): Promise<Response> {
  return worker.fetch(request as unknown as Parameters<typeof worker.fetch>[0], env, { waitUntil() {} } as unknown as ExecutionContext)
}

describe('image ownership', () => {
  it('does not fetch another user’s image from R2', async () => {
    const { env, calls } = fakeEnv(false)
    const response = await handle(await signedRequest(`/api/images/${KEY}`), env)
    expect(response.status).toBe(404)
    expect(calls.gets).toBe(0)
  })

  it('serves an image with a matching extraction-job owner', async () => {
    const { env, calls } = fakeEnv(true)
    const response = await handle(await signedRequest(`/api/images/${KEY}`), env)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('private image')
    expect(calls.gets).toBe(1)
  })

  it('does not delete another user’s image when a contact contains its key', async () => {
    const { env, calls } = fakeEnv(false, true)
    const response = await handle(await signedRequest('/api/contacts/contact-1', 'DELETE'), env)
    expect(response.status).toBe(200)
    expect(calls.deletes).toBe(0)
  })
})
