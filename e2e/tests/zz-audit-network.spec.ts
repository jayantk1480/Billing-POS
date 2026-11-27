import { expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { CASHIER, DATABASE_URL, POS_URL } from '../support/env.js';
import { clearRateLimits } from '../support/helpers.js';

/**
 * A connection that drops at the wrong moment: the request reached the API and was carried out, but the answer never
 * came back to the till. Retrying must not record the money twice or leave the cashier stuck.
 */
async function signIn(page: Page) {
  await page.goto(POS_URL);
  await page.getByLabel('Email').fill(CASHIER.email);
  await page.getByLabel('Password').fill(CASHIER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const terminal = page.getByRole('button', { name: /Counter 1/ });
  await expect(terminal.or(page.getByLabel('Search items'))).toBeVisible();
  if (await terminal.isVisible()) await terminal.click();
  await expect(page.getByLabel('Search items')).toBeVisible();
}
const addTea = (page: Page) => page.getByRole('list', { name: 'Items', exact: true }).getByRole('button', { name: /Masala Tea/ }).first().click();

/** Lets the first matching request through to the API, then drops its answer as a broken connection would. */
async function loseFirstAnswer(page: Page, pattern: string) {
  let lost = false;
  await page.route(pattern, async (route) => {
    if (lost || route.request().method() !== 'POST') return route.continue();
    lost = true;
    await route.fetch();
    await route.abort('connectionreset');
  });
}

async function query<T>(sql: string, values: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(sql, values)).rows as T[];
  } finally {
    await client.end();
  }
}

test.beforeEach(async () => {
  await clearRateLimits();
});

test('a payment whose answer is lost is recorded once when the cashier presses again', async ({ page }) => {
  await signIn(page);
  await addTea(page);
  await page.getByRole('button', { name: /Bill & pay/ }).click();
  const pay = page.getByRole('dialog', { name: /Take payment/ });
  const billNumber = (await pay.textContent())!.match(/A1\/\d{4}\/\d{6}/)![0];

  await loseFirstAnswer(page, '**/api/v1/invoices/*/payments');
  await pay.getByRole('button', { name: 'Complete payment' }).click();
  await expect(pay.getByRole('button', { name: 'Complete payment' })).toBeEnabled();
  await pay.getByRole('button', { name: 'Complete payment' }).click();
  await expect(page.getByRole('dialog', { name: 'Payment complete' })).toBeVisible();

  const rows = await query<{ count: string }>(
    'SELECT COUNT(*) FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.invoice_number = $1', [billNumber],
  );
  expect(Number(rows[0]!.count)).toBe(1);
});

test('a bill whose answer is lost can still be paid: pressing Bill & pay again opens it', async ({ page }) => {
  await signIn(page);
  await addTea(page);
  await addTea(page);
  const before = await query<{ count: string }>('SELECT COUNT(*) FROM invoices');

  await loseFirstAnswer(page, '**/api/v1/orders/*/invoices');
  await page.getByRole('button', { name: /Bill & pay/ }).click();
  await expect(page.getByRole('button', { name: /Bill & pay/ })).toBeEnabled();
  // The bill was issued on the server; the till does not know yet.
  const after = await query<{ count: string }>('SELECT COUNT(*) FROM invoices');
  expect(Number(after[0]!.count)).toBe(Number(before[0]!.count) + 1);

  await page.getByRole('button', { name: /Bill & pay/ }).click();
  const pay = page.getByRole('dialog', { name: /Take payment/ });
  await expect(pay).toBeVisible();
  await pay.getByRole('button', { name: 'Complete payment' }).click();
  await expect(page.getByRole('dialog', { name: 'Payment complete' })).toBeVisible();
  // Still one bill for the order: the retry did not bill it twice.
  const final = await query<{ count: string }>('SELECT COUNT(*) FROM invoices');
  expect(Number(final[0]!.count)).toBe(Number(before[0]!.count) + 1);
});
