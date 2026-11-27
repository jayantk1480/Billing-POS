import { randomUUID } from 'node:crypto';
import { businessDateOf } from '@pos/billing-core';
import { billed, line, pay, saveOrder, type Scene, scene } from './support/billing.js';
import { createHarness, type Harness, type TestClient } from './support/harness.js';

const TODAY = businessDateOf(new Date());
const range = 'from=' + TODAY + '&to=' + TODAY;
type Report = { summary: { label: string; value: number }[]; rows: Record<string, unknown>[] };

/** One test for each bug the independent testers found, so none of them comes back. */
describe('regressions', () => {
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

  const order = async (id: string, client: TestClient = s.owner) => (await client.get(`/orders/${id}`).expect(200)).body;
  const bill = async (id: string) => (await s.owner.get(`/invoices/${id}`).expect(200)).body;
  async function paidBill(items: object[] = [line(s.menu.paneer.id, 1)], method = 'CASH', body: object = {}) {
    const made = await billed(s.cashier, items, body);
    const paid = (await pay(s.cashier, made.invoice.id, [{ method, amountPaise: made.invoice.totalPaise }]).expect(200)).body;
    return { ...made, paid };
  }
  const keep = (item: { id: string; productId: string; variantId: string | null; modifiers: { id: string }[]; quantity: number }, quantity = item.quantity) =>
    ({ id: item.id, productId: item.productId, variantId: item.variantId, modifierIds: item.modifiers.map((m) => m.id), quantity });
  const report = async (type: string): Promise<Report> => (await s.owner.get(`/reports/${type}?${range}`).expect(200)).body;
  const figure = (r: Report, label: string) => r.summary.find((entry) => entry.label === label)?.value;
  const refund = (invoiceId: string, paymentId: string, amountPaise: number) =>
    s.owner.post(`/invoices/${invoiceId}/refunds`, { id: randomUUID(), paymentId, amountPaise, reason: 'Cold food' });

  describe('two changes to the same order at once', () => {
    it('never leaves an open order with a bill still standing', async () => {
      for (let round = 0; round < 8; round += 1) {
        const made = await paidBill();
        const item = (await order(made.order.id)).items[0];
        const results = await Promise.all([
          s.owner.post(`/orders/${made.order.id}/amend`, { items: [keep(item, 2)], payment: { method: 'UPI' }, reason: 'amend' }),
          new Promise((resolve) => setTimeout(resolve, round)).then(() => s.owner.post(`/orders/${made.order.id}/reopen`, { reason: 'reopen' })),
        ]);
        expect(results.every((result) => result.status < 500), JSON.stringify(results.map((result) => result.body?.code))).toBe(true);
        const after = await h.prisma.order.findUniqueOrThrow({ where: { id: made.order.id }, include: { invoices: { where: { status: 'ISSUED' } } } });
        // Whichever ran second saw what the first did: either the order is open with no bill, or billed with exactly one.
        expect(after.status === 'OPEN' ? after.invoices.length : 1).toBe(after.status === 'OPEN' ? 0 : after.invoices.length);
      }
    });

    it('answers a refund racing a correction without a server error, and loses no payment from the audit entry', async () => {
      for (let round = 0; round < 6; round += 1) {
        const made = await paidBill([line(s.menu.paneer.id, 2)]);
        const results = await Promise.all([
          refund(made.invoice.id, made.paid.payments[0].id, 500),
          s.owner.post(`/orders/${made.order.id}/${round % 2 === 0 ? 'reopen' : 'delete'}`, { reason: 'at the same moment' }),
        ]);
        expect(results.map((result) => result.status).filter((status) => status >= 500)).toEqual([]);
      }
      // A payment landing while its bill is being erased is either refused or recorded as erased.
      for (let round = 0; round < 6; round += 1) {
        const made = await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
        const [reopened, paid] = await Promise.all([
          s.owner.post(`/orders/${made.order.id}/reopen`, { reason: `race ${round}` }),
          pay(s.cashier, made.invoice.id, [{ method: 'CASH', amountPaise: 27300 }]),
        ]);
        expect([reopened.status, paid.status].filter((status) => status >= 500)).toEqual([]);
        if (reopened.status === 200 && paid.status === 200) {
          const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'order.reopened', reason: `race ${round}` } });
          expect((audit.before as { bills: { payments: unknown[] }[] }).bills[0]!.payments).toHaveLength(1);
        }
        expect(await h.prisma.payment.count({ where: { invoiceId: made.invoice.id } })).toBe(0);
      }
    });
  });

  it('lets an item be removed after its bill was cancelled and the order reopened', async () => {
    const paneer = line(s.menu.paneer.id);
    const cola = line(s.menu.cola.id);
    const made = (await saveOrder(s.cashier, { items: [paneer, cola] }).expect(200)).body;
    const [invoice] = (await s.cashier.post(`/orders/${made.id}/invoices`, {}).expect(201)).body;
    await s.owner.post(`/invoices/${invoice.id}/cancel`, { reason: 'Cola was not served', reopenOrder: true }).expect(200);
    const reopened = await order(made.id);
    const saved = await saveOrder(s.owner, { items: [paneer], version: reopened.version, kotCancelReason: 'Not served' }, made.id);
    expect(saved.status).toBe(200);
    expect(saved.body.items).toHaveLength(1);
    // The cancelled bill still lists both items, as it was issued.
    expect((await bill(invoice.id)).items).toHaveLength(2);
    await expect(h.prisma.invoiceItem.updateMany({ where: { invoiceId: invoice.id }, data: { totalPaise: 1 } })).rejects.toThrow(/append-only/);
  });

  it('finds orders by phone number, by the order number as shown, and by bill number', async () => {
    const made = await paidBill([line(s.menu.paneer.id, 1)], 'CASH', { customer: { name: 'Asha', phone: '9800000001' } });
    await paidBill([line(s.menu.cola.id, 1)]);
    const found = async (search: string) => ((await s.owner.get('/orders?search=' + encodeURIComponent(search)).expect(200)).body.items as { id: string }[]).map((row) => row.id);
    expect(await found('9800000001')).toEqual([made.order.id]);
    expect(await found('A1-1')).toEqual([made.order.id]);
    expect(await found('a1-1')).toEqual([made.order.id]);
    expect(await found(made.invoice.invoiceNumber)).toEqual([made.order.id]);
    expect(await found('99999999999999999999')).toEqual([]);
  });

  describe('changing a billed order keeps what the bill said', () => {
    it('keeps the customer and the seller as they were on the bill', async () => {
      const made = await paidBill([line(s.menu.paneer.id, 1)], 'CASH', { customer: { name: 'Asha Traders', phone: '9800000001', address: 'Pune' } });
      // A later order reuses the phone number under another name, and the restaurant is renamed.
      await paidBill([line(s.menu.cola.id, 1)], 'CASH', { customer: { name: 'Ravi', phone: '9800000001' } });
      await s.owner.patch('/restaurant', { name: 'Renamed Restaurant' }).expect(200);
      const item = (await order(made.order.id)).items[0];
      const amended = (await s.owner.post(`/orders/${made.order.id}/amend`, { items: [keep(item, 2)], payment: { method: 'CASH' }, reason: 'Two were served' }).expect(200)).body;
      expect(await bill(amended.invoices[0].id)).toMatchObject({
        customer: { name: 'Asha Traders', phone: '9800000001', address: 'Pune' }, seller: { name: 'Test Restaurant A' }, totalPaise: 54600,
      });
    });

    it('keeps the tax rates its lines were billed at, and uses today\'s rates for lines that are new', async () => {
      const made = await paidBill([line(s.menu.paneer.id, 2)]);   // 52000 + 5% = 54600
      await h.prisma.taxComponent.updateMany({ where: { taxGroupId: s.fx.taxGroup.id, type: { in: ['CGST', 'SGST'] } }, data: { rateBps: 600 } });
      await h.prisma.taxComponent.updateMany({ where: { taxGroupId: s.fx.taxGroup.id, type: 'IGST' }, data: { rateBps: 1200 } });
      const item = (await order(made.order.id)).items[0];
      const amended = (await s.owner.post(`/orders/${made.order.id}/amend`, {
        items: [keep(item, 3), line(s.menu.paneer.id, 1)], payment: { method: 'CASH' }, reason: 'One more, and one added separately',
      }).expect(200)).body;
      // The line that was on the bill keeps 5%; the line added today is charged today's 12%.
      const lines = (await bill(amended.invoices[0].id)).items as { quantity: number; taxRateBps: number }[];
      expect(lines.map((entry) => [entry.quantity, entry.taxRateBps])).toEqual([[3, 500], [1, 1200]]);
    });
  });

  describe('what happens to the money when a billed order is changed', () => {
    it('keeps a part payment as it was, leaving the rest due', async () => {
      const made = await billed(s.cashier, [line(s.menu.paneer.id, 2)]);   // 54600
      await pay(s.cashier, made.invoice.id, [{ method: 'CASH', amountPaise: 10000 }]).expect(200);
      const item = (await order(made.order.id)).items[0];
      const amended = (await s.owner.post(`/orders/${made.order.id}/amend`, { items: [keep(item, 3)], payment: 'KEEP', reason: 'Three were served' }).expect(200)).body;
      expect(amended).toMatchObject({ status: 'BILLED', paymentMethods: ['CASH'], totals: { totalPaise: 81900 } });
      expect(amended.invoices[0]).toMatchObject({ invoiceNumber: made.invoice.invoiceNumber, paymentStatus: 'PARTIALLY_PAID', paidPaise: 10000 });
    });

    it('keeps a bill paid two ways as two payments, and says so when they come to more than the new total', async () => {
      const made = await billed(s.cashier, [line(s.menu.paneer.id, 2)]);   // 54600
      await pay(s.cashier, made.invoice.id, [{ method: 'UPI', amountPaise: 30000, reference: 'UPI-1' }, { method: 'CARD', amountPaise: 24600 }]).expect(200);
      const item = (await order(made.order.id)).items[0];

      const fewer = await s.owner.post(`/orders/${made.order.id}/amend`, { items: [keep(item, 1)], payment: 'KEEP', reason: 'Only one was served' });
      expect(fewer.status).toBe(422);
      expect(fewer.body.code).toBe('PAYMENTS_EXCEED_TOTAL');
      expect(await bill(made.invoice.id)).toMatchObject({ totalPaise: 54600, paidPaise: 54600 });

      const more = (await s.owner.post(`/orders/${made.order.id}/amend`, { items: [keep(item, 3)], payment: 'KEEP', reason: 'Three were served' }).expect(200)).body;
      expect(more).toMatchObject({ status: 'BILLED', paymentMethods: ['UPI', 'CARD'] });
      const payments = (await bill(more.invoices[0].id)).payments as { method: string; amountPaise: number; reference: string | null }[];
      expect(payments.map((payment) => [payment.method, payment.amountPaise, payment.reference])).toEqual([['UPI', 30000, 'UPI-1'], ['CARD', 24600, null]]);
    });
  });

  it('does not let a discount slip past the limit by shrinking the order under it', async () => {
    const paneer = line(s.menu.paneer.id, 10);
    const made = (await saveOrder(s.cashier, { items: [paneer], discount: { type: 'AMOUNT', value: 10000 } }).expect(200)).body;   // 3.8%
    const reduced = await saveOrder(s.cashier, { items: [{ ...paneer, quantity: 1 }], discount: { type: 'AMOUNT', value: 10000 }, version: made.version }, made.id);
    expect(reduced.status).toBe(403);
    expect(reduced.body).toMatchObject({ code: 'APPROVAL_REQUIRED', details: { permission: 'discount.above_cap' } });
    // With a manager's approval it stands, and does not need approving again on the next save.
    const approved = (await saveOrder(s.cashier, { items: [{ ...paneer, quantity: 1 }], discount: { type: 'AMOUNT', value: 10000 }, version: made.version, approval: s.ownerApproval }, made.id).expect(200)).body;
    await saveOrder(s.cashier, { items: [{ ...paneer, quantity: 1 }, line(s.menu.cola.id, 1)], discount: { type: 'AMOUNT', value: 10000 }, version: approved.version }, made.id).expect(200);
  });

  it('answers dates that do not exist, and absurd orders, with a validation error', async () => {
    for (const path of [
      '/reports/sales-daily?from=2026-02-30&to=2026-02-30', '/reports/gst?from=2026-04-31&to=2026-04-31',
      '/reports/sales-daily/export?from=2026-02-30&to=2026-02-30&format=csv', '/orders?from=2026-13-45', '/invoices?to=2026-13-45', '/invoices?from=0000-00-00',
    ]) {
      expect((await s.owner.get(path)).status, path).toBe(400);
    }
    const huge = await saveOrder(s.cashier, { items: Array.from({ length: 100 }, () => line(s.menu.paneer.id, 999)) });   // ₹2.6 crore
    expect(huge.status).toBe(422);
    expect(huge.body.code).toBe('ORDER_TOO_LARGE');
  });

  it('does not let another restaurant lock this one\'s owner out of approvals', async () => {
    const made = await paidBill();
    const other = await scene(h, 'b');
    const theirs = await billed(other.cashier, [line(other.menu.cola.id, 1)]);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await other.cashier.post(`/orders/${theirs.order.id}/reopen`, { reason: 'x', approval: { userId: s.fx.owner.id, pin: '0000' } });
    }
    await s.cashier.post(`/orders/${made.order.id}/reopen`, { reason: 'Owner agreed', approval: s.ownerApproval }).expect(200);
  });

  it('takes a refunded-then-cancelled bill out of sales once, not twice', async () => {
    await paidBill([line(s.menu.paneer.id, 1)], 'UPI');                       // 27300, stays
    const gone = await paidBill([line(s.menu.cola.id, 1)], 'CASH');           // 5900, refunded and cancelled
    await refund(gone.invoice.id, gone.paid.payments[0].id, 5900).expect(200);
    await s.owner.post(`/invoices/${gone.invoice.id}/cancel`, { reason: 'Guest left' }).expect(200);

    const daily = await report('sales-daily');
    expect(figure(daily, 'Total sales amount')).toBe(27300);
    expect(figure(daily, 'Cash')).toBe(0);
    expect(figure(daily, 'UPI')).toBe(27300);
    expect(figure(daily, 'Net sales after refunds')).toBe(27300);
    expect((await s.owner.get('/dashboard').expect(200)).body.sales).toMatchObject({ totalPaise: 27300, refundsPaise: 0, netPaise: 27300 });
    expect((await report('refunds')).rows).toHaveLength(0);
    expect((await report('payments')).rows).toHaveLength(1);
    // The cancelled bill and its credit note are still on record.
    expect((await report('cancellations')).rows).toHaveLength(1);
    expect(await h.prisma.refund.count()).toBe(1);
  });

  it('refuses a payment-method change on a cancelled bill', async () => {
    const made = await paidBill();
    await refund(made.invoice.id, made.paid.payments[0].id, 27300).expect(200);
    await s.owner.post(`/invoices/${made.invoice.id}/cancel`, { reason: 'Guest left' }).expect(200);
    const changed = await s.owner.patch(`/invoices/${made.invoice.id}/payments/${made.paid.payments[0].id}`, { method: 'UPI', reason: 'Too late' });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('INVOICE_CANCELLED');
  });

  it('lets a role that may only look at order history open orders and bills, and nothing more', async () => {
    const made = await paidBill();
    const role = (await s.owner.post('/roles', { name: 'Auditor', permissions: ['backoffice.access', 'order.view_all'] }).expect(201)).body;
    await s.owner.post('/users', { name: 'Anil Auditor', email: 'auditor@test.local', roleId: role.id, password: 'a long enough password' }).expect(201);
    const auditor = h.client();
    await auditor.login('auditor@test.local', 'a long enough password');
    expect((await auditor.get('/orders?' + range).expect(200)).body.items).toHaveLength(1);
    await auditor.get(`/orders/${made.order.id}`).expect(200);
    expect((await auditor.get('/invoices?' + range).expect(200)).body.items).toHaveLength(1);
    await auditor.get(`/invoices/${made.invoice.id}`).expect(200);
    await auditor.get(`/invoices/${made.invoice.id}/pdf`).expect(200);
    expect((await saveOrder(auditor, { items: [line(s.menu.cola.id, 1)] })).status).toBe(403);
    expect((await auditor.get('/orders/running')).status).toBe(403);
    expect((await auditor.post(`/orders/${made.order.id}/invoices`, {})).status).toBe(403);
    expect((await pay(auditor, made.invoice.id, [{ method: 'CASH', amountPaise: 100 }])).status).toBe(403);
    // The cashier, who has neither permission for bills beyond their own counter work, is unchanged.
    await s.cashier.get(`/invoices/${made.invoice.id}`).expect(200);
  });

  it('takes cancelled quantities off the kitchen tickets, and finishes a ticket with nothing left on it', async () => {
    await h.prisma.product.updateMany({ where: { id: { in: [s.menu.paneer.id, s.menu.cola.id] } }, data: { stationId: s.fx.station.id } });
    const paneer = line(s.menu.paneer.id, 3);
    const cola = line(s.menu.cola.id, 1);
    const made = (await saveOrder(s.cashier, { items: [paneer, cola] }).expect(200)).body;
    await s.cashier.post(`/orders/${made.id}/kots`, {}).expect(200);
    const tickets = async () => (await s.owner.get('/kots?scope=today').expect(200)).body as { type: string; status: string; items: { name: string; quantity: number; cancelledQuantity: number }[] }[];

    // One of three paneer is taken back: the ticket stays, with two left to make.
    const less = (await saveOrder(s.owner, { items: [{ ...paneer, quantity: 2 }, cola], version: made.version, kotCancelReason: 'Guest changed mind' }, made.id).expect(200)).body;
    let original = (await tickets()).find((ticket) => ticket.type === 'NEW')!;
    expect(original.status).toBe('PENDING');
    const state = (ticket: typeof original) => ticket.items.map((item) => [item.name, item.quantity, item.cancelledQuantity]).sort();
    expect(state(original)).toEqual([['Cola', 1, 0], ['Paneer Tikka', 3, 1]]);

    // The whole order is cancelled: nothing is left on the ticket, so it is no longer work to do.
    await s.owner.post(`/orders/${less.id}/cancel`, { reason: 'Guests left' }).expect(200);
    original = (await tickets()).find((ticket) => ticket.type === 'NEW')!;
    expect(original.status).toBe('COMPLETED');
    // It has left the list of work still to do.
    expect(((await s.owner.get('/kots').expect(200)).body as { type: string }[]).filter((ticket) => ticket.type === 'NEW')).toHaveLength(0);
    expect(state(original)).toEqual([['Cola', 1, 1], ['Paneer Tikka', 3, 3]]);
    expect((await tickets()).filter((ticket) => ticket.type === 'CANCEL')).toHaveLength(2);
  });

  it('shows the methods of a bill paid two ways in the same order every time', async () => {
    for (let round = 0; round < 12; round += 1) {
      const made = await billed(s.cashier, [line(s.menu.cola.id, 1)]);
      await pay(s.cashier, made.invoice.id, [{ method: 'UPI', amountPaise: 2900 }, { method: 'CASH', amountPaise: 3000 }]).expect(200);
    }
    const methods = new Set((await report('orders')).rows.map((row) => row.method ?? row.paymentMethod));
    expect([...methods]).toEqual(['Cash + UPI']);
  });
});
