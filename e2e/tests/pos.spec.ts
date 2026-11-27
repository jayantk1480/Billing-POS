import { expect, type Page, request, test } from '@playwright/test';
import { API_URL, CASHIER, OWNER, POS_URL } from '../support/env.js';
import { clearRateLimits } from '../support/helpers.js';

test.describe.configure({ mode: 'serial' });
test.use({ baseURL: POS_URL });
test.beforeEach(clearRateLimits);
// Kitchen tickets print automatically; there is no printer in a test, so printing completes at once.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.print = () => window.dispatchEvent(new Event('afterprint'));
  });
});

// The back-office tests run first and change billing settings; these tests state the settings they rely on.
test.beforeAll(async () => {
  const api = await request.newContext({ baseURL: API_URL });
  const login = await api.post('/api/v1/auth/login', { data: { email: OWNER.email, password: OWNER.password, client: 'web' } });
  const settings = await api.patch('/api/v1/settings', {
    headers: { Authorization: `Bearer ${(await login.json()).accessToken}` },
    data: { orderRenumberMode: 'AUTO', discountCapBps: 1000, dayCutoffMinutes: 0, roundOffMode: 'NEAREST_RUPEE', pricesIncludeTax: false },
  });
  expect(settings.ok()).toBe(true);
  await api.dispose();
});

const item = (page: Page, name: string) => page.getByRole('list', { name: 'Items', exact: true }).getByRole('button', { name: new RegExp(name) });
const total = (page: Page) => page.getByTestId('cart-total');
const order = (page: Page) => page.getByRole('complementary', { name: 'Current order' });

/** Signs in at the counter. The first sign-in on a device also chooses its terminal. */
async function signIn(page: Page, account = CASHIER) {
  await page.goto('/');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const terminal = page.getByRole('button', { name: /Counter 1/ });
  await expect(terminal.or(page.getByLabel('Search items'))).toBeVisible();
  if (await terminal.isVisible()) await terminal.click();
  await expect(page.getByLabel('Search items')).toBeVisible();
  // The screen opens on Favourites; these tests pick from the whole menu.
  await page.getByRole('navigation', { name: 'Categories' }).getByRole('button', { name: 'All items' }).click();
}

async function approveAsOwner(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Manager approval' });
  await dialog.getByLabel('Approving manager').selectOption({ label: 'Owner (Owner)' });
  await dialog.getByLabel('Manager PIN').fill(OWNER.pin);
  await dialog.getByRole('button', { name: 'Approve' }).click();
}

test('choose a terminal, bill a takeaway order and take cash with change', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(CASHIER.email);
  await page.getByLabel('Password').fill(CASHIER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Which terminal is this?' })).toBeVisible();
  await page.getByRole('button', { name: /Counter 1/ }).click();
  await expect(page.getByText('Counter 1 · A1')).toBeVisible();

  // Tap an item twice, pick one with options, and add three by short code.
  await item(page, 'Masala Tea').click();
  await item(page, 'Masala Tea').click();
  await item(page, 'Paneer Tikka').click();
  await page.getByRole('dialog', { name: 'Paneer Tikka' }).getByRole('checkbox', { name: /Spicy/ }).click();
  await page.getByRole('dialog', { name: 'Paneer Tikka' }).getByRole('button', { name: /^Add/ }).click();
  await page.getByLabel('Search items').fill('3 BN');
  await page.getByLabel('Search items').press('Enter');

  await expect(order(page).getByLabel('Quantity of Masala Tea')).toHaveText('2');
  await expect(order(page).getByLabel('Quantity of Butter Naan')).toHaveText('3');
  await expect(order(page)).toContainText('Spicy');
  // 80 + 260 + 165 = 505, plus 5% GST = 530.25, rounded to 530.
  await expect(total(page)).toHaveText('₹530.00');

  await page.getByRole('button', { name: /Bill & pay/ }).click();
  const pay = page.getByRole('dialog', { name: /Take payment/ });
  await expect(pay).toContainText('₹530.00');
  await expect(pay).toContainText(/Bill A1\/\d{4}\/000001/);
  await pay.getByLabel('Cash received').fill('600');
  await expect(pay.getByText('Change ₹70.00')).toBeVisible();
  await pay.getByRole('button', { name: 'Complete payment' }).click();

  const done = page.getByRole('dialog', { name: 'Payment complete' });
  await expect(done).toContainText('Return change: ₹70.00');
  await done.getByRole('button', { name: 'New order' }).click();
  await expect(order(page)).toContainText('New order');
  await expect(total(page)).toHaveText('₹0.00');

  await page.getByRole('button', { name: "Today's bills" }).click();
  const bills = page.getByRole('dialog', { name: "Today's bills" });
  await expect(bills.getByRole('listitem')).toHaveCount(1);
  await expect(bills.getByRole('listitem')).toContainText('₹530.00');
  await expect(bills.getByRole('listitem')).toContainText('Paid');
});

test('a discount above the limit needs a manager PIN; pay by two methods', async ({ page }) => {
  await signIn(page);
  await item(page, 'Dal Makhani').click();
  await item(page, 'Jeera Rice').click(); // 240 + 160 = 400
  await page.getByRole('button', { name: 'Discount' }).click();
  const discount = page.getByRole('dialog', { name: 'Bill discount' });
  await discount.getByLabel('Discount percent').fill('25');
  await discount.getByLabel('Reason').fill('Regular guest');
  await discount.getByRole('button', { name: 'Apply' }).click();
  // 400 − 100 = 300, plus 5% = 315.
  await expect(total(page)).toHaveText('₹315.00');

  await page.getByRole('button', { name: /Bill & pay/ }).click();
  const approval = page.getByRole('dialog', { name: 'Manager approval' });
  await expect(approval).toContainText("Discounts above 10% need a manager's approval");
  await approval.getByLabel('Approving manager').selectOption({ label: 'Owner (Owner)' });
  await approval.getByLabel('Manager PIN').fill('0000');
  await approval.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('dialog', { name: 'Manager approval' })).toContainText('That PIN is not correct');
  await approveAsOwner(page);

  const pay = page.getByRole('dialog', { name: /Take payment/ });
  await expect(pay).toContainText('₹315.00');
  await pay.getByRole('radio', { name: 'UPI' }).click();
  await pay.getByLabel('Amount').fill('200');
  await expect(pay.getByText('₹115.00 will still be due after this.')).toBeVisible();
  await pay.getByRole('button', { name: 'Add another payment' }).click();
  await pay.getByRole('radiogroup', { name: 'Payment method 2' }).getByRole('radio', { name: 'Card' }).click();
  await expect(pay.getByLabel('Amount').nth(1)).toHaveValue('115');
  await pay.getByRole('button', { name: 'Complete payment' }).click();
  await expect(page.getByRole('dialog', { name: 'Payment complete' })).toContainText('₹315.00');
});

test('hold an order, serve a table, then come back to each', async ({ page }) => {
  await signIn(page);
  await item(page, 'Filter Coffee').click();
  await page.getByRole('button', { name: 'Hold' }).click();
  await expect(page.getByText(/Order A1-\d+ is on hold/)).toBeVisible();
  await expect(total(page)).toHaveText('₹0.00');

  // Dine-in: choosing the type asks for a table.
  await page.getByRole('radio', { name: 'Dine-in' }).click();
  await page.getByRole('dialog', { name: 'Choose a table' }).getByRole('button', { name: 'Table T3, Free' }).click();
  await item(page, 'Butter Naan').click();
  await page.getByRole('button', { name: 'KOT', exact: true }).click();
  await expect(page.getByText(/Order A1-\d+ sent to Tandoor/)).toBeVisible();
  await expect(order(page)).toContainText(/Order A1-\d+/);
  await expect(order(page)).toContainText('Table T3');
  await order(page).getByRole('button', { name: 'New', exact: true }).click();

  // The table now shows as occupied; tapping it reopens its order.
  await page.getByRole('radio', { name: 'Dine-in' }).click();
  await page.getByRole('dialog', { name: 'Choose a table' }).getByRole('button', { name: 'Table T3, Occupied' }).click();
  await expect(order(page).getByLabel('Quantity of Butter Naan')).toHaveText('1');
  await order(page).getByRole('button', { name: 'One more Butter Naan' }).click();
  await expect(order(page).getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'KOT', exact: true }).click();
  await expect(order(page).getByText('Unsaved changes')).toHaveCount(0);
  await order(page).getByRole('button', { name: 'New', exact: true }).click();

  // Both are waiting under Running orders; open the held one again.
  await page.getByRole('button', { name: 'Running orders' }).click();
  const running = page.getByRole('dialog', { name: 'Running orders' });
  await expect(running.getByRole('listitem')).toHaveCount(2);
  await expect(running.getByRole('listitem').filter({ hasText: 'Table T3' })).toContainText('₹116.00'); // 2 × 55 + 5%
  await running.getByRole('listitem').filter({ hasText: 'On hold' }).getByRole('button', { name: 'Open' }).click();
  await expect(order(page).getByLabel('Quantity of Filter Coffee')).toHaveText('1');
  await expect(total(page)).toHaveText('₹63.00');
});

test('deleting an unbilled order renumbers the ones after it', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Running orders' }).click();
  const running = page.getByRole('dialog', { name: 'Running orders' });
  // From the previous test: the coffee order and the table order, with consecutive numbers.
  await expect(running.getByRole('listitem')).toHaveCount(2);
  const before = await running.getByRole('listitem').evaluateAll((items) => items.map((li) => Number(/A1-(\d+)/.exec(li.textContent ?? '')?.[1])));
  const [first, second] = before.sort((a, b) => a - b) as [number, number];
  expect(second).toBe(first + 1);

  await running.getByRole('listitem').filter({ hasText: `A1-${first}` }).getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: new RegExp(`Delete order A1-${first}`) });
  await expect(confirm.getByRole('button', { name: 'Delete order' })).toBeDisabled(); // a reason is required
  await confirm.getByLabel('Reason').fill('Entered by mistake');
  await confirm.getByRole('button', { name: 'Delete order' }).click();
  await approveAsOwner(page); // a cashier cannot delete alone
  await expect(page.getByText('Order deleted. 1 later order(s) renumbered.')).toBeVisible();

  // The remaining order has moved up into the deleted order's number.
  await expect(running.getByRole('listitem')).toHaveCount(1);
  await expect(running.getByRole('listitem')).toContainText(`A1-${first}`);
  await expect(running.getByRole('listitem')).toContainText('Table T3');
});

test('split a bill by item into two invoices and pay each', async ({ page }) => {
  await signIn(page);
  await item(page, 'Sweet Lassi').click();
  await page.getByRole('dialog', { name: 'Sweet Lassi' }).getByRole('button', { name: /^Add/ }).click(); // Regular, 90
  await item(page, 'Gajar Halwa').click(); // 130
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  const split = page.getByRole('dialog', { name: 'Split bill by item' });
  await expect(split.getByRole('button', { name: 'Create 2 bills' })).toBeDisabled();
  await split.getByRole('button', { name: 'Move one Gajar Halwa to bill 2' }).click();
  await split.getByRole('button', { name: 'Create 2 bills' }).click();

  const pay = page.getByRole('dialog', { name: /Take payment · bill 1 of 2/ });
  await expect(pay).toContainText('₹95.00'); // 90 + 5% = 94.50 → 95
  await pay.getByRole('button', { name: 'Complete payment' }).click();
  const second = page.getByRole('dialog', { name: /Take payment · bill 2 of 2/ });
  await expect(second).toContainText('₹137.00'); // 130 + 5% = 136.50 → 137
  await second.getByRole('radio', { name: 'UPI' }).click();
  await second.getByRole('button', { name: 'Complete payment' }).click();
  await expect(page.getByRole('dialog', { name: 'Payment complete' })).toContainText('₹232.00');
});

test('refund a paid bill with a manager PIN, then lock the terminal and switch user', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: "Today's bills" }).click();
  const bills = page.getByRole('dialog', { name: "Today's bills" });
  await bills.getByRole('listitem').filter({ hasText: '₹530.00' }).getByRole('button').click();
  const bill = page.getByRole('dialog', { name: /^Bill A1/ });
  await expect(bill).toContainText('Paid by Cash');
  await bill.getByRole('button', { name: 'Refund' }).click();
  const refund = page.getByRole('dialog', { name: /^Refund on/ });
  await refund.getByLabel('Amount to refund').fill('100');
  await refund.getByLabel('Reason').fill('Cold food');
  await refund.getByRole('button', { name: 'Refund' }).click();
  await approveAsOwner(page);
  await expect(page.getByText('Refunded ₹100.00')).toBeVisible();
  await expect(bill).toContainText(/Refund C-A1\/\d{4}\/000001 · Cold food/);
  // One Escape closes the bill and leaves the list open; the next closes the list.
  await page.keyboard.press('Escape');
  await expect(bills.getByRole('listitem').filter({ hasText: '₹530.00' })).toContainText('Part refunded');
  await page.keyboard.press('Escape');
  await expect(bills).toBeHidden();

  // Lock, then the owner takes over with a PIN.
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('button', { name: 'Lock terminal' }).click();
  await expect(page.getByRole('heading', { name: 'Terminal locked' })).toBeVisible();
  await page.reload(); // a refresh must not get around the lock
  await expect(page.getByRole('heading', { name: 'Terminal locked' })).toBeVisible();
  await page.getByRole('button', { name: /Owner/ }).click();
  await page.getByLabel('PIN').fill('0000');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByText('Incorrect PIN.')).toBeVisible();
  await page.getByLabel('PIN').fill(OWNER.pin);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByLabel('Search items')).toBeVisible();
  await page.getByRole('button', { name: 'User menu' }).click();
  await expect(page.getByText('Owner · Owner')).toBeVisible();
});
