import { expect, type Page, test } from '@playwright/test';
import { CASHIER, KDS_URL, OWNER, POS_URL } from '../support/env.js';
import { clearRateLimits, signIn } from '../support/helpers.js';

// Runs after the back-office, POS and sales tests.
test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRateLimits);

test('lay out the floor: add an area and a table, move it, block it', async ({ page }) => {
  await signIn(page, OWNER);
  await page.getByRole('link', { name: 'Floor', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Floor' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Table T1,/ })).toBeVisible();

  // A new area starts empty.
  await page.getByRole('button', { name: 'Add area' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Garden');
  await page.getByRole('dialog').getByRole('button', { name: 'Add area' }).click();
  await expect(page.getByText('No tables in Garden')).toBeVisible();

  // Add a round table for six.
  await page.getByRole('button', { name: 'Add table' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add table' });
  await dialog.getByRole('button', { name: 'Add table' }).click();
  await expect(dialog.getByText('Name is required')).toBeVisible();
  await dialog.getByLabel('Name').fill('G1');
  await dialog.getByLabel('Seats').fill('6');
  await dialog.getByLabel('Shape').selectOption('ROUND');
  await dialog.getByRole('button', { name: 'Add table' }).click();
  await expect(page.getByText('Table added')).toBeVisible();
  const table = page.getByRole('button', { name: /^Table G1, 6 seats/ });
  await expect(table).toHaveCSS('left', '40px');

  // Move it by dragging and with the keyboard, then save.
  const box = (await table.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 + 120, { steps: 8 });
  await page.mouse.up();
  await expect(table).toHaveCSS('left', '240px');
  await expect(table).toHaveCSS('top', '160px');
  await table.press('ArrowRight');
  await expect(table).toHaveCSS('left', '248px');
  await expect(page.getByText('1 table(s) moved, not saved yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Save layout' }).click();
  await expect(page.getByText(/Layout saved/)).toBeVisible();

  await page.reload();
  await page.getByRole('tab', { name: /Garden/ }).click();
  await expect(page.getByRole('button', { name: /^Table G1,/ })).toHaveCSS('left', '248px');

  // Block the table, then remove it and its area.
  await page.getByRole('button', { name: /^Table G1,/ }).press('Enter');
  const edit = page.getByRole('dialog', { name: 'Table G1' });
  await edit.getByRole('switch', { name: 'Blocked' }).click({ force: true });
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: /^Table G1,/ })).toContainText('Blocked');

  await page.getByRole('button', { name: 'Delete Garden' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(/Move or delete the 1 table/)).toBeVisible();
  await page.getByRole('button', { name: /^Table G1,/ }).press('Enter');
  await page.getByRole('dialog', { name: 'Table G1' }).getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog', { name: 'Remove table' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Table G1 removed')).toBeVisible();
  await page.getByRole('button', { name: 'Delete Garden' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Garden deleted')).toBeVisible();
  await expect(page.getByRole('tab', { name: /Garden/ })).toHaveCount(0);
});

/** Signs in on the POS and shows the whole menu. Printing is stubbed: there is no printer in a test. */
async function openPos(page: Page) {
  await page.addInitScript(() => {
    window.print = () => window.dispatchEvent(new Event('afterprint'));
  });
  await page.goto(POS_URL);
  await page.getByLabel('Email').fill(CASHIER.email);
  await page.getByLabel('Password').fill(CASHIER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const terminal = page.getByRole('button', { name: /Counter 1/ });
  await expect(terminal.or(page.getByLabel('Search items'))).toBeVisible();
  if (await terminal.isVisible()) await terminal.click();
  await page.getByRole('navigation', { name: 'Categories' }).getByRole('button', { name: 'All items' }).click();
}

test('an order reaches the kitchen display live, is cooked, changed, moved and billed', async ({ browser }) => {
  const posContext = await browser.newContext();
  const kdsContext = await browser.newContext();
  const pos = await posContext.newPage();
  const kds = await kdsContext.newPage();
  const order = pos.getByRole('complementary', { name: 'Current order' });
  const items = pos.getByRole('list', { name: 'Items', exact: true });

  // The kitchen screen is up before anything is ordered at this table. (Earlier tests left other tickets on it.)
  await kds.goto(KDS_URL);
  await kds.getByLabel('Email').fill(OWNER.email);
  await kds.getByLabel('Password').fill(OWNER.password);
  await kds.getByRole('button', { name: 'Sign in' }).click();
  await expect(kds.getByText('Live', { exact: true })).toBeVisible();
  await expect(kds.getByRole('article', { name: /Table T1/ })).toHaveCount(0);

  // The waiter seats table T1 and sends the order.
  await openPos(pos);
  await pos.getByRole('radio', { name: 'Dine-in' }).click();
  await pos.getByRole('dialog', { name: 'Choose a table' }).getByRole('button', { name: 'Table T1, Free' }).click();
  await items.getByRole('button', { name: /Butter Naan/ }).click();
  await items.getByRole('button', { name: /Butter Naan/ }).click();
  await items.getByRole('button', { name: /Masala Tea/ }).click();
  await pos.getByRole('button', { name: 'KOT', exact: true }).click();
  await expect(pos.getByText(/Order A1-\d+ sent to Tandoor and Beverages/)).toBeVisible();
  await expect(order.getByText('Sent', { exact: true })).toHaveCount(2);

  // Without a refresh, each station gets its own ticket.
  const naan = kds.getByRole('article', { name: /Ticket \d+, Table T1/ }).filter({ hasText: 'Butter Naan' });
  const tea = kds.getByRole('article', { name: /Ticket \d+, Table T1/ }).filter({ hasText: 'Masala Tea' });
  await expect(naan).toContainText('2 × Butter Naan');
  await expect(naan).toContainText('Tandoor');
  await expect(tea).toContainText('1 × Masala Tea');
  await expect(kds.getByRole('complementary', { name: 'To make' })).toContainText('Butter Naan');

  // Station filter, then cook the naan through to done.
  await kds.getByRole('tab', { name: 'Beverages' }).click();
  await expect(tea).toBeVisible();
  await expect(naan).toHaveCount(0);
  await kds.getByRole('tab', { name: 'All stations' }).click();
  await naan.getByRole('button', { name: 'Start preparing' }).click();
  await expect(naan).toContainText('Preparing');
  await naan.getByRole('button', { name: 'Mark ready' }).click();
  await expect(naan).toContainText('Ready');
  await naan.getByRole('button', { name: 'Done' }).click();
  await expect(naan).toHaveCount(0);
  await kds.getByRole('button', { name: 'Done today' }).click();
  await expect(kds.getByRole('article', { name: /Table T1/ }).filter({ hasText: 'Butter Naan' })).toBeVisible();
  await kds.getByRole('button', { name: 'Back to open tickets' }).click();

  // The guest cancels the tea: the kitchen must be told, with a reason and a manager's approval.
  await order.getByRole('button', { name: 'Remove Masala Tea' }).click();
  await pos.getByRole('button', { name: 'KOT', exact: true }).click();
  const cancelDialog = pos.getByRole('dialog', { name: 'Already sent to the kitchen' });
  await expect(cancelDialog).toContainText('Masala Tea');
  await cancelDialog.getByLabel('Reason for the kitchen').fill('Guest changed their mind');
  await cancelDialog.getByRole('button', { name: 'Cancel them' }).click();
  const approval = pos.getByRole('dialog', { name: 'Manager approval' });
  await approval.getByLabel('Approving manager').selectOption({ label: 'Owner (Owner)' });
  await approval.getByLabel('Manager PIN').fill(OWNER.pin);
  await approval.getByRole('button', { name: 'Approve' }).click();
  await expect(pos.getByText(/Nothing new for the kitchen/)).toBeVisible();

  const cancellation = kds.getByRole('article', { name: /Cancellation \d+, Table T1/ });
  await expect(cancellation).toContainText('Masala Tea');
  await expect(cancellation).toContainText('Reason: Guest changed their mind');
  await cancellation.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(cancellation).toHaveCount(0);

  // The party moves to T2; the floor plan follows.
  await pos.getByRole('button', { name: 'Table T1' }).click();
  await pos.getByRole('dialog', { name: 'Choose a table' }).getByRole('button', { name: 'Table T2, Free' }).click();
  await pos.getByRole('button', { name: 'KOT', exact: true }).click();
  await expect(order.getByText('Unsaved changes')).toHaveCount(0);
  await pos.getByRole('button', { name: 'Table T2' }).click();
  const floor = pos.getByRole('dialog', { name: 'Choose a table' });
  await expect(floor.getByRole('button', { name: 'Table T1, Free' })).toBeVisible();
  await expect(floor.getByRole('button', { name: 'Table T2, Occupied' })).toContainText('₹116.00'); // 2 × 55 + 5%
  await pos.keyboard.press('Escape');

  // Bill and settle: the table is free again.
  await pos.getByRole('button', { name: /Bill & pay/ }).click();
  await pos.getByRole('dialog', { name: /Take payment/ }).getByRole('button', { name: 'Complete payment' }).click();
  await expect(pos.getByRole('dialog', { name: 'Payment complete' })).toContainText('₹116.00');
  await pos.getByRole('dialog', { name: 'Payment complete' }).getByRole('button', { name: 'New order' }).click();
  await pos.getByRole('radio', { name: 'Dine-in' }).click();
  await expect(pos.getByRole('dialog', { name: 'Choose a table' }).getByRole('button', { name: 'Table T2, Free' })).toBeVisible();

  await posContext.close();
  await kdsContext.close();
});
