import { randomUUID } from 'node:crypto';
import { expect, request, test } from '@playwright/test';
import { API_URL, CASHIER, OWNER, WEB_URL } from '../support/env.js';
import { clearRateLimits, signIn } from '../support/helpers.js';

/**
 * Billing offline, step 2: a device uploads a bill it printed while offline whose total does not work out. The bill is
 * kept as printed, and the owner finds it under Sales, Offline uploads, and marks it checked.
 */
test.use({ baseURL: WEB_URL });
test.beforeEach(clearRateLimits);

interface Product { id: string; name: string; basePricePaise: number; taxGroupId: string | null; priceIncludesTax: boolean | null; variants: unknown[] }
interface TaxGroup { id: string; gstRateBps: number }

test('a bill printed offline that does not add up is kept, listed for the owner, and marked checked', async ({ page }) => {
  // The device: a cashier signed in on the billing screen, registered for offline billing.
  const api = await request.newContext({ baseURL: API_URL });
  const login = await (await api.post('/api/v1/auth/login', { data: { email: CASHIER.email, password: CASHIER.password, client: 'pos' } })).json();
  const headers = { Authorization: `Bearer ${login.accessToken}` };
  const deviceKey = randomUUID();
  const device = await (await api.post('/api/v1/pos/devices', { headers, data: { deviceKey, label: 'Test tablet' } })).json();
  expect(device.offlineCode).toMatch(/^Z[0-9A-Z]{2}$/);

  // A plain item taxed at 5%, priced without tax, worked out by hand: ₹X + 2.5% CGST + 2.5% SGST.
  const boot = await (await api.get('/api/v1/pos/bootstrap', { headers })).json();
  const gst5 = (boot.taxGroups as TaxGroup[]).find((group) => group.gstRateBps === 500)!;
  const product = (boot.products as Product[]).find((p) => p.taxGroupId === gst5.id && p.variants.length === 0 && p.priceIncludesTax !== true)!;
  const price = product.basePricePaise;
  const half = Math.round(price / 40);
  const total = price + 2 * half;
  const businessDate = boot.businessDate as string;
  const at = new Date().toISOString();
  const orderId = randomUUID();
  const lineId = randomUUID();
  const invoiceId = randomUUID();
  const printedNumber = `${device.offlineCode}/${device.numbers.financialYear}/000001`;
  const op = (type: string, body: object) => ({ id: randomUUID(), type, userId: login.user.id, createdAt: at, ...body });
  const operations = [
    op('order.save', {
      order: {
        id: orderId, type: 'TAKEAWAY', orderNumber: 1, businessDate, guests: 1, notes: null, deliveryAddress: null, customer: null, discount: null,
        items: [{
          id: lineId, productId: product.id, variantId: null, modifiers: [], name: product.name, variantName: null, hsnSac: null, taxGroupId: gst5.id,
          gstRateBps: 500, cessRateBps: 0, priceIncludesTax: false, stationId: null, unitPricePaise: price, quantity: 1, kotQuantity: 1, notes: null, discount: null,
        }],
      },
    }),
    op('invoice.issue', {
      invoice: {
        id: invoiceId, orderId, number: 1, invoiceNumber: printedNumber, businessDate, issuedAt: at, docType: 'TAX_INVOICE',
        seller: { name: boot.restaurant.name, legalName: null, gstin: null, fssaiNumber: null, phone: null, addressLines: [], stateCode: boot.restaurant.stateCode, stateName: boot.restaurant.stateName, footer: null, upiVpa: null },
        customer: null, serviceChargeBps: 0, printCount: 1,
        // ₹10 more than it comes to: a total typed over on the device.
        grossPaise: price, discountPaise: 0, taxablePaise: price, cgstPaise: half, sgstPaise: half, igstPaise: 0, cessPaise: 0, serviceChargePaise: 0, roundOffPaise: 0, totalPaise: total + 1000,
        items: [{
          orderItemId: lineId, name: product.name, hsnSac: null, quantity: 1, unitPricePaise: price, priceIncludesTax: false, grossPaise: price, discountPaise: 0,
          taxablePaise: price, taxRateBps: 500, cessRateBps: 0, cgstPaise: half, sgstPaise: half, igstPaise: 0, cessPaise: 0, totalPaise: total,
        }],
        taxes: [{ type: 'CGST', rateBps: 250, taxablePaise: price, amountPaise: half }, { type: 'SGST', rateBps: 250, taxablePaise: price, amountPaise: half }],
      },
    }),
  ];
  const pushed = await (await api.post('/api/v1/sync/push', { headers, data: { deviceKey, pending: 0, operations } })).json();
  expect(pushed.results.map((result: { outcome: string }) => result.outcome)).toEqual(['APPLIED', 'APPLIED']);
  expect(pushed.results[1].flags.map((flag: { code: string }) => flag.code)).toContain('TOTALS_DIFFER');
  await api.dispose();

  // The owner finds it in the back office.
  await signIn(page, OWNER);
  await page.goto('/sales/offline');
  await expect(page.getByRole('heading', { name: 'Offline uploads' })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: printedNumber });
  await expect(row).toContainText('The printed amounts do not work out');
  await expect(row).toContainText(device.offlineCode);
  await expect(row).toContainText('Test tablet');

  await row.getByRole('button', { name: 'Mark checked' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark as checked' });
  await dialog.getByLabel('Note (optional)').fill('Guest paid the printed amount');
  await dialog.getByRole('button', { name: 'Mark as checked' }).click();
  await expect(page.getByText('Marked as checked')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: printedNumber })).toHaveCount(0);

  await page.getByRole('radio', { name: 'Checked' }).click();
  await expect(page.getByRole('row').filter({ hasText: printedNumber })).toContainText('Owner');
});
