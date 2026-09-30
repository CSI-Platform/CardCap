import { expect, type Page } from '@playwright/test'

export const WELCOME_HEADING = 'Add your first business cards'

/** Open the Export or Account menu and press one of its items. */
export async function chooseFromMenu(page: Page, menu: 'Export' | 'Account', item: string) {
  const button = menu === 'Export' ? page.getByRole('button', { name: 'Export', exact: true }) : page.getByRole('button', { name: /^Account menu/ })
  await button.click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

/** Open a contact from the list (nothing is open by default after a page load). */
export async function openContact(page: Page, name: string) {
  await page.locator('.contact-row', { hasText: name }).first().click()
  await expect(page.getByLabel('Name', { exact: true })).toBeVisible()
}

export async function expectSignedInAs(page: Page, email: string) {
  await page.getByRole('button', { name: /^Account menu/ }).click()
  await expect(page.getByRole('menu')).toContainText(`Signed in as ${email}`)
  await page.keyboard.press('Escape')
}
