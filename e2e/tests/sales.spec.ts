import { expect, test } from '@playwright/test';
import { CASHIER, OWNER, POS_URL } from '../support/env.js';
import { clearRateLimits, signIn, signOut } from '../support/helpers.js';

// Runs after pos.spec.ts, which leaves bills and one open table order behind.
test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRateLimits);

test('review bills in the back office and refund one', async ({ page }) => {
  await signIn(page, OWNER);
  await page.getByRole('link', { name: 'Bills', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bills' })).toBeVisible();

  // The cash bill refunded at the counter shows what is left of it.
  const cashBill = page.getByRole('row').filter({ hasText: '₹530.00' });
  await expect(cashBill).toContainText('Part refunded');
  await expect(cashBill).toContainText('₹430.00');

  await page.getByLabel('Filter by payment').selectOption('PAID');
  await expect(page.getByRole('row').filter({ hasText: '₹530.00' })).toHaveCount(0);
  const splitPaid = page.getByRole('row').filter({ hasText: '₹315.00' });
  await splitPaid.getByRole('button').click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Paid by UPI');
  await expect(dialog).toContainText('Paid by Card');
  await expect(dialog).toContainText('Discount');
  await dialog.getByRole('button', { name: 'Refund' }).click();
  await dialog.getByRole('radio', { name: /Card/ }).click();
  await expect(dialog.getByLabel('Amount to refund')).toHaveValue('115');
  await dialog.getByLabel('Amount to refund').fill('500');
  await expect(dialog.getByText('At most ₹115.00')).toBeVisible();
  await dialog.getByLabel('Amount to refund').fill('15');
  await dialog.getByLabel('Reason').fill('Overcharged');
  await dialog.getByRole('button', { name: /^Refund ₹15.00/ }).click();
  await expect(page.getByText(/Refunded ₹15.00. Credit note C-A1\/\d{4}\/000002 issued/)).toBeVisible();
  await expect(dialog).toContainText('Overcharged');
});

test('delete an unbilled order from the back office and reset order numbers', async ({ page }) => {
  await signIn(page, OWNER);
  await page.getByRole('link', { name: 'Orders', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();

  const open = page.getByRole('row').filter({ hasText: 'Open' }).filter({ hasText: 'T3' });
  await expect(open).toContainText('Not billed');

  await open.getByRole('button', { name: /^Delete order/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Delete order' })).toBeDisabled();
  await dialog.getByLabel('Reason').fill('Guests left before ordering');
  await dialog.getByRole('button', { name: 'Delete order' }).click();
  await expect(page.getByText(/^Order deleted/)).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'T3' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Reset order and bill numbers' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close the gaps' }).click();
  await expect(page.getByText(/There are no gaps now|There were no gaps to close/)).toBeVisible();

  // Order numbers on screen are now consecutive from 1.
  const numbers = await page.getByRole('row').getByRole('button', { name: /^A1-\d+$/ }).allTextContents();
  const sorted = numbers.map((text) => Number(text.split('-')[1])).sort((a, b) => a - b);
  expect(sorted).toEqual(sorted.map((_, index) => index + 1));
});

test('dashboard and reports show the day\'s trading and export it', async ({ page }) => {
  await signIn(page, OWNER);

  // Dashboard: the owner's landing page.
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  const main = page.getByRole('main');
  await expect(main.getByText('Net sales')).toBeVisible();
  // Bills from the POS tests: 530 + 315 + 95 + 137 = 1,077 billed; 100 + 15 refunded.
  await expect(main).toContainText('₹962.00');
  await expect(main).toContainText('₹1,077.00 billed, ₹115.00 refunded');
  await expect(main.getByRole('figure', { name: 'Sales for the last seven days' })).toBeVisible();
  await expect(main.getByLabel(/₹1,077.00 from 4 bills/)).toBeVisible();
  await expect(main).toContainText('Top items today');

  // Reports: daily sales for today.
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Daily sales' })).toBeVisible();
  const table = page.getByRole('table');
  await expect(table.getByRole('row').nth(1)).toContainText('₹1,077.00');
  await expect(table.getByRole('row').nth(1)).toContainText('₹962.00');
  await expect(table.getByRole('row').last()).toContainText('Total');
  // Payment-type totals sit beside the sales total: 530 + 95 cash, 200 + 137 UPI, 115 card.
  const daily = page.getByLabel('Report totals');
  await expect(daily.locator('div').filter({ hasText: /^Cash/ })).toContainText('₹625.00');
  await expect(daily.locator('div').filter({ hasText: /^UPI/ })).toContainText('₹337.00');
  await expect(daily.locator('div').filter({ hasText: /^Card/ })).toContainText('₹115.00');

  // Another report, another period.
  await page.getByRole('navigation', { name: 'Reports' }).getByRole('button', { name: 'Payment summary' }).click();
  await expect(table.getByRole('row').filter({ hasText: 'UPI' })).toContainText('₹337.00'); // 200 + 137
  await expect(table.getByRole('row').filter({ hasText: 'Card' })).toContainText('₹15.00'); // refunded since
  await page.getByRole('button', { name: 'Yesterday' }).click();
  await expect(page.getByText('Nothing to report for this period')).toBeVisible();
  await page.getByRole('button', { name: 'Last 7 days' }).click();
  await expect(table.getByRole('row').filter({ hasText: 'Cash' })).toBeVisible();

  // Export.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download as CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^payment-summary_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.csv$/);
  const [excel] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download as Excel' }).click()]);
  expect(excel.suggestedFilename()).toMatch(/\.xlsx$/);

  await page.getByRole('navigation', { name: 'Reports' }).getByRole('button', { name: 'GST summary' }).click();
  await expect(table).toContainText('GST 5%');
  await expect(table).toContainText('Less: credit notes (2)');

  // Item-wise sales: line by line, with the headline totals above the table.
  await page.getByRole('navigation', { name: 'Reports' }).getByRole('button', { name: 'Item-wise sales' }).click();
  for (const heading of ['Sr. no.', 'Date', 'Receipt no.', 'Payment method', 'Unit', 'Amount', 'Discount', 'Total amount', 'Created by']) {
    await expect(table.getByRole('columnheader', { name: heading, exact: true })).toBeVisible();
  }
  const totals = page.getByLabel('Report totals');
  await expect(totals).toContainText('Total sales (receipts)');
  await expect(totals).toContainText('Total sales quantity');
  await expect(totals).toContainText('Total sales amount');
  await expect(table.getByRole('row').filter({ hasText: 'Dal Makhani' })).toContainText('UPI + Card');

  // The same fields run through the other reports.
  await page.getByRole('navigation', { name: 'Reports' }).getByRole('button', { name: 'Payments', exact: true }).click();
  for (const heading of ['Sr. no.', 'Date', 'Receipt no.', 'Payment method', 'Amount', 'Total amount', 'Created by']) {
    await expect(table.getByRole('columnheader', { name: heading, exact: true })).toBeVisible();
  }
  await expect(page.getByLabel('Report totals')).toContainText('Total received');
  await page.getByRole('navigation', { name: 'Reports' }).getByRole('button', { name: 'Orders' }).click();
  for (const heading of ['Sr. no.', 'Receipt no.', 'Payment method', 'Unit', 'Discount', 'Total amount', 'Created by']) {
    await expect(table.getByRole('columnheader', { name: heading, exact: true })).toBeVisible();
  }
  await page.getByRole('navigation', { name: 'Reports' }).getByRole('button', { name: 'Cashier-wise' }).click();
  await expect(page.getByLabel('Report totals')).toContainText('Total sales quantity');
  await expect(table.getByRole('row').filter({ hasText: 'Cashier' })).toContainText('₹1,077.00');
});

test('share one report with a biller, who opens it from the billing screen and cannot enter the back office', async ({ page }) => {
  await signIn(page, OWNER);
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page.getByRole('navigation', { name: 'Reports' }).getByRole('button', { name: 'Item-wise sales' }).click();
  await page.getByRole('button', { name: 'Share Item-wise sales' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share Item-wise sales' });
  // Only people who cannot already see every report are offered.
  await expect(dialog.getByRole('list', { name: 'People to share with' }).getByRole('listitem')).toHaveCount(2); // the cashier and the viewer made earlier
  await dialog.getByLabel(/Cashier/).first().check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Item-wise sales shared with 1 person.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share Item-wise sales' })).toContainText('Shared with 1');
  await signOut(page);

  // The biller's account is for billing only: the back office turns it away.
  await page.getByLabel('Email').fill(CASHIER.email);
  await page.getByLabel('Password').fill(CASHIER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('This account is for billing only. Sign in on the billing (POS) screen instead.')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);

  // On the billing screen, Reports in the user menu holds the one report shared with them.
  await page.goto(POS_URL);
  await page.getByLabel('Email').fill(CASHIER.email);
  await page.getByLabel('Password').fill(CASHIER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const terminal = page.getByRole('button', { name: /Counter 1/ });
  await expect(terminal.or(page.getByLabel('Search items'))).toBeVisible();
  if (await terminal.isVisible()) await terminal.click();
  await expect(page.getByLabel('Search items')).toBeVisible();
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('button', { name: 'Reports', exact: true }).click();

  const screen = page.getByRole('dialog', { name: 'Reports' });
  const reports = screen.getByRole('navigation', { name: 'Reports' });
  await expect(reports.getByRole('button')).toHaveCount(1);
  await expect(reports.getByRole('button', { name: 'Item-wise sales' })).toBeVisible();
  await expect(screen.getByRole('table').getByRole('columnheader', { name: 'Receipt no.', exact: true })).toBeVisible();
  await expect(screen.getByLabel('Report totals')).toContainText('Total sales amount');
  await expect(screen.getByRole('button', { name: /^Share/ })).toHaveCount(0);
  const [download] = await Promise.all([page.waitForEvent('download'), screen.getByRole('button', { name: 'Download as PDF' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^items_.*\.pdf$/);

  // Billing is one tap away, exactly as it was left.
  await screen.getByRole('button', { name: 'Back to billing' }).click();
  await expect(screen).toHaveCount(0);
  await expect(page.getByLabel('Search items')).toBeVisible();
});

test('the owner corrects a payment method, reopens a billed order and deletes a billed order', async ({ page }) => {
  await signIn(page, OWNER);

  // Orders is opened first, so that coming back to it later shows whether it picked up the correction.
  await page.getByRole('link', { name: 'Orders', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '₹315.00' })).toContainText('UPI + Card');

  // The split bill was recorded as UPI and card; the UPI part was really cash.
  await page.getByRole('link', { name: 'Bills', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bills' })).toBeVisible();
  await page.getByRole('row').filter({ hasText: '₹315.00' }).getByRole('button').click();
  const bill = page.getByRole('dialog');
  await expect(bill).toContainText('Paid by UPI');
  await bill.getByRole('button', { name: 'Change payment method' }).click();
  await bill.getByRole('radiogroup', { name: 'Payment to change' }).getByRole('radio', { name: /UPI/ }).click();
  await expect(bill.getByRole('button', { name: /^Change to/ })).toBeDisabled();
  await bill.getByRole('radiogroup', { name: 'New payment method' }).getByRole('radio', { name: 'Cash' }).click();
  await bill.getByLabel('Reason').fill('Guest paid cash, wrong button pressed');
  await bill.getByRole('button', { name: 'Change to Cash' }).click();
  await expect(page.getByText('Payment changed from UPI to Cash.')).toBeVisible();
  await expect(bill).toContainText('Paid by Cash');
  await expect(bill).not.toContainText('Paid by UPI');
  await expect(bill).toContainText('₹315.00');
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'Orders', exact: true }).click();
  const settled = page.getByRole('row').filter({ hasText: 'Settled' });
  await expect(settled.first()).toBeVisible();
  // The Billing type column shows how each order was paid, including the correction just made.
  await expect(page.getByRole('columnheader', { name: 'Billing type' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: '₹315.00' })).toContainText('Cash + Card');

  // That bill was paid two ways and part refunded. Changing its items keeps those payments as they are by default,
  // and what the extra item costs is left due.
  const twoWays = page.getByRole('row').filter({ hasText: '₹315.00' });
  const twoWaysBill = (await twoWays.getByRole('cell').nth(4).textContent())!.trim();
  await twoWays.getByRole('button', { name: /^Change order/ }).click();
  const keepEditor = page.getByRole('dialog', { name: /^Change order A1-\d+$/ });
  await expect(keepEditor.getByRole('radio', { name: 'Keep the payments as recorded' })).toHaveAttribute('aria-checked', 'true');
  await keepEditor.getByRole('button', { name: /^One more / }).first().click();
  await expect(keepEditor.getByText(/is left due/)).toBeVisible();
  await keepEditor.getByLabel('Reason').fill('One more was served');
  await keepEditor.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/changed\. Bill/)).toBeVisible();
  const twoWaysAfter = page.getByRole('row').filter({ hasText: twoWaysBill });
  await expect(twoWaysAfter).toContainText('Awaiting payment');
  await expect(twoWaysAfter).toContainText('Cash + Card');
  // Closing the editor with unsaved changes asks first.
  await twoWaysAfter.getByRole('button', { name: /^Change order/ }).click();
  await keepEditor.getByRole('button', { name: /^One more / }).first().click();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Discard your changes?' }).getByRole('button', { name: 'Discard changes' }).click();
  await expect(keepEditor).toHaveCount(0);
  const before = await settled.count();
  expect(before).toBeGreaterThanOrEqual(2);
  const billOf = async (row: ReturnType<typeof settled.first>) => (await row.getByRole('cell').nth(4).textContent())!.trim();

  // Change the items of a settled order right here: one more of its first item.
  // (An order with one bill; one that was split into several comes back as a single bill.)
  const changedBill = await billOf(settled.filter({ hasNotText: /\d{6}, / }).first());
  const changedRow = page.getByRole('row').filter({ hasText: changedBill });
  const totalBefore = (await changedRow.getByRole('cell').nth(6).textContent())!.trim();
  await changedRow.getByRole('button', { name: /^Change order/ }).click();
  const editor = page.getByRole('dialog', { name: /^Change order A1-\d+$/ });
  await expect(editor.getByRole('alert')).toContainText('Saving replaces bill ' + changedBill);
  await expect(editor.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await editor.getByRole('button', { name: /^One more / }).first().click();
  await expect(editor.getByLabel('New totals')).toContainText('Was');
  await expect(editor.getByLabel('New totals')).toContainText(totalBefore);
  // An item can be found by name and added too.
  await editor.getByLabel('Add an item').fill('masala tea');
  await editor.getByRole('list', { name: 'Matching items' }).getByRole('button', { name: /Masala Tea/ }).click();
  await expect(editor.getByLabel('Quantity of Masala Tea')).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  // Whatever was received before, the whole new total is recorded as paid in cash.
  await editor.getByRole('radio', { name: 'Paid by Cash' }).click();
  await editor.getByLabel('Reason').fill('Guest had more than was billed');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(new RegExp('changed\\. Bill ' + changedBill.replace(/\//g, '\\/') + ' is now'))).toBeVisible();
  // Same bill number, still settled, a new total.
  await expect(settled).toHaveCount(before);
  await expect(changedRow).toContainText('Settled');
  await expect(changedRow.getByRole('cell').nth(6)).not.toHaveText(totalBefore);

  // Or send it to the billing screen to be changed there: its bill is erased and it is an open order again.
  const reopenedBill = await billOf(settled.first());
  await settled.first().getByRole('button', { name: /^Change order/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Change on the billing screen instead' }).click();
  const reopen = page.getByRole('dialog', { name: /^Reopen order/ });
  await expect(reopen.getByRole('alert')).toContainText(reopenedBill);
  await expect(reopen.getByRole('button', { name: 'Reopen order' })).toBeDisabled();
  await reopen.getByLabel('Reason').fill('Guest wants to add a dessert');
  await reopen.getByRole('button', { name: 'Reopen order' }).click();
  await expect(page.getByText(/is open again/)).toBeVisible();
  await expect(settled).toHaveCount(before - 1);
  // It is an ordinary open order now; removing it keeps the later tests' tables free.
  const open = page.getByRole('row').filter({ hasText: 'Open' }).filter({ hasText: 'Not billed' });
  await expect(open).toHaveCount(1);
  await open.getByRole('button', { name: /^Delete order/ }).click();
  await page.getByRole('dialog').getByLabel('Reason').fill('Tidying up after the test');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete order', exact: true }).click();
  await expect(page.getByText(/^Order deleted/)).toBeVisible();

  // Delete a settled order outright: the order, its bill and its payment all go.
  const deletedBill = await billOf(settled.first());
  await settled.first().getByRole('button', { name: /^Delete order/ }).click();
  const remove = page.getByRole('dialog');
  await expect(remove.getByRole('alert')).toContainText('This erases bill ' + deletedBill);
  await remove.getByLabel('Reason').fill('Test bill made while training');
  await remove.getByRole('button', { name: 'Delete order and bill' }).click();
  await expect(page.getByText(/^Order and its bill deleted/)).toBeVisible();
  await expect(settled).toHaveCount(before - 2);

  // The bills after the erased ones moved up: the bill numbers that remain run 1, 2, 3… with none missing.
  await page.getByRole('link', { name: 'Bills', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bills' })).toBeVisible();
  await expect(page.getByRole('row').nth(1)).toBeVisible();
  const numbers = (await page.getByRole('row').getByRole('button', { name: /^A1\/\d{4}\/\d{6}$/ }).allTextContents()).map((text) => Number(text.slice(-6))).sort((a, b) => a - b);
  expect(numbers.length).toBeGreaterThan(0);
  expect(numbers).toEqual(numbers.map((_, index) => index + 1));
});

test('every table sorts by a column heading, ascending then descending', async ({ page }) => {
  await signIn(page, OWNER);
  const rupees = (texts: string[]) => texts.map((text) => Number(text.replace(/[^0-9.]/g, '')));
  const ascending = (values: number[]) => values.every((value, index) => index === 0 || values[index - 1]! <= value);
  const descending = (values: number[]) => values.every((value, index) => index === 0 || values[index - 1]! >= value);

  // Orders: sorted by the server, so it holds across pages.
  await page.getByRole('link', { name: 'Orders', exact: true }).click();
  await expect(page.getByRole('row').nth(1)).toBeVisible();
  const total = page.getByRole('columnheader', { name: 'Total' });
  await expect(total).toHaveAttribute('aria-sort', 'none');
  await total.getByRole('button').click();
  await expect(total).toHaveAttribute('aria-sort', 'ascending');
  const orderTotals = () => page.getByRole('row').locator('td:nth-child(7)').allTextContents();
  await expect.poll(async () => ascending(rupees(await orderTotals()))).toBe(true);
  await total.getByRole('button').click();
  await expect(total).toHaveAttribute('aria-sort', 'descending');
  await expect.poll(async () => descending(rupees(await orderTotals()))).toBe(true);
  // Another column takes over, and only one column is marked as sorted.
  await page.getByRole('columnheader', { name: 'Bill', exact: true }).getByRole('button').click();
  await expect(page.getByRole('columnheader', { name: 'Bill', exact: true })).toHaveAttribute('aria-sort', 'ascending');
  await expect(total).toHaveAttribute('aria-sort', 'none');

  // Bills.
  await page.getByRole('link', { name: 'Bills', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bills' })).toBeVisible();
  const billHeading = page.getByRole('columnheader', { name: 'Bill', exact: true });
  await billHeading.getByRole('button').click();
  await expect(billHeading).toHaveAttribute('aria-sort', 'ascending');
  const billNumbers = async () => (await page.getByRole('row').locator('td:nth-child(1)').allTextContents()).map((text) => Number(text.trim().slice(-6)));
  await expect.poll(async () => ascending(await billNumbers())).toBe(true);
  await billHeading.getByRole('button').click();
  await expect.poll(async () => descending(await billNumbers())).toBe(true);

  // A list that is all on the page: users.
  await page.getByRole('link', { name: 'Users' }).click();
  const userHeading = page.getByRole('columnheader', { name: 'User' });
  await userHeading.getByRole('button').click();
  const userNames = async () => (await page.getByRole('row').locator('td:nth-child(1) p:first-child').allTextContents()).map((text) => text.replace('(you)', '').trim());
  await expect.poll(async () => { const names = await userNames(); return names.join('|') === [...names].sort((a, b) => a.localeCompare(b)).join('|'); }).toBe(true);
  await userHeading.getByRole('button').click();
  await expect(userHeading).toHaveAttribute('aria-sort', 'descending');
  await expect.poll(async () => { const names = await userNames(); return names.join('|') === [...names].sort((a, b) => b.localeCompare(a)).join('|'); }).toBe(true);

  // Reports: any column of any report. Payments is used because it has rows here: the one order left by the
  // tests above is part paid, so it is not a completed sale yet and the sales reports are empty.
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page.getByRole('navigation', { name: 'Reports' }).getByRole('button', { name: 'Item-wise sales' }).click();
  await expect(page.getByText('Nothing to report for this period')).toBeVisible();
  await page.getByRole('navigation', { name: 'Reports' }).getByRole('button', { name: 'Payments', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
  const amount = page.getByRole('table').getByRole('columnheader', { name: 'Total amount', exact: true });
  await amount.getByRole('button').click();
  await expect(amount).toHaveAttribute('aria-sort', 'ascending');
  const index = await page.getByRole('table').getByRole('columnheader').evaluateAll((cells) => cells.findIndex((cell) => cell.textContent?.trim() === 'Total amount') + 1);
  const amounts = () => page.getByRole('table').locator(`tbody td:nth-child(${index})`).allTextContents();
  await expect.poll(async () => ascending(rupees(await amounts()))).toBe(true);
  await amount.getByRole('button').click();
  await expect.poll(async () => descending(rupees(await amounts()))).toBe(true);
  // The totals row stays at the foot.
  await expect(page.getByRole('table').locator('tfoot')).toContainText('Total');
});
