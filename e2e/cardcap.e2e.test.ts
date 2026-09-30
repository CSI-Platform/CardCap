import { afterEach, beforeEach, describe, expect, it, onTestFailed } from 'vitest'
import { emptyForm, PNG_BYTES, saveTrace, startHarness, uploadForm, type Harness, type Session } from './harness'

// Synthetic card data. Expected values below are written by hand from what a person would expect to see,
// not derived from the app's own formatting code.
const CARD = {
  name: 'Maria Okafor',
  company: 'Sunrise Realty Group',
  role: 'Broker',
  emails: ['maria@sunrise.example'],
  phones: ['(602) 555-0142', '602-555-0199'],
  website: 'sunrise.example',
  address: '12 Main St, Phoenix, AZ',
  tags: ['Luxury', 'Buyer agent'],
  notes: 'Met at expo',
  confidence: 0.62,
  needs_review: true,
}

let h: Harness

beforeEach(async () => {
  h = await startHarness()
  h.openai.mode = { kind: 'card', card: CARD }
})

afterEach(async () => {
  await h.dispose()
})

function scenario(name: string, fn: () => Promise<void>) {
  it(name, async () => {
    onTestFailed((result) => saveTrace(name, h.trace, result.errors?.[0]?.message))
    await fn()
  })
}

async function uploadCard(session: Session, fileName = 'maria-card.png') {
  const res = await session.request('/api/cards/upload', { method: 'POST', body: uploadForm(fileName) })
  const text = await res.text()
  const body = (text ? JSON.parse(text) : {}) as { contact: Record<string, unknown> & { id: string; sourceImageKey: string; sourceImageUrl: string } }
  return { res, text, body }
}

describe('upload → review/edit → save → reload → export', () => {
  scenario('a scanned card is extracted, corrected by the user, persisted, and exported with the corrected values', async () => {
    const alice = await h.signIn('alice@example.test')

    // Upload: draft arrives flagged for review with what the card said.
    const { res, body } = await uploadCard(alice)
    expect(res.status).toBe(201)
    expect(body.contact).toMatchObject({
      name: 'Maria Okafor',
      company: 'Sunrise Realty Group',
      role: 'Broker',
      email: 'maria@sunrise.example',
      phones: ['(602) 555-0142', '602-555-0199'],
      website: 'https://sunrise.example',
      address: '12 Main St, Phoenix, AZ',
      tags: ['Luxury', 'Buyer agent'],
      notes: 'Met at expo',
      status: 'Follow up',
      nextStep: 'Review extracted card',
      needsReview: true,
      extractionConfidence: 0.62,
    })
    const id = body.contact.id

    // The stored image is the exact uploaded file.
    const image = await alice.request(body.contact.sourceImageUrl)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG_BYTES)

    // Review/edit: the user fixes the name, drops a phone, adds notes, and marks it reviewed.
    const edit = await alice.request(`/api/contacts/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contact: {
          name: 'Maria Okafor-Lee',
          company: 'Sunrise Realty Group',
          role: 'Managing Broker',
          email: 'maria@sunrise.example',
          phones: ['(602) 555-0142'],
          website: 'https://sunrise.example',
          address: '12 Main St, Phoenix, AZ',
          tags: ['Luxury', 'VIP'],
          notes: 'Met at expo; wants condo list, weekly',
          nextStep: 'Send listings Friday',
          status: 'Active',
          needsReview: false,
        },
      }),
    })
    expect(edit.status).toBe(200)

    // Reload: a fresh read returns exactly one contact with the saved values (and the image link survives the edit).
    const list = (await (await alice.request('/api/contacts')).json()) as { contacts: Array<Record<string, unknown>> }
    expect(list.contacts).toHaveLength(1)
    expect(list.contacts[0]).toMatchObject({
      id,
      name: 'Maria Okafor-Lee',
      role: 'Managing Broker',
      phones: ['(602) 555-0142'],
      tags: ['Luxury', 'VIP'],
      notes: 'Met at expo; wants condo list, weekly',
      nextStep: 'Send listings Friday',
      status: 'Active',
      needsReview: false,
      sourceImageUrl: body.contact.sourceImageUrl,
    })
    const reloadedImage = await alice.request(body.contact.sourceImageUrl)
    expect(reloadedImage.status).toBe(200)

    // Export: every format carries the corrected values, not the extracted draft.
    const csv = await alice.request('/api/export.csv')
    expect(csv.headers.get('content-disposition')).toBe('attachment; filename="cardcap-contacts.csv"')
    expect(await csv.text()).toBe(
      [
        'name,company,role,email,phones,website,address,tags,status,next_step,notes',
        'Maria Okafor-Lee,Sunrise Realty Group,Managing Broker,maria@sunrise.example,(602) 555-0142,https://sunrise.example,"12 Main St, Phoenix, AZ","Luxury; VIP",Active,Send listings Friday,"Met at expo; wants condo list, weekly"',
      ].join('\n'),
    )

    const vcf = await alice.request('/api/export.vcf')
    expect(await vcf.text()).toBe(
      [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Maria Okafor-Lee',
        'ORG:Sunrise Realty Group',
        'TITLE:Managing Broker',
        'TEL;TYPE=CELL:(602) 555-0142',
        'EMAIL:maria@sunrise.example',
        'URL:https://sunrise.example',
        'ADR;TYPE=WORK:;;12 Main St\\, Phoenix\\, AZ;;;;',
        'NOTE:Send listings Friday - Met at expo\\; wants condo list\\, weekly',
        'END:VCARD',
      ].join('\r\n'),
    )

    const icontact = (await (await alice.request('/api/export.icontact.csv')).text()).split('\n')
    expect(icontact[0]).toBe('Email,First Name,Last Name,Company,Job Title,Phone,Street,City,State,Zip,Notes')
    expect(icontact[1].startsWith('maria@sunrise.example,Maria,Okafor-Lee,Sunrise Realty Group,Managing Broker,(602) 555-0142,')).toBe(true)

    const json = (await (await alice.request('/api/export.json')).json()) as Array<Record<string, unknown>>
    expect(json).toHaveLength(1)
    expect(json[0]).toMatchObject({ id, name: 'Maria Okafor-Lee', status: 'Active', needsReview: false })
  })

  scenario('re-uploading the same card updates the existing contact instead of creating a second one', async () => {
    const alice = await h.signIn('alice@example.test')
    const first = await uploadCard(alice)
    const second = await uploadCard(alice, 'maria-card-again.png')
    expect(second.res.status).toBe(200)
    const list = (await (await alice.request('/api/contacts')).json()) as { contacts: unknown[] }
    expect(list.contacts).toHaveLength(1)
    expect(second.body.contact.id).toBe(first.body.contact.id)
  })
})

describe('failed extraction', () => {
  scenario('an extraction service error fails the upload cleanly: no contact, no orphaned image, no upstream detail leaked', async () => {
    const alice = await h.signIn('alice@example.test')
    h.openai.mode = { kind: 'http-error', status: 500, body: 'upstream-internal-detail-abc123' }

    const { res, text } = await uploadCard(alice)
    expect(res.status).toBe(502)
    expect(text).not.toContain('upstream-internal-detail-abc123')

    const list = (await (await alice.request('/api/contacts')).json()) as { contacts: unknown[] }
    expect(list.contacts).toEqual([])
    expect(await h.r2Keys()).toEqual([])
  })

  scenario('unparseable model output fails the upload cleanly with no contact and no orphaned image', async () => {
    const alice = await h.signIn('alice@example.test')
    h.openai.mode = { kind: 'garbage' }

    const { res } = await uploadCard(alice)
    expect([422, 502]).toContain(res.status)

    const list = (await (await alice.request('/api/contacts')).json()) as { contacts: unknown[] }
    expect(list.contacts).toEqual([])
    expect(await h.r2Keys()).toEqual([])
  })

  scenario('after a failed extraction the user can retry the same card and get one correct contact', async () => {
    const alice = await h.signIn('alice@example.test')
    h.openai.mode = { kind: 'http-error', status: 503, body: 'overloaded' }
    expect((await uploadCard(alice)).res.status).toBe(502)

    h.openai.mode = { kind: 'card', card: CARD }
    const retry = await uploadCard(alice)
    expect(retry.res.status).toBe(201)

    const list = (await (await alice.request('/api/contacts')).json()) as { contacts: Array<{ name: string }> }
    expect(list.contacts.map((c) => c.name)).toEqual(['Maria Okafor'])
    expect(await h.r2Keys()).toHaveLength(1)
  })

  scenario('non-image and missing files are rejected before anything is stored or sent to the extractor', async () => {
    const alice = await h.signIn('alice@example.test')
    const notImage = await alice.request('/api/cards/upload', { method: 'POST', body: uploadForm('notes.txt', 'text/plain', new TextEncoder().encode('hello')) })
    expect(notImage.status).toBe(400)
    const noFile = await alice.request('/api/cards/upload', { method: 'POST', body: emptyForm() })
    expect(noFile.status).toBe(400)
    expect(await h.r2Keys()).toEqual([])
    expect(h.openai.calls).toBe(0)
  })
})

describe('cross-user isolation', () => {
  async function aliceWithCard() {
    const alice = await h.signIn('alice@example.test')
    const bob = await h.signIn('bob@example.test')
    const { body } = await uploadCard(alice)
    return { alice, bob, contact: body.contact }
  }

  async function aliceContact(alice: Session, id: string) {
    const res = await alice.request(`/api/contacts/${id}`)
    return { status: res.status, contact: ((await res.json()) as { contact?: Record<string, unknown> }).contact }
  }

  scenario("another user does not see, fetch, or export someone else's contacts", async () => {
    const { bob, contact } = await aliceWithCard()

    expect(((await (await bob.request('/api/contacts')).json()) as { contacts: unknown[] }).contacts).toEqual([])
    expect((await bob.request(`/api/contacts/${contact.id}`)).status).toBe(404)

    for (const path of ['/api/export.csv', '/api/export.vcf', '/api/export.json', '/api/export.icontact.csv', '/api/export.html']) {
      const text = await (await bob.request(path)).text()
      expect(text, path).not.toContain('Maria')
      expect(text, path).not.toContain('maria@sunrise.example')
    }
  })

  scenario("another user cannot read someone else's card image", async () => {
    const { alice, bob, contact } = await aliceWithCard()
    expect((await alice.request(contact.sourceImageUrl)).status).toBe(200)
    const stolen = await bob.request(contact.sourceImageUrl)
    expect(stolen.status).toBe(404)
    expect(new Uint8Array(await stolen.arrayBuffer())).not.toEqual(PNG_BYTES)
  })

  scenario('the owner’s image response is not cacheable across accounts and cannot run as active content', async () => {
    const { alice, contact } = await aliceWithCard()
    const res = await alice.request(contact.sourceImageUrl)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toMatch(/private/)
    expect(res.headers.get('cache-control')).toMatch(/no-store/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/)
    expect(res.headers.get('content-security-policy')).toMatch(/sandbox/)
  })

  scenario("another user cannot overwrite someone else's contact by PUT to its id", async () => {
    const { alice, bob, contact } = await aliceWithCard()
    const attack = await bob.request(`/api/contacts/${contact.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked', email: 'evil@example.test', status: 'Archived' }),
    })
    expect(attack.status).toBe(404)

    const after = await aliceContact(alice, contact.id)
    expect(after.contact).toMatchObject({ name: 'Maria Okafor', email: 'maria@sunrise.example', status: 'Follow up' })
    expect(((await (await bob.request('/api/contacts')).json()) as { contacts: unknown[] }).contacts).toEqual([])
  })

  scenario("another user cannot overwrite someone else's contact by POSTing a colliding id", async () => {
    const { alice, bob, contact } = await aliceWithCard()
    const attack = await bob.request('/api/contacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: contact.id, name: 'Hijacked', email: 'evil@example.test' }),
    })
    expect([403, 404, 409]).toContain(attack.status)

    const after = await aliceContact(alice, contact.id)
    expect(after.contact).toMatchObject({ name: 'Maria Okafor', email: 'maria@sunrise.example' })
  })

  scenario("another user cannot delete someone else's contact or its image", async () => {
    const { alice, bob, contact } = await aliceWithCard()
    const attack = await bob.request(`/api/contacts/${contact.id}`, { method: 'DELETE' })
    expect(attack.status).toBe(404)
    expect(await attack.json()).toEqual({ deleted: false })

    expect((await aliceContact(alice, contact.id)).status).toBe(200)
    expect((await alice.request(contact.sourceImageUrl)).status).toBe(200)
    expect(await h.r2Keys()).toEqual([contact.sourceImageKey])
  })

  scenario('uploading the same card as another user creates a separate contact and leaves the first untouched', async () => {
    const { alice, bob, contact } = await aliceWithCard()
    const bobs = await uploadCard(bob, 'maria-card.png')
    expect(bobs.res.status).toBe(201)
    expect(bobs.body.contact.id).not.toBe(contact.id)
    expect(bobs.body.contact.sourceImageKey).not.toBe(contact.sourceImageKey)

    const aliceList = (await (await alice.request('/api/contacts')).json()) as { contacts: Array<{ id: string }> }
    expect(aliceList.contacts.map((c) => c.id)).toEqual([contact.id])
    const bobList = (await (await bob.request('/api/contacts')).json()) as { contacts: Array<{ id: string }> }
    expect(bobList.contacts.map((c) => c.id)).toEqual([bobs.body.contact.id])
    expect((await alice.request(bobs.body.contact.sourceImageUrl)).status).toBe(404)
  })
})

describe('unauthenticated and forged access', () => {
  scenario('every protected route rejects a request with no session', async () => {
    const { contact } = await (async () => {
      const alice = await h.signIn('alice@example.test')
      return { contact: (await uploadCard(alice)).body.contact }
    })()
    const anon = h.anonymous()
    const routes: Array<[string, string]> = [
      ['GET', '/api/me'],
      ['GET', '/api/contacts'],
      ['GET', `/api/contacts/${contact.id}`],
      ['GET', contact.sourceImageUrl],
      ['GET', '/api/export.csv'],
      ['GET', '/api/export.vcf'],
      ['GET', '/api/export.json'],
      ['GET', '/api/export.icontact.csv'],
      ['GET', '/api/export.html'],
      ['DELETE', `/api/contacts/${contact.id}`],
    ]
    for (const [method, path] of routes) {
      expect((await anon.request(path, { method })).status, `${method} ${path}`).toBe(401)
    }
    expect((await anon.request('/api/cards/upload', { method: 'POST', body: uploadForm('x.png') })).status).toBe(401)
  })

  scenario('a forged Cloudflare Access identity header is not accepted as a login', async () => {
    const alice = await h.signIn('alice@example.test')
    await uploadCard(alice)
    const forged = await h.anonymous().request('/api/contacts', { headers: { 'Cf-Access-Authenticated-User-Email': 'alice@example.test' } })
    expect(forged.status).toBe(401)
  })

  scenario('a forged Access JWT cookie is not accepted as a login', async () => {
    const payload = btoa(JSON.stringify({ sub: 'attacker', email: 'alice@example.test' })).replace(/=+$/, '')
    const forged = await h.anonymous().request('/api/contacts', { headers: { Cookie: `CF_Authorization=x.${payload}.y` } })
    expect(forged.status).toBe(401)
  })

  scenario("a session cookie with a tampered user id is rejected (cannot impersonate another user)", async () => {
    const alice = await h.signIn('alice@example.test')
    await uploadCard(alice)
    const [version, , expires, signature] = decodeURIComponent(alice.cookie.split('=')[1]).split('.')
    const bobId = btoa('email:bob@example.test').replace(/=+$/, '')
    const tampered = `cardcap_session=${encodeURIComponent([version, bobId, expires, signature].join('.'))}`
    const res = await h.anonymous().request('/api/contacts', { headers: { Cookie: tampered } })
    expect(res.status).toBe(401)
  })

  scenario('a login link works exactly once', async () => {
    // signIn consumes the link; replaying the same token must fail.
    const before = h.trace.length
    await h.signIn('alice@example.test')
    const verifyCall = h.trace.slice(before).find((t) => t.url.startsWith('/api/auth/verify'))!
    const replay = await h.anonymous().request(verifyCall.url)
    expect(replay.status).toBe(410)
  })
})
