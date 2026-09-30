import { expect, test, type Browser, type Page } from '@playwright/test'
import { PNG_BUFFER } from '../fixtures'
import { chooseFromMenu, expectSignedInAs, openContact, WELCOME_HEADING } from './helpers'

// Sign-in through a SIMULATED Cloudflare Access edge (see e2e/browser/server.ts, ACCESS_SIM=1; the port comes from the Playwright project):
// the Worker runs in AUTH_MODE=access, the edge redirects signed-out people to a fake sign-in page, and signed-in
// requests carry a signed Access JWT. This shows how CardCap behaves behind Access; it is not live Access behavior.
test.skip(process.env.ACCESS_SIM !== '1', 'needs the simulated Access server (ACCESS_SIM=1)')

let counter = 0
const uniqueEmail = (name: string) => `${name}-${Date.now()}-${++counter}@example.test`

async function edgeSignIn(page: Page, email: string) {
  await expect(page.getByRole('heading', { name: 'Simulated Access sign-in' })).toBeVisible()
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Continue' }).click()
}

async function openApp(page: Page, email: string, path = '/') {
  await page.goto(path)
  await edgeSignIn(page, email)
  await expect(page.getByRole('button', { name: 'Add cards' })).toBeVisible()
}

async function upload(page: Page) {
  await page.locator('input[type=file][accept="image/*"]').setInputFiles({ name: 'maria.png', mimeType: 'image/png', buffer: PNG_BUFFER })
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Maria Okafor')
  await expect(page.getByRole('status')).toContainText('Cards added')
}

test.beforeEach(async ({ request }) => {
  await request.get('/__test/openai?mode=card')
})

test('first visit goes through the edge, returns to the same address, and shows no CardCap sign-in or password screens', async ({ page, baseURL }) => {
  const email = uniqueEmail('alice')
  await page.goto('/?from=bookmark')
  await expect(page).toHaveURL(/\/sim-idp\?return=/)
  await edgeSignIn(page, email)
  await expect(page).toHaveURL(new URL('/?from=bookmark', baseURL).toString())
  await expect(page.getByRole('button', { name: 'Add cards' })).toBeVisible()
  await expectSignedInAs(page, email)
  await expect(page.getByRole('heading', { name: 'Sign in to CardCap' })).toHaveCount(0)
  await page.getByRole('button', { name: /^Account menu/ }).click()
  await expect(page.getByRole('menuitem', { name: 'Set password' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible()
})

test('upload → review/edit → save → reload keeps the exact values behind Access', async ({ page }) => {
  await openApp(page, uniqueEmail('alice'))
  await upload(page)
  await page.getByLabel('Name', { exact: true }).fill('Maria Okafor-Lee')
  await page.getByRole('button', { name: 'Save Contact' }).click()
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
  await page.reload()
  await openContact(page, 'Maria Okafor-Lee')
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Maria Okafor-Lee')
  await expect(page.locator('.source-body img')).toBeVisible()
})

test('when the session ends the person is told, keeps their edits, signs in again at the edge and is back where they were', async ({ page, request }) => {
  const email = uniqueEmail('alice')
  await openApp(page, email)
  await upload(page)
  await page.getByLabel('Name', { exact: true }).fill('Maria Okafor-Lee')

  await request.get('/__test/access-expire') // the edge session ends; the next API call gets an edge redirect
  await page.getByRole('button', { name: 'Save Contact' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Your session ended' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('We kept the edits you had not saved')
  await expect(page.locator('.banner.error')).toHaveCount(0)

  await dialog.getByRole('button', { name: 'Sign in again' }).click()
  await edgeSignIn(page, email)
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Maria Okafor-Lee')
  await expect(page.getByRole('status')).toContainText('We restored the edits you had not saved')
  await page.getByRole('button', { name: 'Save Contact' }).click()
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
  await page.reload()
  await openContact(page, 'Maria Okafor-Lee')
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Maria Okafor-Lee')
})

const SIGN_OUT_TITLE = 'Sign out of CardCap and Blackboard?'

test('sign out asks first, naming Blackboard, then leaves through the Access logout address and the app is closed again', async ({ page }) => {
  await openApp(page, uniqueEmail('alice'))
  await chooseFromMenu(page, 'Account', 'Sign out')
  const dialog = page.getByRole('alertdialog', { name: SIGN_OUT_TITLE })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Blackboard')
  await expect(dialog).toContainText('up to 30 seconds')
  // The safe choice has focus; nothing has been signed out yet.
  await expect(dialog.getByRole('button', { name: 'Stay signed in' })).toBeFocused()
  await expect(page).not.toHaveURL(/\/cdn-cgi\/access\/logout/)
  await dialog.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page).toHaveURL(/\/cdn-cgi\/access\/logout$/)
  await expect(page.getByRole('heading', { name: 'You are signed out' })).toBeVisible()
  await page.goto('/')
  await expect(page).toHaveURL(/\/sim-idp/)
})

test('staying signed in (button or Escape) keeps the session and puts focus back on the Account button', async ({ page }) => {
  await openApp(page, uniqueEmail('alice'))
  const account = page.getByRole('button', { name: /^Account menu/ })
  for (const way of ['button', 'escape'] as const) {
    await chooseFromMenu(page, 'Account', 'Sign out')
    const dialog = page.getByRole('alertdialog', { name: SIGN_OUT_TITLE })
    await expect(dialog).toBeVisible()
    // Tab stays inside the dialog.
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: 'Sign out', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: 'Stay signed in' })).toBeFocused()
    if (way === 'button') await dialog.getByRole('button', { name: 'Stay signed in' }).click()
    else await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(account).toBeFocused()
    await expect(page).not.toHaveURL(/\/cdn-cgi\/access\/logout/)
  }
  // Still signed in: the app works.
  expect((await page.request.get('/api/me')).status()).toBe(200)
})

test('an account that needs review is refused with a clear message and a way out', async ({ page, request }) => {
  const email = uniqueEmail('dana')
  await request.get(`/__test/seed-duplicate-email?email=${encodeURIComponent(email)}`)
  await page.goto('/')
  await edgeSignIn(page, email)
  const dialog = page.getByRole('alertdialog', { name: 'This account cannot use CardCap' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Account access requires review.')
  await expect(dialog.getByRole('link', { name: 'cody@copperstateit.com' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Sign out and use another account' })).toBeFocused()
  // The way out works even though the Worker refuses this account, and it asks first because it is the shared sign-out.
  await dialog.getByRole('button', { name: 'Sign out and use another account' }).click()
  const confirm = page.getByRole('alertdialog', { name: SIGN_OUT_TITLE })
  await expect(confirm).toBeVisible()
  await expect(confirm).toContainText('Blackboard')
  // Staying signed in goes back to the refusal message.
  await confirm.getByRole('button', { name: 'Stay signed in' }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Sign out and use another account' }).click()
  await confirm.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page).toHaveURL(/\/cdn-cgi\/access\/logout$/)
})

async function person(browser: Browser, baseURL: string | undefined, name: string) {
  const context = await browser.newContext({ baseURL })
  const page = await context.newPage()
  await openApp(page, uniqueEmail(name))
  return { context, page }
}

test("another signed-in person cannot see, open the image of, or change someone else's contact", async ({ browser, baseURL }) => {
  const alice = await person(browser, baseURL, 'alice')
  await upload(alice.page)
  const imageUrl = (await alice.page.locator('.source-body img').getAttribute('src'))!
  const contacts = (await (await alice.page.request.get('/api/contacts')).json()) as { contacts: Array<{ id: string }> }
  const id = contacts.contacts[0].id

  const bob = await person(browser, baseURL, 'bob')
  await expect(bob.page.getByRole('heading', { name: WELCOME_HEADING })).toBeVisible()
  expect((await bob.page.request.get(imageUrl)).status()).toBe(404)
  expect((await bob.page.request.get(`/api/contacts/${id}`)).status()).toBe(404)
  expect((await bob.page.request.put(`/api/contacts/${id}`, { data: { name: 'Hijacked' } })).status()).toBe(404)
  expect((await bob.page.request.delete(`/api/contacts/${id}`)).status()).toBe(404)

  await alice.page.reload()
  await openContact(alice.page, 'Maria Okafor')
  await expect(alice.page.getByLabel('Name', { exact: true })).toHaveValue('Maria Okafor')
  await alice.context.close()
  await bob.context.close()
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true })

  test('signed-in screen fits, shows who is signed in, and every control is at least 44px tall', async ({ page }) => {
    const email = uniqueEmail('alice')
    await openApp(page, email)
    await upload(page)
    await expectSignedInAs(page, email)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('button, a.btn, input:not([type=file]), select, textarea, .contact-row')]
        .filter((e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height < 44)
        .map((e) => `${e.tagName}:${(e.innerText || e.className).slice(0, 24)}:${Math.round(e.getBoundingClientRect().height)}`),
    )
    expect(small).toEqual([])
  })

  test('the sign-out question fits on a phone with 44px buttons and no sideways scroll', async ({ page }) => {
    await openApp(page, uniqueEmail('alice'))
    await chooseFromMenu(page, 'Account', 'Sign out')
    const dialog = page.getByRole('alertdialog', { name: SIGN_OUT_TITLE })
    await expect(dialog).toBeVisible()
    const box = (await dialog.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(375)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(812)
    for (const name of ['Stay signed in', 'Sign out']) {
      const button = (await dialog.getByRole('button', { name, exact: true }).boundingBox())!
      expect(button.height, name).toBeGreaterThanOrEqual(44)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  })
})
