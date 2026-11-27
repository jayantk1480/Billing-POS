import { randomUUID } from 'node:crypto';
import { line, saveOrder, type Scene, scene } from './support/billing.js';
import { CASHIER_PIN, createHarness, type Harness, PASSWORD } from './support/harness.js';

describe('orders', () => {
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

  describe('taking an order', () => {
    it('numbers the order, prices it from the menu and computes GST', async () => {
      const response = await saveOrder(s.cashier, { items: [line(s.menu.paneer.id, 2), line(s.menu.cola.id, 1)] });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ displayNumber: 'A1-1', orderNumber: 1, tokenNumber: 1, status: 'OPEN', type: 'TAKEAWAY', createdByName: 'Cashier' });
      // Paneer 2 × 260 at 5% = 546; cola 50 at 18% = 59; total 605.
      expect(response.body.items.map((i: { name: string; unitPricePaise: number; taxPaise: number; totalPaise: number }) => [i.name, i.unitPricePaise, i.taxPaise, i.totalPaise]))
        .toEqual([['Paneer Tikka', 26000, 2600, 54600], ['Cola', 5000, 900, 5900]]);
      expect(response.body.totals).toMatchObject({ grossPaise: 57000, taxPaise: 3500, discountPaise: 0, totalPaise: 60500 });
    });

    it('prices variants and modifiers, and names them on the line', async () => {
      const response = await saveOrder(s.cashier, {
        items: [
          line(s.menu.chicken.id, 1, { variantId: s.menu.full.id }),
          line(s.menu.biryani.id, 2, { modifierIds: [s.menu.spicy.id, s.menu.raita.id], notes: 'No onion' }),
        ],
      });
      const [chicken, biryani] = response.body.items;
      expect(chicken).toMatchObject({ variantName: 'Full', unitPricePaise: 52000 });
      expect(biryani).toMatchObject({ unitPricePaise: 29000, grossPaise: 58000, notes: 'No onion' });
      expect(biryani.modifiers.map((m: { name: string }) => m.name).sort()).toEqual(['Raita', 'Spicy']);
    });

    it('rejects choices the menu does not allow', async () => {
      const code = async (item: object) => (await saveOrder(s.cashier, { items: [item] })).body.code;
      expect(await code(line(s.menu.chicken.id))).toBe('VARIANT_REQUIRED');
      expect(await code(line(s.menu.paneer.id, 1, { variantId: s.menu.half.id }))).toBe('VARIANT_NOT_FOUND');
      expect(await code(line(s.menu.biryani.id))).toBe('MODIFIER_SELECTION'); // spice level is required
      expect(await code(line(s.menu.biryani.id, 1, { modifierIds: [s.menu.mild.id, s.menu.spicy.id] }))).toBe('MODIFIER_SELECTION');
      expect(await code(line(s.menu.paneer.id, 1, { modifierIds: [s.menu.raita.id] }))).toBe('MODIFIER_NOT_FOUND');
      expect(await code(line(randomUUID()))).toBe('ITEM_NOT_FOUND');

      await h.prisma.product.update({ where: { id: s.menu.paneer.id }, data: { isAvailable: false } });
      expect(await code(line(s.menu.paneer.id))).toBe('ITEM_UNAVAILABLE');
      expect((await saveOrder(s.cashier, { items: [line(s.menu.cola.id, 0)] })).status).toBe(400);
      expect(await h.prisma.order.count()).toBe(0);
    });

    it('does not create a second order when the same save is sent twice', async () => {
      const id = randomUUID();
      const body = { items: [line(s.menu.paneer.id)] };
      const first = await saveOrder(s.cashier, body, id);
      const second = await saveOrder(s.cashier, body, id);
      expect(second.body.displayNumber).toBe(first.body.displayNumber);
      expect(await h.prisma.order.count()).toBe(1);
      expect(await h.prisma.orderItem.count()).toBe(1);
    });

    it('replaces the lines on each save, keeping the price an item was added at', async () => {
      const paneer = line(s.menu.paneer.id, 1);
      const cola = line(s.menu.cola.id, 1);
      const order = (await saveOrder(s.cashier, { items: [paneer, cola] })).body;

      // The menu price goes up mid-meal.
      await h.prisma.product.update({ where: { id: s.menu.paneer.id }, data: { basePricePaise: 30000 } });
      const updated = await saveOrder(s.cashier, { items: [{ ...paneer, quantity: 3 }, line(s.menu.paneer.id, 1)], version: order.version }, order.id);

      expect(updated.body.items.map((i: { quantity: number; unitPricePaise: number }) => [i.quantity, i.unitPricePaise]))
        .toEqual([[3, 26000], [1, 30000]]); // old line keeps ₹260, the new line gets ₹300, cola is gone
      expect(updated.body.totals.grossPaise).toBe(3 * 26000 + 30000);
    });

    it('refuses a save based on an outdated copy of the order', async () => {
      const order = (await saveOrder(s.cashier, { items: [line(s.menu.paneer.id)] })).body;
      await saveOrder(s.owner, { items: [line(s.menu.cola.id)], version: order.version }, order.id).expect(200);
      const stale = await saveOrder(s.cashier, { items: [line(s.menu.paneer.id, 5)], version: order.version }, order.id);
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('ORDER_CHANGED');
    });

    it('needs a billing terminal, which a device can choose after signing in', async () => {
      const device = h.client();
      await device.login(s.fx.cashier.email, PASSWORD, { client: 'pos' });
      expect((await saveOrder(device, { items: [line(s.menu.paneer.id)] })).body.code).toBe('TERMINAL_REQUIRED');

      const chosen = await device.post('/auth/terminal', { client: 'pos', terminalId: s.fx.terminal.id });
      expect(chosen.status).toBe(200);
      expect(chosen.body.user.terminalId).toBe(s.fx.terminal.id);
      device.token = chosen.body.accessToken;
      expect((await saveOrder(device, { items: [line(s.menu.paneer.id)] })).body.displayNumber).toBe('A1-1');
    });

    it('gives each order its own number when several are created at once', async () => {
      const responses = await Promise.all(Array.from({ length: 8 }, () => saveOrder(s.cashier, { items: [line(s.menu.cola.id)] })));
      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect(responses.map((r) => r.body.orderNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('saves customer details and finds the same customer again by phone', async () => {
      const customer = { name: 'Asha Rao', phone: '9876543210', address: 'Pune' };
      const first = (await saveOrder(s.cashier, { items: [line(s.menu.cola.id)], customer })).body;
      expect(first.customer).toMatchObject({ name: 'Asha Rao', phone: '9876543210', address: 'Pune' });
      await saveOrder(s.cashier, { items: [line(s.menu.cola.id)], customer: { name: 'Asha R', phone: '9876543210' } }).expect(200);
      expect(await h.prisma.customer.count()).toBe(1);
    });
  });

  describe('tables', () => {
    it('requires a table for dine-in and marks it occupied', async () => {
      expect((await saveOrder(s.cashier, { type: 'DINE_IN', items: [] })).status).toBe(400);
      const order = (await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, guests: 4, items: [line(s.menu.paneer.id)] }).expect(200)).body;
      expect(order).toMatchObject({ tableName: 'T1', guests: 4 });

      const tables = (await s.cashier.get('/tables').expect(200)).body as { name: string; status: string; orderId: string | null }[];
      expect(tables.find((t) => t.name === 'T1')).toMatchObject({ status: 'OCCUPIED', orderId: order.id });
      expect(tables.find((t) => t.name === 'T2')).toMatchObject({ status: 'FREE', orderId: null });
    });

    it('allows one running order per table and frees the table when the order moves or is cancelled', async () => {
      const first = (await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.cola.id)] })).body;
      const clash = await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [] });
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('TABLE_OCCUPIED');

      const status = async (id: string) => (await h.prisma.diningTable.findUniqueOrThrow({ where: { id } })).status;
      await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t2.id, items: [line(s.menu.cola.id)], version: first.version }, first.id).expect(200);
      expect([await status(s.menu.t1.id), await status(s.menu.t2.id)]).toEqual(['FREE', 'OCCUPIED']);

      await s.owner.post(`/orders/${first.id}/cancel`, { reason: 'Guests left' }).expect(200);
      expect(await status(s.menu.t2.id)).toBe('FREE');
    });
  });

  describe('discounts', () => {
    it('lets a cashier discount up to the limit and applies it before tax', async () => {
      const response = await saveOrder(s.cashier, {
        items: [line(s.menu.paneer.id, 2)], discount: { type: 'PERCENT', value: 1000, reason: 'Regular guest' },
      });
      expect(response.status).toBe(200);
      expect(response.body.discount).toMatchObject({ type: 'PERCENT', value: 1000, amountPaise: 5200, reason: 'Regular guest' });
      // 520 − 52 = 468 taxable, 23.40 GST → 491.40, rounded to 491.
      expect(response.body.totals).toMatchObject({ discountPaise: 5200, taxPaise: 2340, roundOffPaise: -40, totalPaise: 49100 });
    });

    it('needs a manager PIN above the limit, and records who approved', async () => {
      const body = { items: [line(s.menu.paneer.id, 2)], discount: { type: 'PERCENT', value: 2500 } };
      const id = randomUUID();
      const blocked = await saveOrder(s.cashier, body, id);
      expect(blocked.status).toBe(403);
      expect(blocked.body).toMatchObject({ code: 'APPROVAL_REQUIRED', details: { permission: 'discount.above_cap' } });
      expect(await h.prisma.order.count()).toBe(0); // nothing was saved

      const wrongPin = await saveOrder(s.cashier, { ...body, approval: { userId: s.fx.owner.id, pin: '0000' } }, id);
      expect(wrongPin.body.code).toBe('APPROVAL_INVALID');
      const notAManager = await saveOrder(s.cashier, { ...body, approval: { userId: s.fx.cashier.id, pin: CASHIER_PIN } }, id);
      expect(notAManager.body.code).toBe('APPROVAL_INVALID');

      const approved = await saveOrder(s.cashier, { ...body, approval: s.ownerApproval }, id);
      expect(approved.status).toBe(200);
      const row = await h.prisma.discount.findFirstOrThrow();
      expect(row).toMatchObject({ appliedById: s.fx.cashier.id, approvedById: s.fx.owner.id, amountPaise: 13000 });

      // Once approved, later saves of the same order do not ask again.
      const later = await saveOrder(s.cashier, { ...body, items: [...body.items, line(s.menu.cola.id)], version: approved.body.version }, id);
      expect(later.status).toBe(200);
      expect((await h.prisma.discount.findFirstOrThrow()).approvedById).toBe(s.fx.owner.id);
    });

    it('checks a rupee discount and a line discount against the same limit', async () => {
      // ₹60 off a ₹520 bill is 11.5%: above the 10% limit.
      expect((await saveOrder(s.cashier, { items: [line(s.menu.paneer.id, 2)], discount: { type: 'AMOUNT', value: 6000 } })).body.code).toBe('APPROVAL_REQUIRED');
      expect((await saveOrder(s.cashier, { items: [line(s.menu.paneer.id, 2)], discount: { type: 'AMOUNT', value: 5200 } })).status).toBe(200);
      const lineDiscount = await saveOrder(s.cashier, { items: [line(s.menu.paneer.id, 1, { discount: { type: 'PERCENT', value: 5000 } }), line(s.menu.cola.id, 10)] });
      expect(lineDiscount.body.code).toBe('APPROVAL_REQUIRED');
      const owner = await saveOrder(s.owner, { items: [line(s.menu.paneer.id, 1, { discount: { type: 'PERCENT', value: 10000 } })] });
      expect(owner.body.totals).toMatchObject({ discountPaise: 26000, totalPaise: 0 });
    });

    it('locks out manager approval after repeated wrong PINs', async () => {
      const body = { items: [line(s.menu.paneer.id)], discount: { type: 'PERCENT', value: 5000 }, approval: { userId: s.fx.owner.id, pin: '0000' } };
      for (let attempt = 0; attempt < 5; attempt += 1) expect((await saveOrder(s.cashier, body)).body.code).toBe('APPROVAL_INVALID');
      const locked = await saveOrder(s.cashier, { ...body, approval: s.ownerApproval });
      expect(locked.status).toBe(429);
      expect(locked.body.code).toBe('APPROVAL_LOCKED');
    });
  });

  describe('hold, cancel and merge', () => {
    it('holds an order and resumes it', async () => {
      const order = (await saveOrder(s.cashier, { items: [line(s.menu.paneer.id)] })).body;
      expect((await s.cashier.post(`/orders/${order.id}/hold`).expect(200)).body.status).toBe('HELD');
      const running = (await s.cashier.get('/orders/running').expect(200)).body as { id: string; status: string; itemCount: number }[];
      expect(running).toMatchObject([{ id: order.id, status: 'HELD', itemCount: 1 }]);
      expect((await s.cashier.post(`/orders/${order.id}/resume`).expect(200)).body.status).toBe('OPEN');

      const empty = (await saveOrder(s.cashier, { items: [] })).body;
      expect((await s.cashier.post(`/orders/${empty.id}/hold`)).body.code).toBe('ORDER_EMPTY');
    });

    it('cancels with a reason; a cashier needs a manager to approve', async () => {
      const order = (await saveOrder(s.cashier, { items: [line(s.menu.paneer.id)] })).body;
      expect((await s.cashier.post(`/orders/${order.id}/cancel`, { reason: 'Customer walked out' })).body.code).toBe('APPROVAL_REQUIRED');
      expect((await s.cashier.post(`/orders/${order.id}/cancel`, {})).status).toBe(400);

      const cancelled = await s.cashier.post(`/orders/${order.id}/cancel`, { reason: 'Customer walked out', approval: s.ownerApproval });
      expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Customer walked out' });
      expect((await saveOrder(s.cashier, { items: [], version: cancelled.body.version }, order.id)).body.code).toBe('ORDER_LOCKED');
      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'order.cancelled' } });
      expect(audit).toMatchObject({ userId: s.fx.cashier.id, reason: 'Customer walked out', after: { approvedBy: s.fx.owner.id } });
    });

    it('merges one order into another, moving its lines and freeing its table', async () => {
      const target = (await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.paneer.id)] })).body;
      const source = (await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t2.id, items: [line(s.menu.cola.id, 2, { discount: { type: 'AMOUNT', value: 500 } })] })).body;

      const merged = await s.cashier.post(`/orders/${target.id}/merge`, { sourceOrderId: source.id });
      expect(merged.status).toBe(200);
      expect(merged.body.items.map((i: { name: string; quantity: number; discountPaise: number }) => [i.name, i.quantity, i.discountPaise]))
        .toEqual([['Paneer Tikka', 1, 0], ['Cola', 2, 500]]);
      expect(merged.body.totals.grossPaise).toBe(36000);
      expect((await s.cashier.get(`/orders/${source.id}`)).body).toMatchObject({ status: 'MERGED', items: [], totals: { totalPaise: 0 } });
      expect((await h.prisma.diningTable.findUniqueOrThrow({ where: { id: s.menu.t2.id } })).status).toBe('FREE');
      expect((await s.cashier.post(`/orders/${target.id}/merge`, { sourceOrderId: target.id })).status).toBe(422);
    });
  });

  describe('deleting and renumbering', () => {
    const three = async () => {
      const orders = [];
      for (let i = 0; i < 3; i += 1) orders.push((await saveOrder(s.cashier, { items: [line(s.menu.cola.id, i + 1)] })).body);
      return orders as { id: string; orderNumber: number }[];
    };
    const numbers = async () =>
      ((await s.owner.get('/orders')).body.items as { orderNumber: number; tokenNumber: number; totals: { grossPaise: number } }[])
        .map((o) => [o.orderNumber, o.tokenNumber, o.totals.grossPaise]).sort((a, b) => a[0]! - b[0]!);

    it('closes the gap when an unbilled order is deleted: 1, 2, 3 becomes 1, 2', async () => {
      const [, second, third] = await three();
      const result = await s.owner.post(`/orders/${second!.id}/delete`, { reason: 'Entered by mistake' });
      expect(result.status).toBe(200);
      expect(result.body.changes).toEqual([{ orderId: third!.id, from: 3, to: 2 }]);

      // The third order is now number 2. Its token number, already given to the customer, stays 3.
      expect(await numbers()).toEqual([[1, 1, 5000], [2, 3, 15000]]);
      // The next order continues from the new end of the list.
      expect((await saveOrder(s.cashier, { items: [line(s.menu.cola.id)] })).body.orderNumber).toBe(3);

      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'order.deleted' } });
      expect(audit).toMatchObject({ userId: s.fx.owner.id, reason: 'Entered by mistake', before: { number: 'A1-2', totalPaise: 11800 } });
      expect((audit.after as { renumbered: unknown[] }).renumbered).toEqual([{ orderId: third!.id, from: 3, to: 2 }]);
    });

    it('needs a reason, and a manager when a cashier deletes', async () => {
      const [first] = await three();
      expect((await s.owner.post(`/orders/${first!.id}/delete`, {})).status).toBe(400);
      expect((await s.cashier.post(`/orders/${first!.id}/delete`, { reason: 'Test' })).body.code).toBe('APPROVAL_REQUIRED');
      await s.cashier.post(`/orders/${first!.id}/delete`, { reason: 'Test', approval: s.ownerApproval }).expect(200);
      expect(await numbers()).toEqual([[1, 2, 10000], [2, 3, 15000]]);
    });

    it('does not let a cashier delete a billed order, with or without the right to delete orders', async () => {
      const [first] = await three();
      await s.cashier.post(`/orders/${first!.id}/invoices`, {}).expect(201);
      // Deleting a billed order erases its bill, which is a right of its own; corrections.int-spec covers it.
      const response = await s.cashier.post(`/orders/${first!.id}/delete`, { reason: 'Hide the sale' });
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'APPROVAL_REQUIRED', details: { permission: 'invoice.delete' } });
      expect(await h.prisma.order.count()).toBe(3);
      expect(await h.prisma.invoice.count()).toBe(1);
    });

    it('leaves the gap in manual mode until numbers are reset by hand', async () => {
      await s.owner.patch('/settings', { orderRenumberMode: 'MANUAL' }).expect(200);
      const [first] = await three();
      expect((await s.owner.post(`/orders/${first!.id}/delete`, { reason: 'Mistake' })).body.changes).toEqual([]);
      expect((await numbers()).map((n) => n[0])).toEqual([2, 3]);

      expect((await s.cashier.post('/orders/renumber')).status).toBe(403);
      const reset = await s.owner.post('/orders/renumber').expect(200);
      expect(reset.body.changes.map((c: { from: number; to: number }) => [c.from, c.to])).toEqual([[2, 1], [3, 2]]);
      expect((await numbers()).map((n) => n[0])).toEqual([1, 2]);
      // Running it again changes nothing.
      expect((await s.owner.post('/orders/renumber')).body.changes).toEqual([]);
    });

    it('does nothing when renumbering is switched off', async () => {
      await s.owner.patch('/settings', { orderRenumberMode: 'OFF' }).expect(200);
      const [first] = await three();
      await s.owner.post(`/orders/${first!.id}/delete`, { reason: 'Mistake' }).expect(200);
      expect((await numbers()).map((n) => n[0])).toEqual([2, 3]);
      expect((await s.owner.post('/orders/renumber')).body.code).toBe('RENUMBER_OFF');
    });

    it('restarts numbering from 1 on request, keeping earlier orders', async () => {
      await three();
      await s.owner.post('/orders/restart-numbering').expect(204);
      const next = (await saveOrder(s.cashier, { items: [line(s.menu.cola.id)] })).body;
      expect(next.orderNumber).toBe(1);
      expect(await h.prisma.order.count()).toBe(4);
    });

    it('keeps numbers unique when an order is created while another is deleted', async () => {
      const [first] = await three();
      const [, created] = await Promise.all([
        s.owner.post(`/orders/${first!.id}/delete`, { reason: 'Mistake' }),
        saveOrder(s.cashier, { items: [line(s.menu.cola.id)] }),
      ]);
      expect(created.status).toBe(200);
      expect((await numbers()).map((n) => n[0])).toEqual([1, 2, 3]);
    });
  });

  describe('visibility', () => {
    it('shows a cashier only their own orders in history, and the owner everything', async () => {
      await saveOrder(s.cashier, { items: [line(s.menu.cola.id)] }).expect(200);
      await saveOrder(s.owner, { items: [line(s.menu.paneer.id)] }).expect(200);
      expect((await s.cashier.get('/orders')).body.total).toBe(1);
      expect((await s.owner.get('/orders')).body.total).toBe(2);
      expect((await s.owner.get('/orders?type=DINE_IN')).body.total).toBe(0);
      expect((await s.owner.get('/orders?search=2')).body.items.map((o: { orderNumber: number }) => o.orderNumber)).toEqual([2]);
    });

    it('keeps orders private to their restaurant', async () => {
      const other = await scene(h, 'b');
      const theirs = (await saveOrder(other.cashier, { items: [line(other.menu.cola.id)] })).body;
      expect((await s.owner.get(`/orders/${theirs.id}`)).status).toBe(404);
      expect((await saveOrder(s.owner, { items: [line(s.menu.cola.id)] }, theirs.id)).status).toBe(404);
      expect((await s.owner.post(`/orders/${theirs.id}/delete`, { reason: 'x' })).status).toBe(404);
      expect((await saveOrder(s.cashier, { items: [line(other.menu.cola.id)] })).body.code).toBe('ITEM_NOT_FOUND');
      // Both restaurants number their own orders from 1.
      expect((await saveOrder(s.cashier, { items: [line(s.menu.cola.id)] })).body.displayNumber).toBe('A1-1');
    });

    it('gives the POS its menu, tables and terminal in one request', async () => {
      const boot = (await s.cashier.get('/pos/bootstrap').expect(200)).body;
      expect(boot.terminal).toMatchObject({ code: 'A1' });
      expect(boot.products.map((p: { name: string }) => p.name).sort()).toEqual(['Cola', 'Paneer Tikka', 'Tandoori Chicken', 'Veg Biryani']);
      expect(boot.tables).toHaveLength(2);
      expect(boot.modifierGroups).toHaveLength(2);
      expect(boot.settings.discountCapBps).toBe(1000);
      expect(boot.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
