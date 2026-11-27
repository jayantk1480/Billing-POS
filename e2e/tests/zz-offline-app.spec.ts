import { type BrowserContext, expect, type Page, request, test } from '@playwright/test';
import { API_URL, CASHIER, OWNER, POS_PROD_URL } from '../support/env.js';
import { clearRateLimits } from '../support/helpers.js';

/**
 * Billing offline, step 1: the POS, built as in production, opens without the internet as the person last signed in
 * on the device, with the menu it last had, and carries on by itself once the server is back.
 */
test.describe.configure({ mode: 'serial' });
test.use({ baseURL: POS_PROD_URL });
test.beforeEach(clearRateLimits);

/** The owner's access to the API, for setting up and checking what the device did. */
async function ownerApi() {
  const api = await request.newContext({ baseURL: API_URL });
  const login = await (await api.post('/api/v1/auth/login', { data: { email: OWNER.email, password: OWNER.password, client: 'web' } })).json();
  return { api, headers: { Authorization: `Bearer ${login.accessToken}` } };
}

// Earlier tests change billing settings; these tests state the ones they rely on.
test.beforeAll(async () => {
  const { api, headers } = await ownerApi();
  const settings = await api.patch('/api/v1/settings', {
    headers, data: { roundOffMode: 'NEAREST_RUPEE', pricesIncludeTax: false, registerRequired: false, dayCutoffMinutes: 0, discountCapBps: 1000 },
  });
  expect(settings.ok()).toBe(true);
  await api.dispose();
});

const item = (page: Page, name: string) => page.getByRole('list', { name: 'Items', exact: true }).getByRole('button', { name: new RegExp(name) });
const total = (page: Page) => page.getByTestId('cart-total');
const order = (page: Page) => page.getByRole('complementary', { name: 'Current order' });

const items = (page: Page) => page.getByRole('list', { name: 'Items', exact: true }).getByRole('button');
const offlineNotice = (page: Page) => page.getByText(/Offline: the server cannot be reached/);

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

/** Waits until the service worker has kept the app and controls the page. */
async function appKept(page: Page) {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 30_000 });
}

/** Cuts the browser off the network, as when the restaurant's internet goes down, and checks that it is cut off. */
async function goOffline(context: BrowserContext, page: Page) {
  await context.setOffline(true);
  // Even the service worker cannot fetch: a file it does not keep fails, rather than coming from the server.
  expect(await page.evaluate(() => fetch('/_next/static/chunks/not-kept.js').then((response) => response.status, () => 'failed'))).toBe('failed');
}

test('opens offline as the person signed in, with the menu it last had, and carries on when the server is back', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page);
  await appKept(page);
  // The device registered with the restaurant and has its own offline series.
  await page.getByRole('button', { name: 'User menu' }).click();
  await expect(page.getByText(/^Device code Z[0-9A-Z]{2}$/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(items(page).first()).toBeVisible();
  const menu = await items(page).allTextContents();
  await expect(offlineNotice(page)).toBeHidden();

  await goOffline(context, page);
  await page.reload();
  await expect(page.getByLabel('Search items')).toBeVisible();
  await expect(offlineNotice(page)).toBeVisible();
  await expect(page.getByText(/Showing the menu saved/)).toBeVisible();
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  expect(await items(page).allTextContents()).toEqual(menu);
  // Signing out or locking now would leave nobody able to sign in until the server is back.
  await page.getByRole('button', { name: 'User menu' }).click();
  await expect(page.getByRole('button', { name: /Sign out/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Lock terminal/ })).toBeDisabled();
  await page.keyboard.press('Escape');

  await context.setOffline(false);
  await expect(offlineNotice(page)).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText(/Showing the menu saved/)).toBeHidden();
  await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 20_000 });
  // The sign-in is confirmed with the server: signing out works again, and does sign out.
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('button', { name: /Sign out/ }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to bill' })).toBeVisible();
  await context.close();
});

test('with nobody signed in on the device, it says the server cannot be reached, and moves on when it can', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page);
  await appKept(page);
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('button', { name: /Sign out/ }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to bill' })).toBeVisible();

  await goOffline(context, page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Cannot reach the server' })).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Cannot reach the server' })).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByRole('heading', { name: 'Sign in to bill' })).toBeVisible({ timeout: 20_000 });
  await context.close();
});

test('warns when the device clock is wrong, since bills made offline take their time from it', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(Date.now() + 20 * 60_000));
  await signIn(page);
  await expect(page.getByText(/This device's clock is 20 minutes ahead/)).toBeVisible();
  await context.close();
});

test('bills offline: the KOT and the bill are made and printed on the device, and reach the server once it is back', async ({ browser }) => {
  const context = await browser.newContext();
  // There is no printer in a test: the browser's print dialog finishes at once.
  await context.addInitScript(() => {
    window.print = () => window.dispatchEvent(new Event('afterprint'));
  });
  const page = await context.newPage();
  await signIn(page);
  await appKept(page);
  await page.getByRole('button', { name: 'User menu' }).click();
  const code = (await page.getByText(/^Device code Z[0-9A-Z]{2}$/).textContent())!.replace('Device code ', '');
  await page.keyboard.press('Escape');

  // The internet goes, and the till is even reloaded.
  await goOffline(context, page);
  await page.reload();
  await expect(offlineNotice(page)).toContainText('billed on this device');
  await page.getByRole('navigation', { name: 'Categories' }).getByRole('button', { name: 'All items' }).click();
  await item(page, 'Dal Makhani').click();
  await item(page, 'Jeera Rice').click();
  await expect(total(page)).toHaveText('₹420.00');

  // What needs the internet says so.
  await page.getByRole('radio', { name: 'Dine-in' }).click();
  await expect(page.getByText(/Tables need the internet/)).toBeVisible();

  // The KOT is numbered and printed on the device.
  await page.getByRole('button', { name: 'KOT', exact: true }).click();
  await expect(page.getByText(/sent to .*from this device/)).toBeVisible();
  await expect(order(page)).toContainText(`Order ${code}-`);
  await expect(order(page).getByText('Sent').first()).toBeVisible();
  // Something the kitchen already has cannot be taken off until the connection is back.
  await order(page).getByRole('button', { name: 'Remove Jeera Rice' }).click();
  await expect(page.getByText(/already sent to the kitchen. Cancelling it needs the internet/)).toBeVisible();
  await expect(total(page)).toHaveText('₹420.00');

  // The bill is worked out, numbered in the device's series, and paid on the device.
  await page.getByRole('button', { name: /Bill & pay/ }).click();
  const pay = page.getByRole('dialog', { name: /Take payment/ });
  await expect(pay).toContainText('₹420.00');
  const billNumber = (await pay.textContent())!.match(new RegExp(`${code}/\\d{4}/\\d{6}`))![0];
  await pay.getByLabel('Cash received').fill('500');
  await pay.getByRole('button', { name: 'Complete payment' }).click();
  const done = page.getByRole('dialog', { name: 'Payment complete' });
  await expect(done).toContainText('Return change: ₹80.00');
  await done.getByRole('button', { name: 'New order' }).click();
  await expect(page.getByText(/\d+ to upload/)).toBeVisible();

  // A second sale, with an option and a 10% discount (the cashier's limit), paid by UPI: the next number.
  await item(page, 'Paneer Tikka').click();
  await page.getByRole('dialog', { name: 'Paneer Tikka' }).getByRole('checkbox', { name: /Spicy/ }).click();
  await page.getByRole('dialog', { name: 'Paneer Tikka' }).getByRole('button', { name: /^Add/ }).click();
  await item(page, 'Masala Tea').click();
  await page.getByRole('button', { name: 'Discount' }).click();
  const discount = page.getByRole('dialog', { name: 'Bill discount' });
  await discount.getByLabel('Discount percent').fill('10');
  await discount.getByLabel('Reason').fill('Regular guest');
  await discount.getByRole('button', { name: 'Apply' }).click();
  await page.getByRole('button', { name: /Bill & pay/ }).click();
  const second = page.getByRole('dialog', { name: /Take payment/ });
  const secondNumber = (await second.textContent())!.match(new RegExp(`${code}/\\d{4}/\\d{6}`))![0];
  expect(Number(secondNumber.slice(-6))).toBe(Number(billNumber.slice(-6)) + 1);
  await second.getByRole('radio', { name: 'UPI' }).click();
  await second.getByRole('button', { name: 'Complete payment' }).click();
  await page.getByRole('dialog', { name: 'Payment complete' }).getByRole('button', { name: 'New order' }).click();

  // It is kept on the device, to print again.
  await page.getByRole('button', { name: "Today's bills" }).click();
  const madeHere = page.getByRole('region', { name: 'Made offline on this device' });
  await expect(madeHere).toContainText(billNumber);
  await expect(madeHere).toContainText('Paid');
  await page.keyboard.press('Escape');

  // Back online, everything goes up by itself.
  await context.setOffline(false);
  await expect(page.getByText(/\d+ to upload/)).toBeHidden({ timeout: 30_000 });

  // The server has the bill as printed, paid, under the device's number, with nothing to check.
  const { api, headers } = await ownerApi();
  const found = await (await api.get(`/api/v1/invoices?search=${encodeURIComponent(billNumber)}`, { headers })).json();
  expect(found.items).toHaveLength(1);
  expect(found.items[0]).toMatchObject({ invoiceNumber: billNumber, totalPaise: 42000, paidPaise: 42000, paymentStatus: 'PAID' });
  const sold = await (await api.get(`/api/v1/orders/${found.items[0].orderId}`, { headers })).json();
  expect(sold).toMatchObject({ status: 'SETTLED', displayNumber: expect.stringMatching(new RegExp(`^${code}-`)) });
  const discounted = (await (await api.get(`/api/v1/invoices?search=${encodeURIComponent(secondNumber)}`, { headers })).json()).items[0];
  expect(discounted).toMatchObject({ paymentStatus: 'PAID' });
  // The server worked every bill out again from its lines and found nothing to point out, nor anything to refuse.
  const reviews = await (await api.get('/api/v1/sync/reviews?status=all&pageSize=200', { headers })).json();
  expect(JSON.stringify(reviews.items)).not.toContain(`"deviceCode":"${code}"`);
  await api.dispose();
  await context.close();
});
