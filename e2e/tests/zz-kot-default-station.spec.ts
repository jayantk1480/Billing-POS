import { type Browser, expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { CASHIER, DATABASE_URL, OWNER, POS_URL, WEB_URL } from '../support/env.js';
import { clearRateLimits } from '../support/helpers.js';

async function query<T>(sql: string, values: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(sql, values)).rows as T[];
  } finally {
    await client.end();
  }
}

/** The POS with no printer and no print bridge, so it prints through the browser: counts what it prints. */
async function openPos(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const counted = window as unknown as { prints: number };
    counted.prints = 0;
    window.print = () => {
      counted.prints += 1;
      window.dispatchEvent(new Event('afterprint'));
    };
  });
  const pos = await context.newPage();
  await pos.goto(POS_URL);
  await pos.getByLabel('Email').fill(CASHIER.email);
  await pos.getByLabel('Password').fill(CASHIER.password);
  await pos.getByRole('button', { name: 'Sign in' }).click();
  const terminal = pos.getByRole('button', { name: /Counter 1/ });
  await expect(terminal.or(pos.getByLabel('Search items'))).toBeVisible();
  if (await terminal.isVisible()) await terminal.click();
  await expect(pos.getByLabel('Search items')).toBeVisible();
  return pos;
}
const prints = (pos: Page) => pos.evaluate(() => (window as unknown as { prints: number }).prints);
const ticketsFor = (name: string) => query<{ station: string; quantity: number; print_count: number }>(
  `SELECT s.name AS station, i.quantity, k.print_count FROM kots k
   JOIN kitchen_stations s ON s.id = k.station_id JOIN kot_items i ON i.kot_id = k.id WHERE i.name = $1 ORDER BY k.created_at`, [name],
);

async function addByCode(pos: Page, entry: string) {
  await pos.getByLabel('Search items').fill(entry);
  await pos.getByLabel('Search items').press('Enter');
}

async function payAndFinish(pos: Page) {
  const pay = pos.getByRole('dialog', { name: /Take payment/ });
  await expect(pay).toBeVisible();
  await pay.getByRole('button', { name: 'Complete payment' }).click();
  await pos.getByRole('dialog', { name: 'Payment complete' }).getByRole('button', { name: 'New order' }).click();
}

/**
 * Reported on 2026-11-24 as "KOT is not working": products added in the back office without choosing a kitchen station
 * never reached the kitchen. Then, as the owner decided: the KOT button alone makes and prints kitchen tickets, and
 * Bill & pay prints the bill and nothing else. Whether KOT prints is a setting.
 */
test('a product added without choosing a station reaches the kitchen; KOT prints the ticket, Bill & pay only the bill', async ({ browser }) => {
  await clearRateLimits();

  // Back office: a new product, its kitchen station left as it comes.
  const office = await (await browser.newContext()).newPage();
  await office.goto(WEB_URL + '/login');
  await office.getByLabel('Email').fill(OWNER.email);
  await office.getByLabel('Password').fill(OWNER.password);
  await office.getByRole('button', { name: 'Sign in' }).click();
  await office.getByRole('link', { name: 'Products' }).click();
  await office.getByRole('button', { name: 'Add product' }).click();
  const dialog = office.getByRole('dialog');
  const station = dialog.getByLabel('Kitchen station');
  const [first] = await query<{ name: string }>('SELECT name FROM kitchen_stations WHERE is_active ORDER BY sort_order, created_at LIMIT 1');
  await expect(station.locator('option:checked')).toHaveText(`Default (${first!.name})`);
  await expect(station.locator('option')).toContainText(['No kitchen ticket']);
  await dialog.getByLabel('Name', { exact: true }).fill('Cutting Chai');
  await dialog.getByLabel('Price', { exact: true }).fill('20');
  await dialog.getByLabel('Short code').fill('CCH');
  await dialog.getByRole('button', { name: 'Add product' }).click();
  await expect(office.getByText('Product added')).toBeVisible();

  // Out of the box: the KOT button prints the ticket; Bill & pay then prints the bill alone.
  const pos = await openPos(browser);
  await addByCode(pos, '2 CCH');
  await expect(pos.getByLabel('Quantity of Cutting Chai')).toHaveText('2');
  await pos.getByRole('button', { name: 'KOT', exact: true }).click();
  await expect(pos.getByText(new RegExp(`Order .* sent to ${first!.name}`))).toBeVisible();
  await expect.poll(() => prints(pos)).toBe(1);
  await expect.poll(() => ticketsFor('Cutting Chai')).toEqual([{ station: first!.name, quantity: 2, print_count: 1 }]);
  await pos.getByRole('button', { name: /Bill & pay/ }).click();
  await payAndFinish(pos);
  await expect.poll(() => prints(pos)).toBe(2); // the bill

  // Straight to Bill & pay without KOT: the bill prints, and no kitchen ticket is made at all.
  await addByCode(pos, '1 CCH');
  await pos.getByRole('button', { name: /Bill & pay/ }).click();
  await payAndFinish(pos);
  await expect.poll(() => prints(pos)).toBe(3); // the bill only
  expect(await ticketsFor('Cutting Chai')).toEqual([{ station: first!.name, quantity: 2, print_count: 1 }]);

  // The settings offer exactly this: KOT prints, or does not; the bill prints by itself, or on Print.
  await office.getByRole('link', { name: 'Billing & GST' }).click();
  const kotSetting = office.getByLabel('Print kitchen tickets (KOT)');
  await expect(kotSetting.locator('option:checked')).toHaveText('When KOT is pressed');
  await expect(kotSetting.locator('option')).toHaveText(['When KOT is pressed', "Don't print (kitchen display only)"]);
  const billSetting = office.getByLabel('Print the bill');
  await expect(billSetting.locator('option:checked')).toHaveText('Automatically when paid in full');
  await expect(billSetting.locator('option')).toHaveText(['Automatically when paid in full', 'Only when Print is pressed']);

  // "Don't print": KOT sends to the kitchen display without printing.
  await kotSetting.selectOption({ label: "Don't print (kitchen display only)" });
  await office.getByRole('button', { name: 'Save changes' }).click();
  await expect(office.getByText('Billing settings saved')).toBeVisible();
  await pos.reload();
  await expect(pos.getByLabel('Search items')).toBeVisible();
  await addByCode(pos, '3 CCH');
  await pos.getByRole('button', { name: 'KOT', exact: true }).click();
  await expect.poll(async () => (await ticketsFor('Cutting Chai')).length).toBe(2);
  expect((await ticketsFor('Cutting Chai')).at(-1)).toEqual({ station: first!.name, quantity: 3, print_count: 0 });
  expect(await prints(pos)).toBe(0);

  // Back to the default for the tests that follow.
  await kotSetting.selectOption({ label: 'When KOT is pressed' });
  await office.getByRole('button', { name: 'Save changes' }).click();
  await expect(office.getByText('Billing settings saved').last()).toBeVisible();
});
