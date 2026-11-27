import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { API_URL, CASHIER, OWNER, POS_URL } from '../support/env.js';
import { clearRateLimits } from '../support/helpers.js';

/**
 * Every device at an outlet shares one address, and the API allows 600 requests a minute per address.
 * This measures what one bill on one terminal costs the other screens that are just sitting there.
 */
async function openPos(context: BrowserContext, account: { email: string; password: string }): Promise<Page> {
  const page = await context.newPage();
  await page.goto(POS_URL);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const terminal = page.getByRole('button', { name: /Counter 1/ });
  await expect(terminal.or(page.getByLabel('Search items'))).toBeVisible();
  if (await terminal.isVisible()) await terminal.click();
  await expect(page.getByLabel('Search items')).toBeVisible();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  return page;
}

test('what one bill costs the screens that are idle', async ({ browser }) => {
  await clearRateLimits();
  const biller = await openPos(await browser.newContext(), CASHIER);
  const idle = [await openPos(await browser.newContext(), OWNER), await openPos(await browser.newContext(), CASHIER)];
  await biller.waitForLoadState('networkidle');
  for (const page of idle) await page.waitForLoadState('networkidle');

  const counts = idle.map(() => ({ requests: 0, bytes: 0, paths: new Map<string, number>() }));
  idle.forEach((page, i) => page.on('requestfinished', async (request) => {
    if (!request.url().startsWith(API_URL)) return;
    const path = new URL(request.url()).pathname.replace(/[0-9a-f-]{36}/g, ':id');
    counts[i]!.requests += 1;
    counts[i]!.paths.set(path, (counts[i]!.paths.get(path) ?? 0) + 1);
    counts[i]!.bytes += (await request.sizes().catch(() => ({ responseBodySize: 0 }))).responseBodySize;
  }));
  let own = 0;
  biller.on('requestfinished', (request) => { if (request.url().startsWith(API_URL)) own += 1; });

  await biller.getByRole('list', { name: 'Items', exact: true }).getByRole('button', { name: /Masala Tea/ }).first().click();
  await biller.getByRole('button', { name: 'KOT', exact: true }).click();
  await expect(biller.getByText(/sent to|Nothing new/)).toBeVisible();
  await biller.getByRole('button', { name: /Bill & pay/ }).click();
  const pay = biller.getByRole('dialog', { name: /Take payment/ });
  await pay.getByRole('button', { name: 'Complete payment' }).click();
  await biller.getByRole('dialog', { name: 'Payment complete' }).getByRole('button', { name: 'New order' }).click();
  // Let the other screens finish reacting.
  await biller.waitForTimeout(3000);

  const summary = {
    billerRequests: own,
    idleScreens: counts.map((c) => ({ requests: c.requests, kb: Math.round(c.bytes / 1024), paths: Object.fromEntries(c.paths) })),
  };
  console.log('TRAFFIC ' + JSON.stringify(summary));
  test.info().annotations.push({ type: 'traffic', description: JSON.stringify(summary) });
  // Measured on 2026-11-24: 49 requests on the billing screen and 30 on each idle screen before notices were
  // grouped; 22 and 6 after. The margins leave room for a slower machine splitting a burst in two.
  expect(own).toBeLessThanOrEqual(30);
  for (const screen of counts) expect(screen.requests).toBeLessThanOrEqual(10);
});
