import { readFileSync } from 'node:fs'
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import { PNG_BUFFER, PNG_HEIGHT, PNG_WIDTH } from '../fixtures'

// Real Chromium against the built SPA + the real Worker on local Miniflare (see e2e/browser/server.ts).
// OpenAI/Resend are intercepted by the server; data is synthetic.

const UPSTREAM_SECRET = 'upstream-internal-detail-abc123'

let counter = 0
const uniqueEmail = (name: string) => `${name}-${Date.now()}-${++counter}@example.test`

async function signIn(page: Page, request: APIRequestContext, email: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Use email link' }).click()
  await page.getByPlaceholder('you@company.com').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect.poll(async () => (await request.get(`/__test/login-link?email=${encodeURIComponent(email)}`)).status()).toBe(200)
  const link = await (await request.get(`/__test/login-link?email=${encodeURIComponent(email)}`)).text()
  await page.goto(link)
  await expect(page.getByRole('button', { name: 'Add Cards' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
}

async function uploadCard(page: Page, name = 'maria-card.png') {
  await page.locator('input[type=file][accept="image/*"]').setInputFiles({ name, mimeType: 'image/png', buffer: PNG_BUFFER })
}

async function r2Keys(request: APIRequestContext): Promise<string[]> {
  return (await request.get('/__test/r2')).json()
}

async function downloadText(page: Page, buttonName: string): Promise<{ text: string; filename: string }> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: buttonName, exact: true }).click()])
  return { text: readFileSync(await download.path(), 'utf8'), filename: download.suggestedFilename() }
}

test.beforeEach(async ({ request }) => {
  await request.get('/__test/openai?mode=card')
})

test('upload → review/edit → save → reload → export keeps exactly the corrected values', async ({ page, request }) => {
  await signIn(page, request, uniqueEmail('alice'))
  await uploadCard(page)

  // Draft from the card, flagged for review.
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Maria Okafor')
  await expect(page.getByText('Needs review').first()).toBeVisible()
  await expect(page.getByLabel('Company', { exact: true })).toHaveValue('Sunrise Realty Group')

  // Review/edit like a person: fix name and role, set status, and use the explicit Save Contact button first.
  await page.getByLabel('Name', { exact: true }).fill('Maria Okafor-Lee')
  await page.getByLabel('Role', { exact: true }).fill('Managing Broker')
  await page.locator('.form-grid select').selectOption('Active')
  await page.getByRole('button', { name: 'Save Contact' }).click()
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
  await expect(page.getByText('Needs review').first()).toBeVisible() // saving alone does not clear the review flag

  // Reload after Save Contact: values persisted on the server, still flagged for review.
  await page.reload()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Maria Okafor-Lee')
  await expect(page.getByLabel('Role', { exact: true })).toHaveValue('Managing Broker')
  await expect(page.locator('.form-grid select')).toHaveValue('Active')
  await expect(page.getByText('Needs review').first()).toBeVisible()

  // Then mark reviewed, which clears the flag.
  await page.getByRole('button', { name: 'Mark Reviewed' }).click()
  await expect(page.getByText('Marked reviewed.', { exact: true })).toBeVisible()
  await expect(page.getByText('Needs review')).toHaveCount(0)

  // Reload: same values come back from the server, not from client memory; the real image renders.
  await page.reload()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Maria Okafor-Lee')
  await expect(page.getByLabel('Role', { exact: true })).toHaveValue('Managing Broker')
  await expect(page.locator('.form-grid select')).toHaveValue('Active')
  await expect(page.getByText('Needs review')).toHaveCount(0)
  const image = page.locator('img').first()
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => `${img.complete}:${img.naturalWidth}x${img.naturalHeight}`)).toBe(`true:${PNG_WIDTH}x${PNG_HEIGHT}`)

  // Export: the downloaded CSV has exactly the corrected row.
  const csv = await downloadText(page, 'CSV')
  expect(csv.filename).toBe('cardcap-contacts.csv')
  expect(csv.text).toBe(
    [
      'name,company,role,email,phones,website,address,tags,status,next_step,notes',
      'Maria Okafor-Lee,Sunrise Realty Group,Managing Broker,maria@sunrise.example,(602) 555-0142,https://sunrise.example,"12 Main St, Phoenix, AZ","Luxury",Active,,Met at expo',
    ].join('\n'),
  )
  const vcf = await downloadText(page, 'vCard')
  expect(vcf.text).toContain('FN:Maria Okafor-Lee\r\n')
  expect(vcf.text).toContain('TITLE:Managing Broker\r\n')
})

test('a failed extraction shows a safe message, leaves nothing behind, and a retry works', async ({ page, request }) => {
  await signIn(page, request, uniqueEmail('alice'))
  const r2Before = await r2Keys(request)

  await request.get('/__test/openai?mode=error')
  await uploadCard(page)
  const banner = page.locator('.banner.error')
  await expect(banner).toBeVisible()
  await expect(banner).not.toContainText(UPSTREAM_SECRET)
  await expect(banner).not.toContainText('OpenAI')
  expect(await r2Keys(request)).toEqual(r2Before)
  await expect(page.getByText('No contacts yet.')).toBeVisible()

  await request.get('/__test/openai?mode=card')
  await uploadCard(page)
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Maria Okafor')
  expect((await r2Keys(request)).length).toBe(r2Before.length + 1)
})

test('forged Cloudflare Access identity is not a login', async ({ browser }) => {
  const context = await browser.newContext({
    extraHTTPHeaders: { 'Cf-Access-Authenticated-User-Email': 'alice@example.test' },
  })
  await context.addCookies([{ name: 'CF_Authorization', value: `x.${Buffer.from(JSON.stringify({ sub: 'attacker', email: 'alice@example.test' })).toString('base64url')}.y`, url: 'http://127.0.0.1:5199' }])
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Sign in to CardCap' })).toBeVisible()
  expect((await page.request.get('/api/contacts')).status()).toBe(401)
  await context.close()
})

async function newUser(browser: Browser, request: APIRequestContext, name: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signIn(page, request, uniqueEmail(name))
  return { context, page }
}

test("cross-user isolation: another user's browser session cannot see, read the image of, or change a contact", async ({ browser, request }) => {
  const alice = await newUser(browser, request, 'alice')
  await uploadCard(alice.page)
  await expect(alice.page.getByLabel('Name', { exact: true })).toHaveValue('Maria Okafor')
  const imageUrl = (await alice.page.locator('img').first().getAttribute('src'))!
  const contacts = (await (await alice.page.request.get('/api/contacts')).json()) as { contacts: Array<{ id: string }> }
  const aliceContactId = contacts.contacts[0].id
  expect((await alice.page.request.get(imageUrl)).status()).toBe(200)

  const bob = await newUser(browser, request, 'bob')
  await expect(bob.page.getByText('No contacts yet.')).toBeVisible()
  await expect(bob.page.getByText('Maria Okafor')).toHaveCount(0)
  expect((await bob.page.request.get(imageUrl)).status()).toBe(404)
  expect((await bob.page.request.get(`/api/contacts/${aliceContactId}`)).status()).toBe(404)
  const put = await bob.page.request.put(`/api/contacts/${aliceContactId}`, { data: { name: 'Hijacked' } })
  expect(put.status()).toBe(404)
  const csv = await bob.page.request.get('/api/export.csv')
  expect(await csv.text()).not.toContain('Maria')

  // Alice is untouched and still sees her image.
  await alice.page.reload()
  await expect(alice.page.getByLabel('Name', { exact: true })).toHaveValue('Maria Okafor')
  expect((await alice.page.request.get(imageUrl)).status()).toBe(200)
  await alice.context.close()
  await bob.context.close()
})

test('password: set it in the account panel, sign out, then sign in with email and password', async ({ page, request }) => {
  const email = uniqueEmail('alice')
  await signIn(page, request, email)
  await uploadCard(page)
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Maria Okafor')

  await page.getByRole('button', { name: 'Set password' }).click()
  await page.getByLabel('New password').fill('correct horse battery')
  await page.getByLabel('Confirm password').fill('different password')
  await page.getByRole('button', { name: 'Save password' }).click()
  await expect(page.getByText('Passwords do not match.')).toBeVisible()

  await page.getByLabel('Confirm password').fill('correct horse battery')
  await page.getByRole('button', { name: 'Save password' }).click()
  await expect(page.getByText('Password saved.')).toBeVisible()

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in to CardCap' })).toBeVisible()

  await page.getByPlaceholder('you@company.com').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('wrong password here')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText('Invalid email or password.')).toBeVisible()

  await page.getByLabel('Password', { exact: true }).fill('correct horse battery')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Maria Okafor')

  // The session survives a reload.
  await page.reload()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Maria Okafor')
})
