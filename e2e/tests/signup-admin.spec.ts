import { expect, type Page, test } from '@playwright/test';
import { ADMIN_URL, PLATFORM_ADMIN, WEB_URL } from '../support/env.js';
import { clearRateLimits, deleteTestMail, latestMailTo } from '../support/helpers.js';

test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRateLimits);
test.beforeAll(deleteTestMail);
test.afterAll(deleteTestMail);

const linkIn = (text: string) => /https?:\/\/\S+token=[\w-]+\S*/.exec(text)![0];
const MEERA = { email: 'meera@e2e.local', password: 'tandoori nights 42' };
const RAVI = { email: 'ravi@e2e.local', password: 'crispy masala dosa 7' };

async function signInToBackOffice(page: Page, account: { email: string; password: string }) {
  await page.goto(WEB_URL + '/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('a restaurant registers itself, confirms its email and is shown how to get started', async ({ page }) => {
  await page.goto(WEB_URL + '/login');
  await page.getByRole('link', { name: 'Register your restaurant' }).click();
  await expect(page.getByRole('heading', { name: 'Register your restaurant' })).toBeVisible();
  await expect(page.getByText('Free for 14 days. No card needed.')).toBeVisible();

  await page.getByLabel('Restaurant name').fill('Spice Garden');
  await page.getByLabel('Your name').fill('Meera Nair');
  await page.getByLabel('Email').fill(MEERA.email);
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByLabel('Password').fill(MEERA.password);
  await page.getByLabel('State').selectOption({ label: 'Kerala' });
  // Registered for GST, so a GSTIN is asked for, and it has to belong to the state.
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByText('Enter the GSTIN, or choose "Not registered for GST"')).toBeVisible();
  await page.getByLabel('GSTIN').fill('27abcde1234f1z5');
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByText('The first two digits of the GSTIN must match the state')).toBeVisible();
  await page.getByLabel('GSTIN').fill('32ABCDE1234F1Z5');
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByText(MEERA.email)).toBeVisible();

  // The password alone does not open the account yet.
  await signInToBackOffice(page, MEERA);
  await expect(page.getByText('Confirm your email address first')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send the confirmation link again' })).toBeVisible();

  await page.goto(linkIn(await latestMailTo(MEERA.email)));
  await expect(page.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByLabel('Email')).toHaveValue(MEERA.email);
  await page.getByLabel('Password').fill(MEERA.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Its own, empty restaurant, on a trial, with the list of what to do first.
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(page.getByText('Owner · Spice Garden')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Free trial' })).toContainText(/1[34] days left/);
  await expect(page.getByText('0 of 5 done')).toBeVisible();
  await expect(page.getByRole('main')).toContainText('₹0.00');

  await page.getByRole('link', { name: /Add your address/ }).click();
  await expect(page.getByLabel('Restaurant name', { exact: true })).toHaveValue('Spice Garden');
  await expect(page.getByLabel('GSTIN', { exact: true })).toHaveValue('32ABCDE1234F1Z5');
  await page.getByLabel('Address line 1').fill('12 Beach Road');
  await page.getByLabel('City', { exact: true }).fill('Kochi');
  await page.getByRole('button', { name: /Save/ }).click();
  await expect(page.getByText('Restaurant details saved')).toBeVisible();
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByText('1 of 5 done')).toBeVisible();

  // The standard setup is there: tax groups, a billing terminal, a kitchen station.
  await page.getByRole('link', { name: 'Tax groups', exact: true }).click();
  await expect(page.getByRole('main')).toContainText('GST 5%');
  await page.getByRole('link', { name: 'Terminals', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Counter 1' })).toContainText('A1');
  // Nothing of the demo restaurant's is here.
  await page.getByRole('link', { name: 'Products', exact: true }).click();
  await expect(page.getByRole('main')).not.toContainText('Masala Tea');

  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await page.getByRole('button', { name: 'Hide this list' }).click();
  await expect(page.getByRole('heading', { name: 'Getting started' })).toBeHidden();
});

test('the link from an email that was already used, or made up, is refused, and a new one can be asked for', async ({ page }) => {
  await page.goto(WEB_URL + '/verify-email?token=' + 'x'.repeat(43));
  await expect(page.getByRole('heading', { name: 'This link no longer works' })).toBeVisible();
  await page.getByLabel('Email you registered with').fill(MEERA.email);
  await page.getByRole('button', { name: 'Send a new link' }).click();
  await expect(page.getByRole('status')).toContainText('just sign in');
});

async function signInToAdmin(page: Page) {
  await page.goto(ADMIN_URL + '/login');
  await page.getByLabel('Email').fill(PLATFORM_ADMIN.email);
  await page.getByLabel('Password').fill(PLATFORM_ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByLabel('Search restaurants')).toBeVisible();
}

test.describe('the platform admin app', () => {
  test('is a separate sign-in: a restaurant account does not open it, the platform admin does', async ({ page }) => {
    await page.goto(ADMIN_URL);
    await expect(page).toHaveURL(/\/login/);
    // The owner of a restaurant is nobody here.
    await page.getByLabel('Email').fill(MEERA.email);
    await page.getByLabel('Password').fill(MEERA.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Incorrect email or password.')).toBeVisible();

    await signInToAdmin(page);
    await expect(page.getByText(PLATFORM_ADMIN.name)).toBeVisible();
    // Both restaurants: the demo one from the install, and the one that signed up.
    // (Earlier tests rename the demo restaurant, so it is found by how it came to exist.)
    const demo = page.getByRole('row').filter({ hasText: 'Set up at install' });
    await expect(demo).toContainText('Active');
    const signedUp = page.getByRole('row').filter({ hasText: 'Spice Garden' });
    await expect(signedUp).toContainText(/On trial · 1[34] days left/);
    await expect(signedUp).toContainText('Meera Nair');
    await expect(signedUp).toContainText('Signed up');

    await page.getByLabel('Search restaurants').fill('kochi');
    await expect(demo).toHaveCount(0);
    await expect(signedUp).toBeVisible();
    await page.getByLabel('Search restaurants').fill('');
    await page.getByLabel('Filter by status').selectOption({ label: 'Suspended' });
    await expect(page.getByText('No restaurants match')).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto(ADMIN_URL);
    await expect(page).toHaveURL(/\/login/);
  });

  test('sets a restaurant up for someone, who chooses a password from the emailed link', async ({ page }) => {
    await signInToAdmin(page);
    await page.getByRole('button', { name: 'Add restaurant' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add restaurant' });
    await dialog.getByLabel('Restaurant name').fill('Dosa Corner');
    await dialog.getByLabel("Owner's name").fill('Ravi Kumar');
    // An address that already has an account is refused, next to the field.
    await dialog.getByLabel("Owner's email").fill(MEERA.email);
    await dialog.getByLabel('State').selectOption({ label: 'Karnataka' });
    await dialog.getByLabel('GST registration').selectOption({ label: 'Not registered for GST' });
    await dialog.getByLabel('Free trial days').fill('30');
    await dialog.getByRole('button', { name: 'Add restaurant' }).click();
    await expect(dialog.getByText(/already has an account/).first()).toBeVisible();
    await dialog.getByLabel("Owner's email").fill(RAVI.email);
    await dialog.getByRole('button', { name: 'Add restaurant' }).click();

    // Straight to the new restaurant's page.
    await expect(page.getByRole('heading', { name: 'Dosa Corner' })).toBeVisible();
    await expect(page.getByRole('main')).toContainText(/On trial · (29|30) days left/);
    await expect(page.getByRole('main')).toContainText('Not registered for GST');
    await expect(page.getByRole('main')).toContainText('Added by us');
    await expect(page.getByRole('main')).toContainText(RAVI.email);

    // The owner opens the email and chooses a password; that is also what confirms the address.
    const link = linkIn(await latestMailTo(RAVI.email));
    expect(link).toContain(WEB_URL);
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Welcome. Choose your password' })).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill(RAVI.password);
    await page.getByLabel('Repeat password').fill(RAVI.password);
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel('Email').fill(RAVI.email);
    await page.getByLabel('Password').fill(RAVI.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Owner · Dosa Corner')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Free trial' })).toContainText(/(29|30) days left/);
  });

  test('records a payment, suspends a restaurant and restores it', async ({ page, browser }) => {
    await signInToAdmin(page);
    await page.getByRole('link', { name: 'Dosa Corner' }).click();
    await expect(page.getByRole('heading', { name: 'Dosa Corner' })).toBeVisible();
    await expect(page.getByText("recorded in the restaurant's audit log", { exact: false }).first()).toBeVisible();

    // Paid for a year, by hand, with a note of how.
    await page.getByRole('button', { name: 'Record payment' }).click();
    const payment = page.getByRole('dialog', { name: 'Record payment' });
    await payment.getByRole('button', { name: 'Record payment' }).click();
    await expect(payment.getByText(/Note is required/)).toBeVisible();
    await payment.getByLabel('Note').fill('UPI ref 4411, ₹12,000 for one year');
    await payment.getByRole('button', { name: 'Record payment' }).click();
    await expect(page.getByText(/Payment recorded\. Dosa Corner is paid until/)).toBeVisible();
    await expect(page.getByRole('main')).toContainText(/Active until \d{1,2} \w{3} 2027/);

    // The owner is signed in, in another browser, when the restaurant is suspended.
    const ownerContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    await signInToBackOffice(owner, RAVI);
    await expect(owner.getByText('Owner · Dosa Corner')).toBeVisible();

    await page.getByRole('button', { name: 'Suspend', exact: true }).click();
    const suspend = page.getByRole('dialog', { name: 'Suspend Dosa Corner' });
    await suspend.getByLabel('Reason').fill('Chargeback on the subscription payment');
    await suspend.getByRole('button', { name: 'Suspend restaurant' }).click();
    await expect(page.getByText('Dosa Corner is suspended')).toBeVisible();
    await expect(page.getByRole('main')).toContainText('Chargeback on the subscription payment');

    // Thrown out at the next thing they do, and the password no longer opens the door.
    await owner.getByRole('link', { name: 'Products', exact: true }).click();
    await expect(owner).toHaveURL(/\/login/);
    await owner.getByLabel('Email').fill(RAVI.email);
    await owner.getByLabel('Password').fill(RAVI.password);
    await owner.getByRole('button', { name: 'Sign in' }).click();
    await expect(owner.getByText("This restaurant's account has been suspended")).toBeVisible();

    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByRole('dialog', { name: 'Restore Dosa Corner' }).getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText('Dosa Corner is restored. People there can sign in again.')).toBeVisible();
    await owner.getByRole('button', { name: 'Sign in' }).click();
    await expect(owner.getByText('Owner · Dosa Corner')).toBeVisible();
    await ownerContext.close();

    // What was done to the restaurant is in its activity, newest first.
    await page.reload();
    const activity = page.getByRole('main');
    await expect(activity).toContainText('Reactivated');
    await expect(activity).toContainText('Suspended');
    await expect(activity).toContainText('Paid until changed');
  });
});
