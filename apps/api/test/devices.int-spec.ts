import { randomUUID } from 'node:crypto';
import { formatDocumentNumber } from '@pos/billing-core';
import { billed, FY, line, pay, saveOrder, type Scene, scene } from './support/billing.js';
import { createHarness, type Harness, PASSWORD } from './support/harness.js';

/**
 * Groundwork for billing offline: each device registers once and gets a hidden till of its own, whose order and bill
 * series only that device numbers. Those tills are never listed or signed in to, the server never renumbers their
 * series, and an order from one billed or refunded online is numbered in the signed-in till's series instead.
 */
describe('POS devices and their offline tills', () => {
  let h: Harness;
  let s: Scene;

  beforeAll(async () => {
    h = await createHarness();
  });
  beforeEach(async () => {
    await h.reset();
    s = await scene(h);
  });
  afterAll(async () => {
    await h.close();
  });

  const register = (client = s.cashier, deviceKey: string = randomUUID(), label: string | null = 'Counter tablet') =>
    client.post('/pos/devices', { deviceKey, label });
  const offlineTill = async (code: string) => h.prisma.terminal.findFirstOrThrow({ where: { restaurantId: s.fx.restaurant.id, code } });

  /**
   * Moves orders, with their bills, into a device's offline till as numbers 1, 2, 3…, as the upload of offline work
   * will store them. Done directly in the database (the upload is a later phase), under the override that alone lets
   * an issued bill be changed.
   */
  async function asOffline(code: string, orderIds: string[]) {
    const till = await offlineTill(code);
    await h.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.owner_override', 'on', true)`;
      const series = await tx.numberSeries.upsert({
        where: { terminalId_type_financialYear: { terminalId: till.id, type: 'INVOICE', financialYear: FY } },
        update: {}, create: { restaurantId: s.fx.restaurant.id, terminalId: till.id, type: 'INVOICE', financialYear: FY, prefix: code, nextNumber: 1 },
      });
      for (const [index, orderId] of orderIds.entries()) {
        const number = index + 1;
        await tx.order.update({ where: { id: orderId }, data: { terminalId: till.id, series: code, orderNumber: number, tokenNumber: number } });
        await tx.invoice.updateMany({
          where: { orderId }, data: { terminalId: till.id, seriesId: series.id, number, invoiceNumber: formatDocumentNumber(code, FY, number) },
        });
      }
      await tx.numberSeries.update({ where: { id: series.id }, data: { nextNumber: orderIds.length + 1 } });
    });
  }

  describe('registering', () => {
    it('gives each device its own offline code, and the same device the same one every time', async () => {
      const key = randomUUID();
      const first = (await register(s.cashier, key).expect(200)).body;
      expect(first).toMatchObject({ offlineCode: 'Z01', id: expect.any(String), registeredAt: expect.any(String) });
      expect((await register(s.owner, key).expect(200)).body).toEqual(first);
      expect((await register().expect(200)).body.offlineCode).toBe('Z02');
      expect(await h.prisma.auditLog.count({ where: { action: 'device.registered' } })).toBe(2);
      // The device remembers the counter till it was last used on.
      expect((await h.prisma.posDevice.findUniqueOrThrow({ where: { id: first.id } })).homeTerminalId).toBe(s.fx.terminal.id);
    });

    it('never gives two devices the same code, even when they register at once', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => register()));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(new Set(results.map((r) => r.body.offlineCode)).size).toBe(6);
      // Codes skip any till code already taken.
      await h.prisma.terminal.create({ data: { restaurantId: s.fx.restaurant.id, code: 'Z07', name: 'Taken' } });
      expect((await register().expect(200)).body.offlineCode).toBe('Z08');
    });

    it('keeps devices apart between restaurants, refuses a removed device, and needs the right to take orders', async () => {
      const key = randomUUID();
      await register(s.cashier, key).expect(200);
      const other = await scene(h, 'b');
      const theirs = (await register(other.cashier, key).expect(200)).body;
      expect(theirs.offlineCode).toBe('Z01');
      expect(await h.prisma.posDevice.count()).toBe(2);

      await h.prisma.posDevice.updateMany({ where: { restaurantId: s.fx.restaurant.id }, data: { revokedAt: new Date() } });
      expect((await register(s.cashier, key)).body.code).toBe('DEVICE_REVOKED');

      await s.owner.post('/users', { name: 'Chef', email: 'chef@test.local', roleId: s.fx.roles.kitchen, password: 'a long enough password' }).expect(201);
      const chef = h.client();
      await chef.login('chef@test.local', 'a long enough password', { client: 'kds' });
      expect((await register(chef)).status).toBe(403);
      expect((await s.cashier.post('/pos/devices', { deviceKey: 'not-a-uuid' })).status).toBe(400);
    });
  });

  describe('offline tills stay hidden', () => {
    it('are never listed, edited or signed in to, and owners cannot make a till code starting with Z', async () => {
      const { offlineCode } = (await register().expect(200)).body;
      const till = await offlineTill(offlineCode);
      expect(till.kind).toBe('OFFLINE');
      expect((await s.owner.get('/terminals').expect(200)).body.map((t: { code: string }) => t.code)).toEqual(['A1']);
      expect((await s.owner.patch(`/terminals/${till.id}`, { name: 'Renamed' })).status).toBe(404);

      const signIn = await h.client().login(s.fx.cashier.email, PASSWORD, { client: 'pos', terminalId: till.id });
      expect(signIn.body.code).toBe('TERMINAL_NOT_FOUND');
      expect((await s.cashier.post('/auth/terminal', { client: 'pos', terminalId: till.id })).body.code).toBe('TERMINAL_NOT_FOUND');

      const reserved = await s.owner.post('/terminals', { code: 'Z9', name: 'Bar counter' });
      expect(reserved.status).toBe(400);
      expect(JSON.stringify(reserved.body)).toContain('kept for offline billing');
      await s.owner.post('/terminals', { code: 'B2', name: 'Bar counter' }).expect(201);
    });
  });

  describe('numbering', () => {
    it('bills and refunds an order from an offline till in the signed-in till\'s series, never the device\'s', async () => {
      const { offlineCode } = (await register().expect(200)).body;
      // An order the device took offline and uploaded, still open: billed now at counter A1.
      const order = (await saveOrder(s.cashier, { items: [line(s.menu.paneer.id)] }).expect(200)).body;
      await asOffline(offlineCode, [order.id]);
      const [bill] = (await s.cashier.post(`/orders/${order.id}/invoices`, {}).expect(201)).body;
      expect(bill.invoiceNumber).toBe(`A1/${FY}/000001`);
      expect(await h.prisma.numberSeries.count({ where: { terminal: { kind: 'OFFLINE' } } })).toBe(1);

      // A bill the device issued offline, refunded at A1: the credit note is A1's.
      const sold = await billed(s.cashier, [line(s.menu.cola.id)]);
      const paid = (await pay(s.cashier, sold.invoice.id, [{ method: 'CASH', amountPaise: sold.invoice.totalPaise }]).expect(200)).body;
      await asOffline(offlineCode, [order.id, sold.order.id]);
      const refunded = (await s.owner.post(`/invoices/${sold.invoice.id}/refunds`, { id: randomUUID(), paymentId: paid.payments[0].id, amountPaise: 1000, reason: 'Cold' }).expect(200)).body;
      expect(refunded.invoiceNumber).toBe(formatDocumentNumber(offlineCode, FY, 2));
      expect(refunded.refunds[0].creditNoteNumber).toBe(`C-A1/${FY}/000001`);
    });

    it('never renumbers an offline series: erasing an offline bill leaves its gap, and "reset numbers" leaves it alone', async () => {
      await s.owner.patch('/settings', { orderRenumberMode: 'AUTO' }).expect(200);
      const { offlineCode } = (await register().expect(200)).body;
      const made = [];
      for (let i = 0; i < 3; i += 1) {
        const sale = await billed(s.cashier, [line(s.menu.cola.id)]);
        await pay(s.cashier, sale.invoice.id, [{ method: 'CASH', amountPaise: sale.invoice.totalPaise }]).expect(200);
        made.push(sale);
      }
      // A counter bill after them, so the counter series is there to be compacted as before.
      const counter = await billed(s.cashier, [line(s.menu.cola.id)]);
      await asOffline(offlineCode, made.map((sale) => sale.order.id));
      const offlineNumbers = async () => (await h.prisma.invoice.findMany({ where: { terminal: { kind: 'OFFLINE' } }, orderBy: { number: 'asc' } })).map((i) => i.invoiceNumber);
      const offlineOrders = async () => (await h.prisma.order.findMany({ where: { series: offlineCode }, orderBy: { orderNumber: 'asc' } })).map((o) => o.orderNumber);
      const nextOffline = async () => (await h.prisma.numberSeries.findFirstOrThrow({ where: { terminal: { kind: 'OFFLINE' } } })).nextNumber;

      // The owner erases the device's second bill: numbers 1 and 3 stay, the gap stays, the counter does not move back.
      await s.owner.post(`/orders/${made[1]!.order.id}/delete`, { reason: 'Test bill' }).expect(200);
      expect(await offlineNumbers()).toEqual([formatDocumentNumber(offlineCode, FY, 1), formatDocumentNumber(offlineCode, FY, 3)]);
      expect(await offlineOrders()).toEqual([1, 3]);
      expect(await nextOffline()).toBe(4);

      // Changing an offline bill keeps its number and leaves the counter where it is.
      const third = (await s.owner.get(`/orders/${made[2]!.order.id}`).expect(200)).body;
      await s.owner.post(`/orders/${third.id}/amend`, {
        items: [{ id: third.items[0].id, productId: third.items[0].productId, quantity: 2 }], payment: { method: 'CASH' }, reason: 'Two were served',
      }).expect(200);
      expect(await offlineNumbers()).toEqual([formatDocumentNumber(offlineCode, FY, 1), formatDocumentNumber(offlineCode, FY, 3)]);
      expect(await nextOffline()).toBe(4);

      // "Reset order and bill numbers" closes gaps in the counter's series, never in the device's.
      await s.owner.post(`/orders/${counter.order.id}/delete`, { reason: 'Test' }).expect(200);
      await s.owner.post('/orders/renumber').expect(200);
      expect(await offlineNumbers()).toEqual([formatDocumentNumber(offlineCode, FY, 1), formatDocumentNumber(offlineCode, FY, 3)]);
      expect(await offlineOrders()).toEqual([1, 3]);
      expect(await nextOffline()).toBe(4);
    });
  });

  it('gives the POS the print layouts and the numbering epoch, so it can print and number without asking', async () => {
    const boot = (await s.cashier.get('/pos/bootstrap').expect(200)).body;
    expect(boot.printLayouts).toMatchObject({ receipt: expect.any(Object), kot: expect.objectContaining({ largeItems: false }) });
    expect(boot.settings.orderNumberEpoch).toBe(0);
    // The kitchen stations in kitchen order, for sending orders to the kitchen offline; a switched-off one is left out.
    await h.prisma.kitchenStation.create({ data: { restaurantId: s.fx.restaurant.id, name: 'Bar', isActive: false } });
    expect((await s.cashier.get('/pos/bootstrap').expect(200)).body.stations).toEqual([{ id: s.fx.station.id, name: 'Main Kitchen' }]);
    // Hidden tills never appear as the device's own till either.
    await register().expect(200);
    expect((await s.cashier.get('/pos/bootstrap').expect(200)).body.terminal.code).toBe('A1');
  });
});
