import { type AddressInfo, createServer, type Server } from 'node:net';
import { type APIRequestContext, expect, type Page, request, test } from '@playwright/test';
import { createBridge } from '../../apps/print-bridge/src/bridge.js';
import { API_URL, CASHIER, OWNER, POS_URL, WEB_URL } from '../support/env.js';
import { clearRateLimits, signIn as signInWeb } from '../support/helpers.js';

// Named to run after the other files: the sales tests check the day's exact totals, and these tests bill more orders.
test.describe.configure({ mode: 'serial' });
test.use({ baseURL: POS_URL });
test.beforeEach(clearRateLimits);
// Counts what goes to the browser's print dialog, so a test can tell it from what went to a real printer.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const counter = window as unknown as { browserPrints: number };
    counter.browserPrints = 0;
    window.print = () => {
      counter.browserPrints += 1;
      window.dispatchEvent(new Event('afterprint'));
    };
  });
});

const item = (page: Page, name: string) => page.getByRole('list', { name: 'Items', exact: true }).getByRole('button', { name: new RegExp(name) });
const order = (page: Page) => page.getByRole('complementary', { name: 'Current order' });

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(CASHIER.email);
  await page.getByLabel('Password').fill(CASHIER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const terminal = page.getByRole('button', { name: /Counter 1/ });
  await expect(terminal.or(page.getByLabel('Search items'))).toBeVisible();
  if (await terminal.isVisible()) await terminal.click();
  await expect(page.getByLabel('Search items')).toBeVisible();
  await page.getByRole('navigation', { name: 'Categories' }).getByRole('button', { name: 'All items' }).click();
}

async function openRegisterDialog(page: Page) {
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('button', { name: /Cash register/ }).click();
}

/** The owner's API access, for setting up printers the way the back office would. */
async function ownerApi(): Promise<{ api: APIRequestContext; headers: { Authorization: string } }> {
  const api = await request.newContext({ baseURL: API_URL });
  const login = await api.post('/api/v1/auth/login', { data: { email: OWNER.email, password: OWNER.password, client: 'web' } });
  return { api, headers: { Authorization: 'Bearer ' + (await login.json()).accessToken } };
}

/** A network thermal printer: keeps the text of everything sent to its port. */
async function printerEmulator() {
  const printed: string[] = [];
  const server: Server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => printed.push(Buffer.concat(chunks).toString('latin1')));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { printed, port: (server.address() as AddressInfo).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('open the cash register, take cash, pay a supplier with a manager PIN, and close against a count', async ({ page }) => {
  await signIn(page);
  await openRegisterDialog(page);
  const opening = page.getByRole('dialog', { name: 'Open cash register' });
  await expect(opening.getByRole('button', { name: 'Open register' })).toBeDisabled();
  await opening.getByLabel('Cash in the drawer now').fill('1000');
  await opening.getByRole('button', { name: 'Open register' }).click();
  await expect(page.getByText('Cash register opened with ₹1,000.00')).toBeVisible();

  // A tea paid in cash: 40 plus 5% GST.
  await item(page, 'Masala Tea').click();
  await page.getByRole('button', { name: /Bill & pay/ }).click();
  const pay = page.getByRole('dialog', { name: /Take payment/ });
  await expect(pay).toContainText('₹42.00');
  await pay.getByRole('button', { name: 'Complete payment' }).click();
  await page.getByRole('dialog', { name: 'Payment complete' }).getByRole('button', { name: 'New order' }).click();

  // And one paid by UPI, which is taken on this register but is not in the drawer.
  await item(page, 'Masala Tea').click();
  await page.getByRole('button', { name: /Bill & pay/ }).click();
  await pay.getByRole('radio', { name: 'UPI' }).click();
  await pay.getByRole('button', { name: 'Complete payment' }).click();
  await page.getByRole('dialog', { name: 'Payment complete' }).getByRole('button', { name: 'New order' }).click();

  await openRegisterDialog(page);
  const register = page.getByRole('dialog', { name: 'Cash register', exact: true });
  const drawer = register.getByLabel('Cash in the drawer');
  await expect(drawer).toContainText('Opening cash₹1,000.00');
  await expect(drawer).toContainText('Cash sales₹42.00');
  await expect(drawer).toContainText('Should be in the drawer₹1,042.00');
  await expect(register.getByLabel('Taken while this register was open')).toContainText('Cash · 1 payment');
  await expect(register.getByLabel('Taken while this register was open')).toContainText('UPI · 1 payment');

  // Taking cash out is a manager's call.
  await register.getByRole('button', { name: 'Cash out' }).click();
  const out = page.getByRole('dialog', { name: 'Take cash out' });
  await out.getByLabel('Amount').fill('5000');
  await expect(out.getByText('Only ₹1,042.00 should be in the drawer.')).toBeVisible();
  await expect(out.getByRole('button', { name: 'Take out' })).toBeDisabled();
  await out.getByLabel('Amount').fill('200');
  await out.getByLabel('Reason').fill('Paid the milk supplier');
  await out.getByRole('button', { name: 'Take out' }).click();
  const approval = page.getByRole('dialog', { name: 'Manager approval' });
  await approval.getByLabel('Approving manager').selectOption({ label: 'Owner (Owner)' });
  await approval.getByLabel('Manager PIN').fill(OWNER.pin);
  await approval.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('₹200.00 taken out of the register')).toBeVisible();
  await expect(drawer).toContainText('Cash taken out− ₹200.00');
  await expect(drawer).toContainText('Should be in the drawer₹842.00');
  await expect(register.getByLabel('Cash put in and taken out')).toContainText('Paid the milk supplier');

  // Count the drawer: one ₹500, three ₹100, two ₹20 = ₹840, two rupees short.
  await register.getByRole('button', { name: 'Close register' }).click();
  const closing = page.getByRole('dialog', { name: 'Close cash register' });
  await closing.getByLabel('Number of ₹500').fill('1');
  await closing.getByLabel('Number of ₹100').fill('3');
  await closing.getByLabel('Number of ₹20', { exact: true }).fill('2');
  await expect(closing.getByTestId('counted-total')).toHaveText('₹840.00');
  await closing.getByLabel('Notes (optional)').fill('Two rupees short');
  await closing.getByRole('button', { name: 'Close register' }).click();

  const closed = page.getByRole('dialog', { name: 'Cash register closed' });
  await expect(closed.getByTestId('register-difference')).toHaveText('Short ₹2.00');
  await expect(closed).toContainText('Should be in the drawer₹842.00');
  await expect(closed).toContainText('Counted₹840.00');
  await closed.getByRole('button', { name: 'Done' }).click();

  // The register is closed for good; the next one starts from a fresh count.
  await page.getByRole('button', { name: 'User menu' }).click();
  await expect(page.getByRole('button', { name: /Cash register/ })).toContainText('Closed');
  await page.getByRole('button', { name: /Cash register/ }).click();
  await expect(page.getByRole('dialog', { name: 'Open cash register' })).toBeVisible();
});

test('cash is refused until the register is open, when the restaurant requires one', async ({ page }) => {
  const { api, headers } = await ownerApi();
  expect((await api.patch('/api/v1/settings', { headers, data: { registerRequired: true } })).ok()).toBe(true);
  try {
    await signIn(page);
    await expect(page.getByRole('button', { name: 'Cash register is closed. Open it.' })).toBeVisible();
    await item(page, 'Masala Tea').click();
    await page.getByRole('button', { name: /Bill & pay/ }).click();
    const pay = page.getByRole('dialog', { name: /Take payment/ });
    await pay.getByRole('button', { name: 'Complete payment' }).click();
    await expect(page.getByText('Open your cash register before taking cash.')).toBeVisible();

    // The register comes up by itself; once it is open the same payment goes through.
    const opening = page.getByRole('dialog', { name: 'Open cash register' });
    await opening.getByLabel('Cash in the drawer now').fill('0');
    await opening.getByRole('button', { name: 'Open register' }).click();
    await expect(opening).toBeHidden();
    await pay.getByRole('button', { name: 'Complete payment' }).click();
    await expect(page.getByRole('dialog', { name: 'Payment complete' })).toContainText('₹42.00');
    await page.getByRole('dialog', { name: 'Payment complete' }).getByRole('button', { name: 'New order' }).click();
    await expect(page.getByRole('button', { name: 'Cash register is closed. Open it.' })).toBeHidden();
  } finally {
    // Later tests take cash without a register.
    await api.patch('/api/v1/settings', { headers, data: { registerRequired: false } });
    const open = await (await api.get('/api/v1/registers?status=OPEN', { headers })).json();
    for (const session of open.items as { id: string; expectedCashPaise: number }[]) {
      await api.post('/api/v1/registers/' + session.id + '/close', { headers, data: { countedCashPaise: session.expectedCashPaise } });
    }
    await api.dispose();
  }
});

test('bills and kitchen tickets print on thermal printers through the bridge, and a dead printer is reported', async ({ page }) => {
  test.setTimeout(120_000);
  const { api, headers } = await ownerApi();
  const counter = await printerEmulator();
  const kitchen = await printerEmulator();
  const made: string[] = [];
  const post = async (path: string, data: object) => {
    const response = await api.post('/api/v1' + path, { headers, data });
    expect(response.ok(), path + ' ' + (await response.text())).toBe(true);
    return response.json();
  };
  const stop = new AbortController();
  let bridgeId = '';
  try {
    // This test relies on tickets and bills printing by themselves.
    await api.patch('/api/v1/settings', { headers, data: { autoPrintKot: true, autoPrintReceipt: true } });
    made.push((await post('/printers', { name: 'Counter', role: 'RECEIPT', connection: 'NETWORK', host: '127.0.0.1', port: counter.port })).id);
    made.push((await post('/printers', { name: 'Kitchen', role: 'KOT', connection: 'NETWORK', host: '127.0.0.1', port: kitchen.port, paperWidth: 'MM58' })).id);
    const paired = await post('/print-bridges', { name: 'Counter PC' });
    bridgeId = paired.id;
    // The real bridge program, run here instead of on a counter computer.
    // The emulators listen on whatever port is free, so this bridge is told any port may be a printer.
    const bridge = createBridge({ apiUrl: API_URL, token: paired.token, version: 'e2e', pollMs: 250, limits: { anyPort: true } });
    void bridge.run(stop.signal);
    await expect.poll(async () => (await (await api.get('/api/v1/printing/status', { headers })).json()).bridgeOnline).toBe(true);

    await signIn(page);
    await item(page, 'Dal Makhani').click();
    await item(page, 'Dal Makhani').click();
    await order(page).getByRole('button', { name: 'KOT', exact: true }).click();
    await expect(page.getByText(/sent to Main Kitchen/)).toBeVisible();
    // The ticket comes out in the kitchen, on its narrow paper, and the browser's print dialog is left alone.
    await expect.poll(() => kitchen.printed.length).toBe(1);
    expect(kitchen.printed[0]).toContain('MAIN KITCHEN');
    expect(kitchen.printed[0]).toContain('2 x Dal Makhani');
    expect(kitchen.printed[0]).toContain('-'.repeat(32) + '\n');
    expect(kitchen.printed[0]).not.toContain('-'.repeat(33));
    expect(await page.evaluate(() => (window as unknown as { browserPrints: number }).browserPrints)).toBe(0);

    await page.getByRole('button', { name: /Bill & pay/ }).click();
    const pay = page.getByRole('dialog', { name: /Take payment/ });
    await pay.getByRole('button', { name: 'Complete payment' }).click();
    const done = page.getByRole('dialog', { name: 'Payment complete' });
    // Paid in full, so the bill prints by itself: through the bridge, with no browser dialog.
    await expect(page.getByText(/Bill A1\/\d{4}\/\d{6} sent to Counter/)).toBeVisible();
    await expect.poll(() => counter.printed.length).toBe(1);
    const receipt = counter.printed[0]!;
    expect(receipt).toContain('TAX INVOICE');
    expect(receipt).toMatch(/Dal Makhani\s+2\s+240\.00\s+480\.00/);
    expect(receipt).toMatch(/TOTAL\s+Rs\.504\.00/);
    expect(receipt).toMatch(/Paid by Cash\s+504\.00/);
    // Paid in cash, so the drawer is kicked open; the paper is cut at the end.
    expect(receipt).toContain('\x1bp\x00\x19\xfa');
    expect(receipt.endsWith('\x1dVB\x00')).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { browserPrints: number }).browserPrints)).toBe(0);

    // The printer is switched off: after three tries the cashier is told, with the reason.
    await counter.close();
    await done.getByRole('button', { name: /Print receipt/ }).click();
    await expect(page.getByText(/Bill A1\/\d{4}\/\d{6} did not print on Counter\. The printer refused the connection/)).toBeVisible({ timeout: 45_000 });
    await done.getByRole('button', { name: 'New order' }).click();

    // With the bridge gone, printing falls back to the browser's print dialog.
    stop.abort();
    await api.delete('/api/v1/print-bridges/' + bridgeId, { headers });
    bridgeId = '';
    await page.getByRole('button', { name: "Today's bills" }).click();
    const bills = page.getByRole('dialog', { name: "Today's bills" });
    await bills.getByRole('listitem').first().click();
    await page.getByRole('button', { name: 'Reprint' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { browserPrints: number }).browserPrints)).toBe(1);
  } finally {
    stop.abort();
    if (bridgeId) await api.delete('/api/v1/print-bridges/' + bridgeId, { headers });
    for (const id of made) await api.delete('/api/v1/printers/' + id, { headers });
    await api.dispose();
    await counter.close().catch(() => undefined);
    await kitchen.close();
  }
});

test.describe('in the back office', () => {
  test.use({ baseURL: WEB_URL });

  test('the owner sees every cash register, opens one up, and closes a register left open', async ({ page }) => {
    // A cashier leaves a register open with ₹300 in it.
    const pos = await request.newContext({ baseURL: API_URL });
    const login = await pos.post('/api/v1/auth/login', { data: { email: CASHIER.email, password: CASHIER.password, client: 'pos' } });
    const cashier = { Authorization: 'Bearer ' + (await login.json()).accessToken };
    expect((await pos.post('/api/v1/registers/open', { headers: cashier, data: { openingCashPaise: 30_000 } })).ok()).toBe(true);
    await pos.dispose();

    await signInWeb(page, OWNER);
    await page.getByRole('link', { name: 'Cash registers', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Cash registers' })).toBeVisible();
    // The register closed two rupees short on the billing screen, and the one that is still open.
    const short = page.getByRole('row').filter({ hasText: 'Short ₹2.00' });
    await expect(short).toContainText('Cashier');
    await expect(short).toContainText('₹842.00');
    await expect(short).toContainText('₹840.00');
    await expect(short).toContainText('Closed');

    await short.getByRole('button', { name: /View/ }).click();
    const detail = page.getByRole('dialog', { name: 'Cash register · Cashier' });
    await expect(detail).toContainText('Paid the milk supplier');
    await expect(detail).toContainText('Two rupees short');
    await expect(detail.getByLabel('Takings by payment method')).toContainText('UPI');
    await expect(detail.getByLabel('Notes and coins counted')).toContainText('₹500');
    await expect(detail.getByRole('button', { name: 'Close register' })).toBeHidden();
    await page.keyboard.press('Escape');

    await page.getByLabel('Filter by status').selectOption({ label: 'Open' });
    const open = page.getByRole('row').filter({ hasText: '₹300.00' });
    await expect(open).toHaveCount(1);
    await open.getByRole('button', { name: /View/ }).click();
    await detail.getByRole('button', { name: 'Close register' }).click();
    await detail.getByRole('radio', { name: /total/i }).click();
    await detail.getByRole('textbox', { name: 'Cash counted' }).fill('310');
    await detail.getByRole('textbox', { name: 'Notes' }).fill('Cashier went home');
    await detail.getByRole('button', { name: 'Close register' }).click();
    await expect(page.getByText('Register closed. Over ₹10.00.')).toBeVisible();
    await expect(detail).toContainText('Closed by Owner');
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();

    // The dashboard lists registers that are open right now: none any more.
    await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
    await expect(page.getByText('No register is open')).toBeVisible();
  });

  test('the owner checks the day\'s UPI against the bank and records the difference', async ({ page }) => {
    await signInWeb(page, OWNER);
    await page.getByRole('link', { name: 'Reconciliation', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Reconciliation' })).toBeVisible();
    await expect(page.getByLabel('Cash for these dates')).toBeVisible();

    const upi = page.getByRole('row').filter({ hasText: 'UPI' }).first();
    await expect(upi).toContainText('Not checked');
    await upi.getByRole('button', { name: /Enter settled amount for UPI/ }).click();
    const settle = page.getByRole('dialog', { name: /Settled amount: UPI on/ });
    // The box starts at what the system recorded; the bank shows five rupees less.
    const recorded = Number(await settle.getByLabel('Settled amount').inputValue());
    expect(recorded).toBeGreaterThan(0);
    await settle.getByLabel('Settled amount').fill(String(recorded - 5));
    await settle.getByLabel('Note').fill('Bank charges');
    await settle.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/Saved\. UPI on .*: Short ₹5\.00\./)).toBeVisible();
    await expect(upi).toContainText('Short ₹5.00');
    await expect(upi).toContainText('Bank charges');

    // The payments behind the figure.
    await upi.getByRole('button', { name: /Show the \d+ / }).click();
    const payments = page.getByRole('dialog', { name: /Payments: UPI on/ });
    await expect(payments.getByRole('row').nth(1)).toContainText(/A1\/\d{4}\/\d{6}/);
    await page.keyboard.press('Escape');

    await upi.getByRole('button', { name: /Clear settled amount for UPI/ }).click();
    await page.getByRole('dialog', { name: 'Clear settled amount' }).getByRole('button').last().click();
    await expect(page.getByText(/Settled amount removed for UPI on/)).toBeVisible();
    await expect(upi).toContainText('Not checked');
  });

  test('the owner sets up a print bridge, a printer and what is printed', async ({ page }) => {
    await signInWeb(page, OWNER);
    await page.getByRole('link', { name: 'Printers', exact: true }).click();
    await expect(page.getByText('No print bridge yet')).toBeVisible();
    await expect(page.getByText('No printers yet')).toBeVisible();

    await page.getByRole('button', { name: 'Add print bridge' }).first().click();
    const adding = page.getByRole('dialog', { name: 'Add print bridge' });
    await adding.getByLabel('Name', { exact: true }).fill('Counter computer');
    await adding.getByRole('button', { name: 'Add print bridge' }).click();
    // The token is shown this once.
    const added = page.getByRole('dialog', { name: 'Counter computer added' });
    await expect(added.getByLabel('Token')).toHaveValue(/^pb_[\w-]{40,}$/);
    await expect(added).toContainText('PRINT_BRIDGE_TOKEN');
    await added.getByRole('button', { name: 'I have saved the token' }).click();
    await expect(page.getByText('Not connected', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Token')).toHaveCount(0);

    await page.getByRole('button', { name: 'Add printer' }).first().click();
    const printer = page.getByRole('dialog', { name: 'Add printer' });
    await printer.getByLabel('Name', { exact: true }).fill('Kitchen printer');
    await printer.getByLabel('Used for').selectOption({ label: 'Kitchen tickets' });
    await printer.getByLabel('Paper width').selectOption({ label: '58 mm' });
    // A network printer needs an address.
    await printer.getByRole('button', { name: 'Add printer' }).click();
    await expect(printer.getByText('Enter the IP address of the printer')).toBeVisible();
    await printer.getByLabel('IP address or host name').fill('192.168.1.60');
    await printer.getByRole('button', { name: 'Add printer' }).click();
    await expect(page.getByText('Printer added', { exact: true })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: 'Kitchen printer' });
    await expect(row).toContainText('Kitchen tickets');
    await expect(row).toContainText('192.168.1.60');
    await expect(row).toContainText('58 mm');

    // Nothing is connected, so a test page cannot print, and the page says why.
    await row.getByRole('button', { name: 'Print a test page on Kitchen printer' }).click();
    await expect(page.getByText(/The print bridge is not connected/)).toBeVisible();

    await page.getByLabel('Line under the restaurant name').fill('Pure veg since 1998');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Print layouts saved', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Line under the restaurant name')).toHaveValue('Pure veg since 1998');

    // A kitchen station can be sent to this printer.
    await page.getByRole('link', { name: 'Kitchen stations', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Tandoor' }).click();
    const station = page.getByRole('dialog', { name: 'Edit kitchen station' });
    await station.getByLabel('Printer', { exact: true }).selectOption({ label: 'Kitchen printer' });
    await station.getByRole('button', { name: /Save/ }).click();
    await expect(page.getByText('prints on Kitchen printer')).toBeVisible();

    // Clean up, so the rest of the suite prints through the browser as before.
    await page.getByRole('link', { name: 'Printers', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Kitchen printer' })).toContainText('Tandoor');
    await page.getByRole('button', { name: 'Delete Kitchen printer' }).click();
    await page.getByRole('dialog', { name: 'Delete printer' }).getByRole('button').last().click();
    await expect(page.getByText('Kitchen printer deleted')).toBeVisible();
    await page.getByRole('button', { name: 'Remove Counter computer' }).click();
    await page.getByRole('dialog', { name: 'Remove print bridge' }).getByRole('button').last().click();
    await expect(page.getByText('Counter computer removed')).toBeVisible();
    await expect(page.getByText('No print bridge yet')).toBeVisible();
  });
});

test.describe('a billed order that is not paid', () => {
  async function approve(page: Page) {
    const approval = page.getByRole('dialog', { name: 'Manager approval' });
    await approval.getByLabel('Approving manager').selectOption({ label: 'Owner (Owner)' });
    await approval.getByLabel('Manager PIN').fill(OWNER.pin);
    await approval.getByRole('button', { name: 'Approve' }).click();
  }

  test('can be changed or dropped from Running orders, with a reason and a manager PIN', async ({ page }) => {
    await signIn(page);
    await item(page, 'Masala Tea').click();
    await page.getByRole('button', { name: /Bill & pay/ }).click();
    await page.getByRole('dialog', { name: /Take payment/ }).getByRole('button', { name: 'Pay later' }).click();

    // The guest wants one more: the bill is cancelled and the order comes back on screen.
    await page.getByRole('button', { name: 'Running orders' }).click();
    const running = page.getByRole('dialog', { name: 'Running orders' });
    const waiting = running.getByRole('listitem').filter({ hasText: 'Awaiting payment' }).filter({ hasText: '₹42.00' });
    await expect(waiting).toHaveCount(1);
    await waiting.getByRole('button', { name: 'Change order' }).click();
    const change = page.getByRole('dialog', { name: /^Change order A1-\d+/ });
    await expect(change.getByRole('button', { name: 'Cancel bill and reopen' })).toBeDisabled();
    await change.getByLabel('Reason').fill('Guest wants one more tea');
    await change.getByRole('button', { name: 'Cancel bill and reopen' }).click();
    await approve(page);
    await expect(page.getByText(/Order A1-\d+ is open again/)).toBeVisible();
    await expect(running).toBeHidden();
    await expect(order(page).getByLabel('Quantity of Masala Tea')).toHaveText('1');

    await order(page).getByRole('button', { name: 'One more Masala Tea' }).click();
    await page.getByRole('button', { name: /Bill & pay/ }).click();
    const pay = page.getByRole('dialog', { name: /Take payment/ });
    await expect(pay).toContainText('₹84.00');
    await pay.getByRole('button', { name: 'Pay later' }).click();

    // The guest leaves without paying: the bill is cancelled and the order goes with it.
    await page.getByRole('button', { name: 'Running orders' }).click();
    const unpaid = running.getByRole('listitem').filter({ hasText: '₹84.00' });
    await unpaid.getByRole('button', { name: 'Cancel bill' }).click();
    const cancel = page.getByRole('dialog', { name: /^Cancel bill for order A1-\d+/ });
    await cancel.getByLabel('Reason').fill('Guest left without paying');
    await cancel.getByRole('button', { name: 'Cancel bill' }).click();
    await approve(page);
    await expect(page.getByText(/Order A1-\d+ and its bill are cancelled/)).toBeVisible();
    await expect(unpaid).toHaveCount(0);
    await running.getByRole('button', { name: 'Close' }).last().click();

    // Both bills are still on record, marked cancelled: their numbers are not used again.
    await page.getByRole('button', { name: "Today's bills" }).click();
    const bills = page.getByRole('dialog', { name: "Today's bills" });
    await expect(bills.getByRole('listitem').filter({ hasText: 'Cancelled' }).filter({ hasText: '₹84.00' })).toHaveCount(1);
    await expect(bills.getByRole('listitem').filter({ hasText: 'Cancelled' }).filter({ hasText: '₹42.00' })).toHaveCount(1);
  });
});
