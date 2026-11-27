import { expect, type Page, test } from '@playwright/test';
import { CASHIER, POS_URL } from '../support/env.js';
import { clearRateLimits } from '../support/helpers.js';

/**
 * Reported on 2026-11-24: an EZO Bluetooth printer that works with another POS device was not listed on a Mac in Chrome.
 * The POS only reached Bluetooth printers through the serial-port picker, which lists Bluetooth Classic printers paired
 * with the computer; it had no Bluetooth Low Energy at all, which is what most phone-and-tablet printers speak.
 *
 * There is no Bluetooth radio in a test, so this stands in a Bluetooth Low Energy printer for the browser's own, and
 * records every byte the POS sends it. A real printer has not been tried: see POS_TEST_RESULTS.md.
 */
test.beforeEach(async ({ page }) => {
  await clearRateLimits();
  await page.addInitScript(() => {
    type Sim = { writes: number[][]; connects: number; requested: unknown; mode: 'printer' | 'off' | 'cancel' | 'not-a-printer'; drop: () => void; browserPrints: number };
    const sim: Sim = { writes: [], connects: 0, requested: null, mode: 'printer', drop: () => undefined, browserPrints: 0 };
    (window as unknown as { sim: Sim }).sim = sim;
    window.print = () => {
      sim.browserPrints += 1;
      window.dispatchEvent(new Event('afterprint'));
    };
    const bytes = (value: BufferSource) => Array.from(value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    // A notify-only channel first: the POS must pick the one it can write to.
    const status = { uuid: '00002af0-0000-1000-8000-00805f9b34fb', properties: { write: false, writeWithoutResponse: false } };
    const data = {
      uuid: '00002af1-0000-1000-8000-00805f9b34fb',
      properties: { write: true, writeWithoutResponse: true },
      async writeValueWithoutResponse(value: BufferSource) {
        if (!server.connected) throw new DOMException('GATT Server is disconnected.', 'NetworkError');
        sim.writes.push(bytes(value));
      },
      async writeValueWithResponse(value: BufferSource) {
        sim.writes.push(bytes(value));
      },
    };
    const server = {
      connected: false,
      async connect() {
        server.connected = true;
        sim.connects += 1;
        return server;
      },
      disconnect() {
        server.connected = false;
      },
      async getPrimaryServices() {
        if (sim.mode === 'not-a-printer') return [{ uuid: '0000180f-0000-1000-8000-00805f9b34fb', getCharacteristics: async () => [status] }];
        return [{ uuid: '000018f0-0000-1000-8000-00805f9b34fb', getCharacteristics: async () => [status, data] }];
      },
    };
    sim.drop = () => server.disconnect();
    const device = Object.assign(new EventTarget(), { id: 'ezo-58', name: 'EZO-58 BT', gatt: server });
    const bluetooth = {
      async requestDevice(options: unknown) {
        sim.requested = options;
        if (sim.mode === 'off') throw new DOMException('Bluetooth adapter not available.', 'NotFoundError');
        if (sim.mode === 'cancel') throw new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError');
        return device;
      },
    };
    Object.defineProperty(navigator, 'bluetooth', { get: () => bluetooth, configurable: true });
  });
});

type Sim = { writes: number[][]; connects: number; requested: { acceptAllDevices: boolean; optionalServices: string[] }; browserPrints: number };
const sim = (page: Page) => page.evaluate(() => (window as unknown as { sim: Sim }).sim);
const setMode = (page: Page, mode: string) => page.evaluate((value) => { (window as unknown as { sim: { mode: string } }).sim.mode = value; }, mode);
/** Everything the printer received, as text where it is text. */
const received = async (page: Page) => String.fromCharCode(...(await sim(page)).writes.flat());

async function signIn(page: Page) {
  await page.goto(POS_URL);
  await page.getByLabel('Email').fill(CASHIER.email);
  await page.getByLabel('Password').fill(CASHIER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const terminal = page.getByRole('button', { name: /Counter 1/ });
  await expect(terminal.or(page.getByLabel('Search items'))).toBeVisible();
  if (await terminal.isVisible()) await terminal.click();
  await expect(page.getByLabel('Search items')).toBeVisible();
}

test('connects a Bluetooth printer, prints a test page, a kitchen ticket and a bill on it, and reconnects when it drops the link', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Connect printer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect a printer' });
  await expect(dialog).toContainText('a printer talks to one device at a time');
  await dialog.getByRole('button', { name: 'Bluetooth printer' }).click();
  await expect(page.getByText('Printer connected. Bills will print on it.')).toBeVisible();
  const connected = page.getByRole('dialog', { name: 'Printer connected' });
  await expect(connected).toContainText('EZO-58 BT');

  // Every nearby device is offered, with the printing services the POS knows.
  const requested = (await sim(page)).requested;
  expect(requested.acceptAllDevices).toBe(true);
  expect(requested.optionalServices).toContain('000018f0-0000-1000-8000-00805f9b34fb');

  await connected.getByRole('button', { name: 'Print a test page' }).click();
  await expect.poll(() => received(page)).toContain('PRINTER CONNECTED');
  const test = await sim(page);
  expect(test.writes.flat().slice(0, 2)).toEqual([0x1b, 0x40]); // ESC @, the printer is reset first
  expect(Math.max(...test.writes.map((piece) => piece.length))).toBeLessThanOrEqual(20);
  await connected.getByRole('button', { name: 'Done' }).click();

  // A kitchen ticket from KOT, then the bill: both on the Bluetooth printer, nothing through the browser.
  await page.getByLabel('Search items').fill('2 MT');
  await page.getByLabel('Search items').press('Enter');
  await page.getByRole('button', { name: 'KOT', exact: true }).click();
  await expect.poll(() => received(page)).toContain('2 x Masala Tea');

  // The printer lets an idle link drop, as Bluetooth printers do; the next printout connects again by itself.
  await page.evaluate(() => (window as unknown as { sim: { drop: () => void } }).sim.drop());
  await page.getByRole('button', { name: /Bill & pay/ }).click();
  const pay = page.getByRole('dialog', { name: /Take payment/ });
  const billNumber = (await pay.textContent())!.match(/A1\/\d{4}\/\d{6}/)![0];
  await pay.getByRole('button', { name: 'Complete payment' }).click();
  await expect(page.getByRole('dialog', { name: 'Payment complete' })).toBeVisible();
  await expect.poll(() => received(page)).toContain(billNumber);
  const after = await sim(page);
  expect(after.connects).toBe(2);
  expect(after.browserPrints).toBe(0);
});

test('says plainly why a Bluetooth printer could not be connected', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Connect printer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect a printer' });

  await setMode(page, 'off');
  await dialog.getByRole('button', { name: 'Bluetooth printer' }).click();
  await expect(page.getByText('Bluetooth is off on this device. Switch it on and connect again.')).toBeVisible();

  await setMode(page, 'not-a-printer');
  await dialog.getByRole('button', { name: 'Bluetooth printer' }).click();
  await expect(page.getByText(/This Bluetooth device has no printing service the POS knows/)).toBeVisible();

  // Closing the browser's list without choosing is not an error.
  await setMode(page, 'cancel');
  await dialog.getByRole('button', { name: 'Bluetooth printer' }).click();
  await expect(dialog).toBeVisible();
  await expect(page.getByText(/cancelled/i)).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Printer connected' })).toHaveCount(0);
});
