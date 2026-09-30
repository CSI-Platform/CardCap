import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { PNG_BUFFER } from '../fixtures'
import { WELCOME_HEADING } from './helpers'

// Layout around the next action: one welcome state when empty, search + list when there are contacts,
// editor + card photo only when a contact is open, menus for Export and Account, one task at a time on phones.

let counter = 0
const uniqueEmail = () => `layout-${Date.now()}-${++counter}@example.test`

async function signIn(page: Page, request: APIRequestContext) {
  const email = uniqueEmail()
  await request.get('/__test/openai?mode=card')
  await page.goto('/')
  await page.getByRole('button', { name: 'Use email link' }).click()
  await page.getByPlaceholder('you@company.com').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect.poll(async () => (await request.get(`/__test/login-link?email=${encodeURIComponent(email)}`)).status()).toBe(200)
  await page.goto(await (await request.get(`/__test/login-link?email=${encodeURIComponent(email)}`)).text())
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible()
}

const csv = [
  'name,company,role,email,phones,website,address,tags,status,next_step,notes',
  'Ada Lovelace,Analytical Engines,Founder,ada@engines.example,,,,,New,,',
  'Zed Zimmer,Zenith Title,Agent,zed@zenith.example,,,,,Follow up,,',
  'Bea Brandt,Bridge Loans,Broker,bea@bridge.example,,,,,Active,,',
].join('\n')

async function importContacts(page: Page) {
  await page.locator('input[type=file][accept*=".csv"]').setInputFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await expect(page.locator('.contact-row')).toHaveCount(3)
}

async function uploadCard(page: Page) {
  await page.locator('input[type=file][accept="image/*"]').setInputFiles({ name: 'maria.png', mimeType: 'image/png', buffer: PNG_BUFFER })
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Maria Okafor')
  await expect(page.getByRole('status')).toContainText('Cards added')
}

test('with no contacts there is one welcoming state and nothing else competing with it', async ({ page, request }) => {
  await signIn(page, request)
  await expect(page.getByRole('heading', { name: WELCOME_HEADING })).toBeVisible()
  await expect(page.getByRole('heading')).toHaveCount(2) // the app name and the welcome
  // No second empty message, no list tools, no editor, no photo panel.
  await expect(page.getByText('Ready for your first batch')).toHaveCount(0)
  await expect(page.getByText('No contacts yet')).toHaveCount(0)
  await expect(page.getByRole('searchbox')).toHaveCount(0)
  await expect(page.locator('.contact-row')).toHaveCount(0)
  await expect(page.getByLabel('Name', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: 'Card photo' })).toHaveCount(0)
  // The next action is obvious: Add cards is the one primary button; Import is secondary.
  await expect(page.getByRole('banner').getByRole('button', { name: 'Add cards' })).toHaveClass(/primary/)
  await expect(page.getByRole('banner').getByRole('button', { name: 'Import' })).not.toHaveClass(/primary/)
  // Only one primary button on the whole screen: the header's Add cards. The welcome offers just the secondary Import.
  await expect(page.locator('.btn.primary')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Add cards' })).toHaveCount(1)
  await expect(page.locator('.welcome-actions .btn')).toHaveText(['Import a file'])
  await expect(page.getByRole('button', { name: 'Import a file' })).not.toHaveClass(/primary/)
})

test('export formats live in one Export menu and sign out lives in the Account menu', async ({ page, request }) => {
  await signIn(page, request)
  const header = page.getByRole('banner')
  // No loose export or sign-out buttons in the header.
  for (const name of ['CSV', 'vCard', 'JSON', 'HTML', 'iContact CSV', 'Sign out', 'Set password']) {
    await expect(header.getByRole('button', { name, exact: true })).toHaveCount(0)
  }
  const exportButton = header.getByRole('button', { name: 'Export', exact: true })
  await expect(exportButton).toHaveAttribute('aria-expanded', 'false')
  await exportButton.click()
  await expect(exportButton).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('menuitem')).toHaveText(['CSV', 'vCard', 'JSON', 'HTML', 'iContact CSV'])
  // Keyboard: the first item is focused, arrows move, Escape closes and puts focus back on the button.
  await expect(page.getByRole('menuitem', { name: 'CSV', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'vCard', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByRole('menuitem', { name: 'iContact CSV', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(exportButton).toBeFocused()
  // Clicking elsewhere closes it too.
  await exportButton.click()
  await page.getByRole('heading', { name: WELCOME_HEADING }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)

  const account = header.getByRole('button', { name: /^Account menu/ })
  await account.click()
  await expect(page.getByRole('menu')).toContainText('Signed in as layout-')
  await expect(page.getByRole('menuitem')).toHaveText(['Set password', 'Sign out'])
})

test('once there are contacts: search and list first; the editor and card photo open only when one is selected', async ({ page, request }) => {
  await signIn(page, request)
  await importContacts(page)
  await page.reload()

  // List state.
  await expect(page.getByRole('heading', { name: WELCOME_HEADING })).toHaveCount(0)
  await expect(page.getByRole('searchbox')).toBeVisible()
  await expect(page.locator('.contact-row')).toHaveCount(3)
  await expect(page.getByLabel('Name', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: 'Card photo' })).toHaveCount(0)

  // Search narrows the list.
  await page.getByRole('searchbox').fill('zenith')
  await expect(page.locator('.contact-row')).toHaveCount(1)
  await expect(page.locator('.contact-row')).toContainText('Zed Zimmer')
  await page.getByRole('searchbox').fill('no such person')
  await expect(page.getByText('No contacts match.')).toBeVisible()
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(page.locator('.contact-row')).toHaveCount(3)

  // Editing state: pick one.
  await page.locator('.contact-row', { hasText: 'Zed Zimmer' }).click()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Zed Zimmer')
  await expect(page.getByRole('complementary', { name: 'Card photo' })).toBeVisible()
  await expect(page.locator('.contact-row.active')).toContainText('Zed Zimmer')
  // The list stays next to the editor on a wide screen.
  await expect(page.getByRole('searchbox')).toBeVisible()
})

test('after adding a card the new contact opens for review with its photo', async ({ page, request }) => {
  await signIn(page, request)
  await uploadCard(page)
  await expect(page.getByRole('complementary', { name: 'Card photo' })).toBeVisible()
  await expect(page.locator('.source-body img')).toBeVisible()
  await expect(page.locator('.review-chip')).toBeVisible()
})

test('controls are compact with a mouse', async ({ page, request }) => {
  await signIn(page, request)
  await importContacts(page)
  const heights = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.toolbar .btn, .filters input, .filters select')].map((e) => Math.round(e.getBoundingClientRect().height)),
  )
  expect(heights.length).toBeGreaterThan(3)
  for (const height of heights) {
    expect(height).toBeGreaterThanOrEqual(40)
    expect(height).toBeLessThanOrEqual(41)
  }
})

test.describe('on a phone: one task at a time', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true })

  test('welcome, then list, then one contact at a time with details and photo on separate screens', async ({ page, request }) => {
    await signIn(page, request)
    // Empty: only the welcome.
    await expect(page.getByRole('heading', { name: WELCOME_HEADING })).toBeVisible()
    await expect(page.getByRole('searchbox')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)

    await importContacts(page)
    await page.reload()
    // List: only the list.
    await expect(page.getByRole('searchbox')).toBeVisible()
    await expect(page.getByLabel('Name', { exact: true })).toHaveCount(0)

    // Open one: only the editor (the list and photo are not on screen).
    await page.locator('.contact-row', { hasText: 'Ada Lovelace' }).click()
    await expect(page.getByLabel('Name', { exact: true })).toBeVisible()
    await expect(page.getByRole('searchbox')).toBeHidden()
    await expect(page.getByRole('complementary', { name: 'Card photo' })).toBeHidden()

    // Photo screen replaces the form.
    await page.getByRole('button', { name: 'Card photo', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Card photo' })).toBeVisible()
    await expect(page.getByLabel('Name', { exact: true })).toBeHidden()
    await page.getByRole('button', { name: 'Details', exact: true }).click()
    await expect(page.getByLabel('Name', { exact: true })).toBeVisible()

    // Back to the list.
    await page.getByRole('button', { name: 'All contacts', exact: true }).click()
    await expect(page.getByRole('searchbox')).toBeVisible()
    await expect(page.getByLabel('Name', { exact: true })).toHaveCount(0)
  })

  test('touch targets are 44px and nothing scrolls sideways in each state', async ({ page, request }) => {
    await signIn(page, request)
    const small = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('button, a.btn, .quick-links a, input:not([type=file]), select, textarea, .contact-row, [role=menuitem]')]
          .filter((e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 44)
          .map((e) => `${e.tagName}:${(e.innerText || e.className).slice(0, 24)}:${Math.round(e.getBoundingClientRect().height)}`),
      )
    expect(await small()).toEqual([])
    await importContacts(page)
    await page.reload()
    expect(await small()).toEqual([])
    await page.locator('.contact-row', { hasText: 'Ada Lovelace' }).click()
    expect(await small()).toEqual([])
    await page.getByRole('banner').getByRole('button', { name: 'Export', exact: true }).click()
    expect(await small()).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  })
})

test('fonts are served from this site: no request goes to a font provider and the Atkinson faces load', async ({ page, request }) => {
  const hosts = new Set<string>()
  const fontFiles: Array<{ url: string; status: number }> = []
  page.on('request', (req) => hosts.add(new URL(req.url()).host))
  page.on('response', (res) => {
    if (res.url().endsWith('.woff2')) fontFiles.push({ url: new URL(res.url()).pathname, status: res.status() })
  })
  await signIn(page, request)
  await page.evaluate(() => document.fonts.ready)
  expect([...hosts]).toEqual(['127.0.0.1:5199'])
  expect(await page.evaluate(() => document.fonts.check('16px "Atkinson Hyperlegible Next"'))).toBe(true)
  expect(await page.evaluate(() => document.fonts.check('12px "Atkinson Hyperlegible Mono"'))).toBe(true)
  expect(fontFiles.length).toBeGreaterThan(0)
  for (const file of fontFiles) {
    expect(file.url).toMatch(/^\/fonts\/atkinson-.*\.woff2$/)
    expect(file.status).toBe(200)
  }
  // The renderer really uses it (not the system fallback).
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain('Atkinson Hyperlegible Next')
})
