import { expect, type Page, test } from '@playwright/test';
import { CASHIER, OWNER, POS_URL, WEB_URL } from '../support/env.js';
import { clearRateLimits } from '../support/helpers.js';

/**
 * A customer named at the counter is a record of their own: the back office lists them with their orders, bill
 * numbers and amounts, and the billing screen fills their details in again from the phone number.
 */
const item = (page: Page, name: string) => page.getByRole('list', { name: 'Items', exact: true }).getByRole('button', { name: new RegExp(name) });

async function signInPos(page: Page) {
  await page.goto(POS_URL);
  await page.getByLabel('Email').fill(CASHIER.email);
  await page.getByLabel('Password').fill(CASHIER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const terminal = page.getByRole('button', { name: /Counter 1/ });
  await expect(terminal.or(page.getByLabel('Search items'))).toBeVisible();
  if (await terminal.isVisible()) await terminal.click();
  await expect(page.getByLabel('Search items')).toBeVisible();
}

/** Bills and pays the order on screen; returns the bill number and the amount as the payment screen showed them. */
async function billAndPay(page: Page) {
  await page.getByRole('button', { name: /Bill & pay/ }).click();
  const pay = page.getByRole('dialog', { name: /Take payment/ });
  const text = (await pay.textContent())!;
  const bill = text.match(/A1\/\d{4}\/\d{6}/)![0];
  const amount = text.match(/₹[\d,]+\.\d{2}/)![0];
  await pay.getByRole('button', { name: 'Complete payment' }).click();
  await page.getByRole('dialog', { name: 'Payment complete' }).getByRole('button', { name: 'New order' }).click();
  return { bill, amount };
}

test('a customer is their mobile number: recognised by it next time and listed in the back office with their orders', async ({ browser }) => {
  await clearRateLimits();
  const pos = await (await browser.newContext()).newPage();
  await pos.addInitScript(() => {
    window.print = () => window.dispatchEvent(new Event('afterprint'));
  });
  await signInPos(pos);

  // A name alone is not a customer: the mobile number is.
  await item(pos, 'Masala Tea').click();
  await pos.getByRole('button', { name: 'Customer' }).click();
  const dialog = pos.getByRole('dialog', { name: 'Customer' });
  await dialog.getByLabel('Name').fill('Asha Mehta');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText('Enter a 10-digit mobile number')).toBeVisible();

  // First visit: the number typed with the country code and spaces is kept as its 10 digits.
  await dialog.getByLabel('Mobile number').fill('+91 98000 12345');
  await expect(dialog.getByText('One number is one customer; their details come back next time.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(pos.getByRole('complementary', { name: 'Current order' })).toContainText('9800012345 · Asha Mehta');
  const first = await billAndPay(pos);

  // Second visit: the first digits bring up the customers on record; picking one fills the form in.
  await item(pos, 'Masala Tea').click();
  await item(pos, 'Masala Tea').click();
  await pos.getByRole('button', { name: 'Customer' }).click();
  await dialog.getByLabel('Mobile number').fill('9800012');
  const offered = dialog.getByRole('list', { name: 'Customers on record' });
  await expect(offered.getByRole('button')).toHaveText([/9800012345 · Asha Mehta1 order/]);
  await offered.getByRole('button', { name: /9800012345/ }).click();
  await expect(dialog.getByLabel('Mobile number')).toHaveValue('9800012345');
  await expect(dialog.getByLabel('Name')).toHaveValue('Asha Mehta');
  await expect(offered).toHaveCount(0);
  await expect(dialog.getByText('On record as Asha Mehta · 1 order before')).toBeVisible();
  // A wrong number is said so as it is typed; there is no GSTIN to type.
  await dialog.getByLabel('Mobile number').fill('12345 67890');
  await expect(dialog.getByText('Enter a 10-digit mobile number')).toBeVisible();
  await expect(dialog.getByLabel('GSTIN')).toHaveCount(0);
  await dialog.getByLabel('Mobile number').fill('9800012345');
  await expect(dialog.getByText('Enter a 10-digit mobile number')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save' }).click();
  const second = await billAndPay(pos);
  expect(second.bill).not.toBe(first.bill);

  // The back office: the customer, their two orders, and what they spent.
  const office = await (await browser.newContext()).newPage();
  await office.goto(WEB_URL + '/login');
  await office.getByLabel('Email').fill(OWNER.email);
  await office.getByLabel('Password').fill(OWNER.password);
  await office.getByRole('button', { name: 'Sign in' }).click();
  await office.getByRole('link', { name: 'Customers' }).click();
  await expect(office.getByRole('heading', { name: 'Customers' })).toBeVisible();
  await office.getByLabel('Search customers').fill('98000 12345');
  const row = office.getByRole('row').filter({ hasText: '9800012345' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Asha Mehta');
  const rupees = (text: string) => Number(text.replace(/[^0-9.]/g, ''));
  const spent = rupees(first.amount) + rupees(second.amount);
  await expect(row.locator('td').nth(2)).toHaveText('2');
  expect(rupees(await row.locator('td').nth(3).innerText())).toBe(spent);

  await row.getByRole('button', { name: '9800012345' }).click();
  const details = office.getByRole('dialog', { name: '9800012345' });
  await expect(details).toContainText('Asha Mehta');
  const orders = details.getByRole('row').filter({ hasText: /A1-\d+/ });
  await expect(orders).toHaveCount(2);
  await expect(orders.filter({ hasText: first.bill })).toContainText(first.amount);
  await expect(orders.filter({ hasText: second.bill })).toContainText(second.amount);
  await expect(orders.filter({ hasText: second.bill })).toContainText('Settled');
  await office.keyboard.press('Escape');

  // The list sorts by its headings like every other.
  const heading = office.getByRole('columnheader', { name: 'Orders' });
  await heading.getByRole('button').click();
  await expect(heading).toHaveAttribute('aria-sort', 'ascending');
  await heading.getByRole('button').click();
  await expect(heading).toHaveAttribute('aria-sort', 'descending');
});
