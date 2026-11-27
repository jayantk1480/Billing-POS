import { expect, type Page, test } from '@playwright/test';
import { CASHIER, POS_URL } from '../support/env.js';
import { clearRateLimits } from '../support/helpers.js';

// The billing screen on a phone. Runs last: it adds a bill of its own, which the report tests before it do not expect.
test.describe.configure({ mode: 'serial' });
test.use({ baseURL: POS_URL, hasTouch: true });
test.beforeEach(clearRateLimits);
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.print = () => window.dispatchEvent(new Event('afterprint'));
  });
});

const item = (page: Page, name: string) => page.getByRole('list', { name: 'Items', exact: true }).getByRole('button', { name: new RegExp(name) });

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(CASHIER.email);
  await page.getByLabel('Password').fill(CASHIER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const terminal = page.getByRole('button', { name: /Counter 1/ });
  await expect(terminal.or(page.getByLabel('Search items'))).toBeVisible();
  if (await terminal.isVisible()) await terminal.click();
  await expect(page.getByLabel('Search items')).toBeVisible();
}

/**
 * Every control that is on screen must be wholly on screen: on a phone, a button past the edge cannot be reached.
 * Controls inside something that scrolls sideways on purpose (category chips, wide tables) are left out.
 */
async function expectNothingCutOff(page: Page) {
  const cutOff = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const found: string[] = [];
    for (const element of document.querySelectorAll('button, a, input, select, textarea, [role="radio"], h1, h2')) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      let scrolls = false;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowX)) scrolls = true;
      }
      if (!scrolls && (box.right > width + 1 || box.left < -1)) found.push((element.getAttribute('aria-label') ?? element.textContent ?? element.tagName).trim().slice(0, 40));
    }
    return found;
  });
  expect(cutOff).toEqual([]);
}

for (const screen of [{ name: 'a phone', width: 375, height: 740 }, { name: 'a small phone', width: 320, height: 568 }, { name: 'a phone held sideways', width: 740, height: 375 }]) {
  test(`bill a takeaway order on ${screen.name}`, async ({ page }) => {
    await page.setViewportSize({ width: screen.width, height: screen.height });
    await signIn(page);

    // Everything in the header can be reached.
    for (const name of ['Running orders', "Today's bills", 'User menu']) await expect(page.getByRole('button', { name })).toBeInViewport({ ratio: 1 });
    for (const type of ['Dine-in', 'Takeaway', 'Delivery']) await expect(page.getByRole('radio', { name: type })).toBeInViewport({ ratio: 1 });
    await expectNothingCutOff(page);

    // Categories are there to pick from, and items go into the order.
    await page.getByRole('navigation', { name: 'Categories' }).getByRole('button', { name: 'Beverages' }).click();
    await item(page, 'Masala Tea').click();
    await item(page, 'Masala Tea').click();

    // Dine-in offers the tables, all of them reachable.
    await page.getByRole('radio', { name: 'Dine-in' }).click();
    const tables = page.getByRole('dialog', { name: 'Choose a table' });
    await expect(tables.getByRole('button', { name: /^Table T1,/ })).toBeVisible();
    await expectNothingCutOff(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Choose table' })).toBeInViewport({ ratio: 1 });
    await expectNothingCutOff(page);
    await page.getByRole('radio', { name: 'Takeaway' }).click();

    // The order slides over the menu.
    await page.getByRole('button', { name: /View order \(2\)/ }).click();
    const order = page.getByRole('complementary', { name: 'Current order' });
    await expect(order.getByLabel('Quantity of Masala Tea')).toHaveText('2');
    await expectNothingCutOff(page);

    const billAndPay = order.getByRole('button', { name: /Bill & pay/ });
    await billAndPay.scrollIntoViewIfNeeded();
    await billAndPay.click();
    const pay = page.getByRole('dialog', { name: /Take payment/ });
    await expect(pay).toContainText('Amount due');
    await expectNothingCutOff(page);
    await pay.getByRole('button', { name: 'Complete payment' }).click();
    const done = page.getByRole('dialog', { name: 'Payment complete' });
    await expectNothingCutOff(page);
    await done.getByRole('button', { name: 'New order' }).click();

    // The bill is in today's list, and reports open from the user menu.
    await page.getByRole('button', { name: "Today's bills" }).click();
    const bills = page.getByRole('dialog', { name: "Today's bills" });
    await expect(bills.getByRole('listitem').first()).toContainText('Paid');
    await expectNothingCutOff(page);
    await bills.getByRole('button', { name: 'Close' }).last().click();
    await page.getByRole('button', { name: 'User menu' }).click();
    await expectNothingCutOff(page);
    await page.getByRole('button', { name: 'Reports', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Reports' }).getByRole('button', { name: 'Back to billing' })).toBeInViewport({ ratio: 1 });
    await expectNothingCutOff(page);
  });
}
