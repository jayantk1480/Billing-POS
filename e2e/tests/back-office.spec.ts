import { expect, test } from '@playwright/test';
import { OWNER } from '../support/env.js';
import { clearRateLimits, latestMailTo, signIn, signOut } from '../support/helpers.js';

const VIEWER = { email: 'viewer@e2e.local', password: 'viewer first password' };

test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRateLimits);

test('sign in, stay signed in across a reload, and sign out', async ({ page }) => {
  await page.goto('/menu/products');
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill('definitely the wrong password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Incorrect email or password')).toBeVisible();

  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // The owner lands on the first page of the sidebar.
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Products' }).click();
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Paneer Tikka' })).toBeVisible();

  // The access token lives in memory only; after a reload the session is restored from the cookie.
  await page.reload();
  await expect(page.getByRole('row').filter({ hasText: 'Paneer Tikka' })).toBeVisible();

  await signOut(page);
  await page.goto('/menu/products');
  await expect(page).toHaveURL(/\/login/);
});

test('manage categories and products', async ({ page }) => {
  await signIn(page, OWNER);

  // Category
  await page.getByRole('link', { name: 'Categories' }).click();
  await page.getByRole('button', { name: 'Add category' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Chef Specials');
  await page.getByRole('dialog').getByRole('button', { name: 'Add category' }).click();
  await expect(page.getByText('Category added')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Chef Specials' })).toContainText('0 products');

  // Reorder: the new category starts last and moves up one place.
  const names = () => page.locator('main li p.font-medium').allTextContents();
  const before = await names();
  await page.getByRole('button', { name: 'Move Chef Specials up' }).click();
  await expect.poll(names).toEqual([...before.slice(0, -2), 'Chef Specials', before.at(-2)]);

  // Product: validation first, then a real save.
  await page.getByRole('link', { name: 'Products' }).click();
  await page.getByRole('button', { name: 'Add product' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Add product' }).click();
  await expect(dialog.getByText('Name is required')).toBeVisible();
  await expect(dialog.getByText('Enter a valid amount')).toBeVisible();

  await dialog.getByLabel('Name', { exact: true }).fill('Truffle Naan');
  await dialog.getByLabel('Category', { exact: true }).selectOption({ label: 'Chef Specials' });
  await dialog.getByLabel('Price', { exact: true }).fill('120');
  await dialog.getByLabel('Short code').fill('pt');
  await dialog.getByRole('button', { name: 'Add product' }).click();
  await expect(page.getByText(/Short code PT is already used by "Paneer Tikka"/)).toBeVisible();

  await dialog.getByLabel('Short code').fill('tn');
  await dialog.getByRole('button', { name: 'Add product' }).click();
  await expect(page.getByText('Product added')).toBeVisible();

  // Search by short code, then check the row.
  await page.getByLabel('Search products').fill('TN');
  const row = page.getByRole('row').filter({ hasText: 'Truffle Naan' });
  await expect(row).toContainText('₹120.00');
  await expect(row).toContainText('Chef Specials');
  await expect(page.getByRole('row')).toHaveCount(2);

  // Availability switch
  // The switch reflects the saved state, so it flips only after the server confirms.
  await row.getByRole('switch').click({ force: true });
  await expect(page.getByText('Truffle Naan is now unavailable')).toBeVisible();

  // Edit: add two variants; the first becomes the headline price.
  await page.getByRole('button', { name: 'Edit Truffle Naan' }).click();
  await dialog.getByRole('button', { name: 'Add variant' }).click();
  await dialog.getByLabel('Name (first is the default)').fill('Half');
  await dialog.getByLabel('Price', { exact: true }).nth(1).fill('80');
  await dialog.getByRole('button', { name: 'Add variant' }).click();
  await dialog.getByLabel('Name', { exact: true }).nth(1).fill('Full');
  await dialog.getByLabel('Price', { exact: true }).nth(2).fill('150');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Product updated')).toBeVisible();
  await expect(row).toContainText('₹80.00');
  await expect(row).toContainText('2 variants');

  // The change is in the database, not just on screen.
  await page.reload();
  await page.getByLabel('Search products').fill('truffle');
  await expect(page.getByRole('row').filter({ hasText: 'Truffle Naan' })).toContainText('2 variants');
  await expect(page.getByRole('row').filter({ hasText: 'Truffle Naan' }).getByRole('switch')).not.toBeChecked();

  // A category with products cannot be deleted; an empty one can.
  await page.getByRole('link', { name: 'Categories' }).click();
  await page.getByRole('button', { name: 'Delete Chef Specials' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(/Move or delete the 1 product/)).toBeVisible();

  await page.getByRole('link', { name: 'Products' }).click();
  await page.getByLabel('Search products').fill('truffle');
  await page.getByRole('button', { name: 'Delete Truffle Naan' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Truffle Naan deleted')).toBeVisible();
  await expect(page.getByText('No products match')).toBeVisible();

  await page.getByRole('link', { name: 'Categories' }).click();
  await page.getByRole('button', { name: 'Delete Chef Specials' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Chef Specials deleted')).toBeVisible();
});

test('add products in bulk from pasted rows, then delete them in bulk', async ({ page }) => {
  await signIn(page, OWNER);
  await page.getByRole('link', { name: 'Products' }).click();
  await page.getByRole('button', { name: 'Add in bulk' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add products in bulk' });
  const paste = dialog.getByLabel('Or paste rows copied from Excel or Google Sheets');

  // Rows without their column headings are refused before anything is sent.
  await paste.fill('Tomato Soup\tSoups\t120');
  await dialog.getByRole('button', { name: 'Check rows' }).click();
  await expect(dialog.getByRole('alert')).toContainText('The first row must name the columns');

  // As copied from a spreadsheet: tab-separated, with a blank row and a cell that needed quotes.
  await paste.fill([
    'Name\tCategory\tPrice\tShort code\tType',
    'Tomato Soup\tSoups\t120\tTS\tveg',
    'Chicken Soup\tSoups\t150.50\tCS\tnon-veg',
    '',
    '"Hot & Sour, ""Veg"""\tSoups\t₹140\t\t',
    'Paneer Tikka\tStarters\t260\t\t',
    'Mystery Soup\tSoups\tabc\t\t',
  ].join('\n'));
  await dialog.getByRole('button', { name: 'Check rows' }).click();

  // The review step: nothing is saved yet.
  await expect(dialog.getByText('3 will be added')).toBeVisible();
  await expect(dialog.getByText('1 already on the menu')).toBeVisible();
  await expect(dialog.getByText('1 row with a mistake')).toBeVisible();
  await expect(dialog.getByText('A new category will be created: Soups.')).toBeVisible();
  // Rows are numbered as in the sheet, where the blank row was row 4.
  await expect(dialog.getByRole('row').filter({ hasText: 'Hot & Sour, "Veg"' })).toContainText('5');
  await expect(dialog.getByRole('row').filter({ hasText: 'Paneer Tikka' })).toContainText('Skipped: "Paneer Tikka" is already in Starters.');
  await expect(dialog.getByRole('row').filter({ hasText: 'Mystery Soup' })).toContainText('"abc" is not a price.');
  await dialog.getByLabel('Show only the rows that are skipped').check();
  await expect(dialog.getByRole('row')).toHaveCount(3);

  await dialog.getByRole('button', { name: 'Add 3 products' }).click();
  await expect(page.getByText('3 products added')).toBeVisible();
  await expect(dialog).toBeHidden();

  await page.getByLabel('Filter by category').selectOption({ label: 'Soups (3)' });
  await expect(page.getByRole('row').filter({ hasText: 'Chicken Soup' })).toContainText('₹150.50');
  await expect(page.getByRole('row').filter({ hasText: 'Hot & Sour, "Veg"' })).toContainText('₹140.00');

  // Delete in bulk: tick one, then the whole page, then delete the lot.
  await page.getByLabel('Select Tomato Soup').check();
  await expect(page.getByRole('region', { name: 'Selected products' })).toContainText('1 selected');
  await page.getByLabel('Select every product on this page').check();
  await expect(page.getByRole('region', { name: 'Selected products' })).toContainText('3 selected');
  await page.getByRole('button', { name: 'Delete selected' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete 3 products' }).click();
  await expect(page.getByText('3 products deleted')).toBeVisible();
  await expect(page.getByText('No products match')).toBeVisible();

  // Leave the menu as it was for the tests that follow.
  await page.getByRole('link', { name: 'Categories' }).click();
  await page.getByRole('button', { name: 'Delete Soups' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Soups deleted')).toBeVisible();
});

test('manage modifier groups', async ({ page }) => {
  await signIn(page, OWNER);
  await page.getByRole('link', { name: 'Modifiers' }).click();
  await page.getByRole('button', { name: 'Add group' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Toppings');
  await dialog.getByRole('textbox', { name: 'Option' }).fill('Extra Cheese');
  await dialog.getByLabel('Extra price').first().fill('40');
  await dialog.getByRole('button', { name: 'Add option' }).click();
  await dialog.getByRole('textbox', { name: 'Option' }).nth(1).fill('Butter');
  await dialog.getByRole('button', { name: 'Add group' }).click();
  await expect(page.getByText('Modifier group added')).toBeVisible();

  const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Toppings' }) });
  await expect(card).toContainText('Optional, choose one');
  await expect(card).toContainText('+ ₹40.00');
  await expect(card).toContainText('Free');

  await page.getByRole('button', { name: 'Delete Toppings' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Toppings deleted')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Toppings' })).toHaveCount(0);
});

test('configure tax groups, restaurant details and billing settings', async ({ page }) => {
  await signIn(page, OWNER);

  await page.getByRole('link', { name: 'Tax groups' }).click();
  await page.getByRole('button', { name: 'Add tax group' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('GST 12%');
  await dialog.getByLabel('GST rate').fill('12');
  await expect(dialog.getByText('CGST 6% + SGST 6%')).toBeVisible();
  await dialog.getByRole('button', { name: 'Add tax group' }).click();
  await expect(page.getByText('Tax group added')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'GST 12%' })).toContainText('CGST 6% + SGST 6%');
  // The default group is protected.
  await page.getByRole('button', { name: 'Delete GST 5%' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(/This is the default tax group/)).toBeVisible();

  await page.getByRole('link', { name: 'Restaurant', exact: true }).click();
  await page.getByLabel('GSTIN').fill('29ABCDE1234F1Z5');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('The first two digits of the GSTIN must match the state')).toBeVisible();
  await page.getByLabel('GSTIN').fill('27ABCDE1234F1Z5');
  await page.getByLabel('Restaurant name').fill('Saffron House');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Restaurant details saved')).toBeVisible();

  await page.getByRole('link', { name: 'Billing & GST' }).click();
  await page.getByLabel('Bill footer').fill('Thank you for dining with us');
  await page.getByLabel('When an unbilled order is deleted').selectOption('MANUAL');
  await page.getByLabel('Business day starts at').fill('05:00');
  await page.getByLabel('Discount limit for cashiers').fill('150');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Cannot exceed 100%')).toBeVisible();
  await page.getByLabel('Discount limit for cashiers').fill('12.5');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Billing settings saved')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Bill footer')).toHaveValue('Thank you for dining with us');
  await expect(page.getByLabel('When an unbilled order is deleted')).toHaveValue('MANUAL');
  await expect(page.getByLabel('Business day starts at')).toHaveValue('05:00');
  await expect(page.getByLabel('Discount limit for cashiers')).toHaveValue('12.5');
  await expect(page.getByRole('navigation', { name: 'Main' })).toContainText('Saffron House');
  await page.getByRole('link', { name: 'Restaurant', exact: true }).click();
  await expect(page.getByLabel('Restaurant name')).toHaveValue('Saffron House');
});

test('a custom role limits what a new user can see and do', async ({ page }) => {
  await signIn(page, OWNER);

  await page.getByRole('link', { name: 'Roles' }).click();
  await page.getByRole('button', { name: 'Add role' }).click();
  await page.getByRole('dialog').getByLabel('Role name').fill('Menu Viewer');
  await page.getByRole('dialog').getByRole('button', { name: 'Add role' }).click();
  await expect(page.getByRole('heading', { name: 'Menu Viewer' })).toBeVisible();
  await page.getByLabel('View the menu').check();
  // Without this one the account would work on the billing screen only.
  await page.getByLabel(/Sign in to the back office/).check();
  await page.getByRole('button', { name: 'Save permissions' }).click();
  await expect(page.getByText(/Menu Viewer updated/)).toBeVisible();

  await page.getByRole('link', { name: 'Users' }).click();
  await page.getByRole('button', { name: 'Add user' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Vikram Viewer');
  await dialog.getByLabel('Email').fill(VIEWER.email);
  await dialog.getByLabel('Role').selectOption({ label: 'Menu Viewer' });
  await dialog.getByLabel('Password').fill('short');
  await dialog.getByRole('button', { name: 'Add user' }).click();
  await expect(dialog.getByText('Use at least 10 characters')).toBeVisible();
  await dialog.getByLabel('Password').fill(VIEWER.password);
  await dialog.getByRole('button', { name: 'Add user' }).click();
  await expect(page.getByText('User added')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: VIEWER.email })).toContainText('Menu Viewer');

  await signOut(page);
  await signIn(page, VIEWER);
  await expect(page).toHaveURL(/\/menu\/products/);
  await expect(page.getByRole('row').filter({ hasText: 'Paneer Tikka' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add product' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Billing & GST' })).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: 'Paneer Tikka' }).getByRole('switch')).toBeDisabled();

  await page.goto('/team/users');
  await expect(page.getByText('You do not have access to this page')).toBeVisible();
});

test('reset a forgotten password from the emailed link', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await page.getByLabel('Email').fill(VIEWER.email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  const mail = await latestMailTo(VIEWER.email);
  const link = /http:\/\/\S+reset-password\?token=[\w-]+/.exec(mail)![0];
  await page.goto(link);
  await page.getByLabel('New password', { exact: true }).fill('viewer second password');
  await page.getByLabel('Repeat new password').fill('something different');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('The two passwords do not match')).toBeVisible();
  await page.getByLabel('Repeat new password').fill('viewer second password');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel('Email').fill(VIEWER.email);
  await page.getByLabel('Password').fill(VIEWER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Incorrect email or password')).toBeVisible();
  await page.getByLabel('Password').fill('viewer second password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/menu\/products/);

  // The link works once.
  await signOut(page);
  await page.goto(link);
  await page.getByLabel('New password', { exact: true }).fill('viewer third password');
  await page.getByLabel('Repeat new password').fill('viewer third password');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('heading', { name: 'This link no longer works' })).toBeVisible();
  await page.getByRole('link', { name: 'Request a new link' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
});

test('review and end sessions from the account page', async ({ page, browser }) => {
  await signIn(page, OWNER);
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signIn(otherPage, OWNER);

  await page.getByRole('link', { name: /Owner/ }).click();
  await expect(page.getByText('This device')).toBeVisible();
  // Sessions are listed newest first, so the first one that is not this device is the other browser.
  await page.getByRole('main').getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page.getByText('Signed out of that device')).toBeVisible();

  // The other browser is signed out as soon as it next talks to the server.
  await otherPage.reload();
  await expect(otherPage).toHaveURL(/\/login/);
  await other.close();
});
