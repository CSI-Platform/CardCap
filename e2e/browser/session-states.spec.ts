import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { PNG_BUFFER } from '../fixtures'

// What a person sees when their sign-in ends, is refused, or the network drops.
// These are SIMULATED: the server's answers are replaced with the responses Cloudflare Access and the Worker are
// expected to send (401 + loginUrl, an edge login redirect, 403, a dead connection). They do not prove live Access behavior.

let counter = 0
const uniqueEmail = () => `states-${Date.now()}-${++counter}@example.test`

async function signIn(page: Page, request: APIRequestContext, email: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Use email link' }).click()
  await page.getByPlaceholder('you@company.com').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect.poll(async () => (await request.get(`/__test/login-link?email=${encodeURIComponent(email)}`)).status()).toBe(200)
  await page.goto(await (await request.get(`/__test/login-link?email=${encodeURIComponent(email)}`)).text())
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
}

async function withContact(page: Page, request: APIRequestContext) {
  await request.get('/__test/openai?mode=card')
  await signIn(page, request, uniqueEmail())
  await page.locator('input[type=file][accept="image/*"]').setInputFiles({ name: 'maria.png', mimeType: 'image/png', buffer: PNG_BUFFER })
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Maria Okafor')
  // The upload has fully finished (list reloaded) before the test changes the session underneath it.
  await expect(page.getByRole('status')).toContainText('Cards added')
}

const ended = {
  status: 401,
  contentType: 'application/json',
  body: JSON.stringify({ error: 'Sign in to continue.', loginUrl: '/cdn-cgi/access/login' }),
}

test('expired session (401 + loginUrl): clear dialog, keeps unsaved edits, restores them after signing in again', async ({ page, request }) => {
  await withContact(page, request)
  await page.getByLabel('Name', { exact: true }).fill('Maria Okafor-Lee')

  // The session ends: every save now gets the Access-mode 401.
  await page.route('**/api/contacts/*', (route) => route.fulfill(ended))
  await page.getByRole('button', { name: 'Save Contact' }).click()

  const dialog = page.getByRole('alertdialog', { name: 'Your session ended' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Your contacts are saved')
  await expect(dialog).toContainText('We kept the edits you had not saved')
  await expect(dialog.getByRole('button', { name: 'Sign in again' })).toBeFocused()
  // The page behind is not reachable while the dialog is open.
  await expect(page.locator('.app-content')).toHaveAttribute('inert', '')
  // Tab stays inside the dialog.
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Sign out' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Sign in again' })).toBeFocused()

  // Signing in again (here: the session works again, then the page reloads) brings the edits back, unsaved.
  await page.unroute('**/api/contacts/*')
  await dialog.getByRole('button', { name: 'Sign in again' }).click()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Maria Okafor-Lee')
  await expect(page.getByRole('status')).toContainText('We restored the edits you had not saved')
  // Nothing was saved behind the person's back.
  const saved = (await (await page.request.get('/api/contacts')).json()) as { contacts: Array<{ name: string }> }
  expect(saved.contacts.map((c) => c.name)).toEqual(['Maria Okafor'])
  await page.getByRole('button', { name: 'Save Contact' }).click()
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
})

test('an edge login redirect instead of JSON is treated as an ended session, not a broken page', async ({ page, request }) => {
  await withContact(page, request)
  await page.route('**/api/contacts/*', (route) =>
    route.fulfill({ status: 302, headers: { location: 'https://csi-test.cloudflareaccess.com/cdn-cgi/access/login/cardcap.test?kid=x' }, body: '' }),
  )
  await page.getByRole('button', { name: 'Mark Reviewed' }).click()
  await expect(page.getByRole('alertdialog', { name: 'Your session ended' })).toBeVisible()
  await expect(page.locator('.banner.error')).toHaveCount(0)
})

test('an account that is refused (403) sees who to contact and can sign out', async ({ page, request }) => {
  await withContact(page, request)
  await page.route('**/api/contacts/*', (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'This account is not allowed to use CardCap.' }) }),
  )
  await page.getByRole('button', { name: 'Save Contact' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'This account cannot use CardCap' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('This account is not allowed to use CardCap.')
  await expect(dialog.getByRole('link', { name: 'cody@copperstateit.com' })).toHaveAttribute('href', 'mailto:cody@copperstateit.com')
  await expect(dialog.getByRole('button', { name: 'Sign out and use another account' })).toBeFocused()
})

test('a dead connection says so, is not mistaken for a sign-out, and works again after retrying', async ({ page, request }) => {
  await withContact(page, request)
  await page.route('**/api/contacts/*', (route) => route.abort('connectionfailed'))
  await page.getByRole('button', { name: 'Save Contact' }).click()
  await expect(page.locator('.banner.error')).toContainText('reach CardCap')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await page.unroute('**/api/contacts/*')
  await page.getByRole('button', { name: 'Save Contact' }).click()
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
})

test('sign out goes to the Access logout address the server returns', async ({ page, request }) => {
  await withContact(page, request)
  await page.route('**/api/auth/logout', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, logoutUrl: '/cdn-cgi/access/logout' }) }),
  )
  await page.route('**/cdn-cgi/access/logout', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>edge logout reached</h1>' }))
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/cdn-cgi\/access\/logout$/)
  await expect(page.getByRole('heading', { name: 'edge logout reached' })).toBeVisible()
})

test('a logout address that is not a same-site Access path is never followed', async ({ page, request }) => {
  await withContact(page, request)
  await page.route('**/api/auth/logout', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, logoutUrl: 'https://evil.example/logout' }) }),
  )
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL('http://127.0.0.1:5199/')
  await expect(page.getByRole('heading', { name: 'Sign in to CardCap' })).toBeVisible()
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true })

  test('the session dialog fits, has 44px buttons, and the page does not scroll sideways', async ({ page, request }) => {
    await withContact(page, request)
    await page.route('**/api/contacts/*', (route) => route.fulfill(ended))
    await page.getByRole('button', { name: 'Save Contact' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Your session ended' })
    await expect(dialog).toBeVisible()
    const box = (await dialog.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(375)
    for (const name of ['Sign in again', 'Sign out']) {
      const button = (await dialog.getByRole('button', { name }).boundingBox())!
      expect(button.height, name).toBeGreaterThanOrEqual(44)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  })

  test('the main screen has no sideways scroll and every control is at least 44px tall', async ({ page, request }) => {
    await withContact(page, request)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('button, a.btn, input:not([type=file]), select, textarea, .contact-row')]
        .filter((e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height < 44)
        .map((e) => `${e.tagName}:${(e.innerText || e.className).slice(0, 24)}:${Math.round(e.getBoundingClientRect().height)}`),
    )
    expect(small).toEqual([])
  })
})
