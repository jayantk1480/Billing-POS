import { randomUUID } from 'node:crypto';
import { businessDateOf } from '@pos/billing-core';
import { billed, FY, line, pay, saveOrder, type Scene, scene } from './support/billing.js';
import { createHarness, type Harness } from './support/harness.js';

const TODAY = businessDateOf(new Date());
const range = 'from=' + TODAY + '&to=' + TODAY;

/** The owner's corrections: changing how a bill was paid, and deleting or reopening an order that was billed. */
describe('owner corrections', () => {
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

  /** A paneer tikka, billed and paid in full by cash: ₹273. */
  async function paidBill(method = 'CASH', options: { kot?: boolean } = {}) {
    const made = options.kot ? await billedAfterKot([line(s.menu.paneer.id, 1)]) : await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
    await pay(s.cashier, made.invoice.id, [{ method, amountPaise: 27300, ...(method === 'CASH' ? { tenderedPaise: 30000 } : {}) }]).expect(200);
    return made;
  }
  /** As at a counter that pressed KOT before billing: the kitchen has the order. */
  async function billedAfterKot(items: object[]) {
    const order = (await saveOrder(s.cashier, { items }).expect(200)).body;
    await s.cashier.post(`/orders/${order.id}/kots`).expect(200);
    const [invoice] = (await s.cashier.post(`/orders/${order.id}/invoices`, {}).expect(201)).body;
    return { order, invoice };
  }
  const summary = async (type: string) => (await s.owner.get(`/reports/${type}?${range}`).expect(200)).body as { rows: Record<string, unknown>[]; summary: { label: string; value: number }[] };
  const figure = (report: { summary: { label: string; value: number }[] }, label: string) => report.summary.find((entry) => entry.label === label)?.value;
  const nextBillNumber = async () => (await billed(s.cashier, [line(s.menu.cola.id, 1)])).invoice.invoiceNumber as string;

  describe('changing the payment method of a settled bill', () => {
    it('moves the payment to the new method, in the bill and in the reports, without touching the amount', async () => {
      const { order, invoice } = await paidBill('CASH');
      expect(figure(await summary('sales-daily'), 'Cash')).toBe(27300);
      expect((await s.owner.get(`/orders/${order.id}`).expect(200)).body.paymentMethods).toEqual(['CASH']);
      const payment = await h.prisma.payment.findFirstOrThrow();

      const changed = await s.owner.patch(`/invoices/${invoice.id}/payments/${payment.id}`, { method: 'UPI', reference: 'UPI-9981', reason: 'Guest paid by UPI' });
      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({ paymentStatus: 'PAID', paidPaise: 27300, totalPaise: 27300, invoiceNumber: invoice.invoiceNumber });
      // Cash handed over and change belong to a cash payment only.
      expect(changed.body.payments).toEqual([expect.objectContaining({ id: payment.id, method: 'UPI', amountPaise: 27300, reference: 'UPI-9981', tenderedPaise: null, changePaise: null })]);

      const daily = await summary('sales-daily');
      expect(figure(daily, 'Cash')).toBe(0);
      expect(figure(daily, 'UPI')).toBe(27300);
      expect(figure(daily, 'Total sales amount')).toBe(27300);
      // The order list shows how each order was paid.
      const listed = (await s.owner.get(`/orders?${range}`).expect(200)).body.items as { id: string; paymentMethods: string[] }[];
      expect(listed.find((row) => row.id === order.id)!.paymentMethods).toEqual(['UPI']);

      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'payment.method_changed' } });
      expect(audit).toMatchObject({
        userId: s.fx.owner.id, entityId: invoice.id, reason: 'Guest paid by UPI',
        before: { invoiceNumber: invoice.invoiceNumber, amountPaise: 27300, method: 'CASH' }, after: { method: 'UPI', reference: 'UPI-9981' },
      });
    });

    it('is refused without the permission, without a reason, for the same method and for another bill', async () => {
      const { invoice } = await paidBill('CASH');
      const other = await paidBill('CARD');
      const payment = await h.prisma.payment.findFirstOrThrow({ where: { invoiceId: invoice.id } });
      const path = `/invoices/${invoice.id}/payments/${payment.id}`;

      expect((await s.cashier.patch(path, { method: 'UPI', reason: 'Wrong button' })).status).toBe(403);
      expect((await s.owner.patch(path, { method: 'UPI' })).status).toBe(400);
      expect((await s.owner.patch(path, { method: 'CHEQUE', reason: 'x' })).status).toBe(400);
      expect((await s.owner.patch(path, { method: 'CASH', reason: 'Nothing to change' })).body.code).toBe('SAME_METHOD');
      // A payment is changed through its own bill only.
      expect((await s.owner.patch(`/invoices/${other.invoice.id}/payments/${payment.id}`, { method: 'UPI', reason: 'Mix-up' })).status).toBe(404);
      expect((await h.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).method).toBe('CASH');
      expect(await h.prisma.auditLog.count({ where: { action: 'payment.method_changed' } })).toBe(0);
    });

    it('leaves the database protection in force for everything else', async () => {
      const { invoice } = await paidBill('CASH');
      const payment = await h.prisma.payment.findFirstOrThrow();
      await s.owner.patch(`/invoices/${invoice.id}/payments/${payment.id}`, { method: 'CARD', reason: 'Card, not cash' }).expect(200);
      // The correction switched the protection off for its own transaction only.
      await expect(h.prisma.payment.update({ where: { id: payment.id }, data: { method: 'CASH' } })).rejects.toThrow(/cannot be modified/);
      await expect(h.prisma.payment.update({ where: { id: payment.id }, data: { amountPaise: 1 } })).rejects.toThrow(/cannot be modified/);
      await expect(h.prisma.payment.delete({ where: { id: payment.id } })).rejects.toThrow(/cannot be deleted/);
      await expect(h.prisma.invoice.delete({ where: { id: invoice.id } })).rejects.toThrow();
    });
  });

  it('lists how each order was paid: nothing until money is taken, then every method used', async () => {
    const unpaid = await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
    const split = await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
    await pay(s.cashier, split.invoice.id, [{ method: 'CARD', amountPaise: 7300 }, { method: 'CASH', amountPaise: 20000 }]).expect(200);
    const open = (await saveOrder(s.cashier, { items: [line(s.menu.cola.id, 1)] }).expect(200)).body;

    const rows = (await s.owner.get(`/orders?${range}`).expect(200)).body.items as { id: string; paymentMethods: string[] }[];
    const methods = (id: string) => rows.find((row) => row.id === id)!.paymentMethods;
    expect(methods(open.id)).toEqual([]);
    expect(methods(unpaid.order.id)).toEqual([]);
    expect(methods(split.order.id)).toEqual(['CASH', 'CARD']);
  });

  describe('deleting a billed order', () => {
    it('erases the order with its bill, payment and refund, from every list and report', async () => {
      const keep = await paidBill('UPI');
      const { order, invoice } = await paidBill('CASH');
      const payment = await h.prisma.payment.findFirstOrThrow({ where: { invoiceId: invoice.id } });
      await s.owner.post(`/invoices/${invoice.id}/refunds`, { id: randomUUID(), paymentId: payment.id, amountPaise: 5000, reason: 'Cold food' }).expect(200);
      expect(figure(await summary('sales-daily'), 'Total sales (receipts)')).toBe(2);

      const removed = await s.owner.post(`/orders/${order.id}/delete`, { reason: 'Test bill made while training' });
      expect(removed.status).toBe(200);

      expect(await h.prisma.order.count()).toBe(1);
      expect(await h.prisma.invoice.count()).toBe(1);
      expect(await h.prisma.invoiceItem.count({ where: { invoiceId: invoice.id } })).toBe(0);
      expect(await h.prisma.invoiceTax.count({ where: { invoiceId: invoice.id } })).toBe(0);
      expect(await h.prisma.payment.count()).toBe(1);
      expect(await h.prisma.refund.count()).toBe(0);
      expect(await h.prisma.kot.count({ where: { orderId: order.id } })).toBe(0);
      expect((await s.owner.get(`/invoices/${invoice.id}`)).status).toBe(404);
      expect((await s.owner.get(`/orders/${order.id}`)).status).toBe(404);
      expect((await s.owner.get(`/invoices?${range}`).expect(200)).body.items.map((bill: { invoiceNumber: string }) => bill.invoiceNumber)).toEqual([keep.invoice.invoiceNumber]);

      const daily = await summary('sales-daily');
      expect(figure(daily, 'Total sales (receipts)')).toBe(1);
      expect(figure(daily, 'Total sales amount')).toBe(27300);
      expect(figure(daily, 'Cash')).toBe(0);
      expect(figure(daily, 'UPI')).toBe(27300);
      expect((await summary('refunds')).rows).toHaveLength(0);
      expect((await s.owner.get('/dashboard').expect(200)).body.sales).toMatchObject({ totalPaise: 27300, bills: 1, refundsPaise: 0 });

      // What was removed is written down, once, where it cannot be edited.
      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'order.deleted' } });
      expect(audit).toMatchObject({
        userId: s.fx.owner.id, entityId: order.id, reason: 'Test bill made while training',
        before: {
          number: 'A1-2', status: 'SETTLED', totalPaise: 27300,
          bills: [{ invoiceNumber: invoice.invoiceNumber, totalPaise: 27300, paidPaise: 27300, payments: [{ method: 'CASH', amountPaise: 27300 }], refunds: [{ amountPaise: 5000 }] }],
        },
      });
      await expect(h.prisma.auditLog.delete({ where: { id: audit.id } })).rejects.toThrow(/append-only/);
    });

    it('moves the later bills up, so no bill number is missing', async () => {
      const first = await paidBill();
      const second = await paidBill();
      const third = await paidBill('UPI');
      const fourth = await paidBill();
      expect(fourth.invoice.invoiceNumber).toBe(`A1/${FY}/000004`);

      const removed = await s.owner.post(`/orders/${second.order.id}/delete`, { reason: 'Duplicate' }).expect(200);
      // Order numbers and bill numbers both close up.
      expect(removed.body.changes).toEqual([{ orderId: third.order.id, from: 3, to: 2 }, { orderId: fourth.order.id, from: 4, to: 3 }]);
      expect(removed.body.bills).toBe(2);
      const bills = await h.prisma.invoice.findMany({ orderBy: { number: 'asc' } });
      expect(bills.map((bill) => [bill.id, bill.number, bill.invoiceNumber])).toEqual([
        [first.invoice.id, 1, `A1/${FY}/000001`], [third.invoice.id, 2, `A1/${FY}/000002`], [fourth.invoice.id, 3, `A1/${FY}/000003`],
      ]);
      // A renumbered bill is the same bill in every other respect: same order, date, amount and payment.
      expect((await s.owner.get(`/invoices/${third.invoice.id}`).expect(200)).body).toMatchObject({
        invoiceNumber: `A1/${FY}/000002`, orderDisplayNumber: 'A1-2', issuedAt: third.invoice.issuedAt, totalPaise: 27300, paidPaise: 27300,
        payments: [expect.objectContaining({ method: 'UPI', amountPaise: 27300 })],
      });
      expect(await nextBillNumber()).toBe(`A1/${FY}/000004`);

      // The audit log says which numbers moved, since copies already printed carry the old ones.
      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'order.deleted' } });
      expect((audit.after as { billsRenumbered: unknown }).billsRenumbered).toEqual([{ series: `A1/${FY}`, count: 2, moved: [{ from: 3, to: 4, by: -1 }] }]);
      // The protection on bills is back in force afterwards.
      await expect(h.prisma.invoice.update({ where: { id: third.invoice.id }, data: { number: 9 } })).rejects.toThrow(/cannot be modified/);
    });

    it('closes gaps left from before as well, so the whole series is consecutive after a delete', async () => {
      // Gaps made while renumbering was manual: bills 1, 3, 5 remain of five.
      await s.owner.patch('/settings', { orderRenumberMode: 'MANUAL' }).expect(200);
      const made = [];
      for (let index = 0; index < 6; index += 1) made.push(await paidBill());
      await s.owner.post(`/orders/${made[1]!.order.id}/delete`, { reason: 'Old gap' }).expect(200);
      await s.owner.post(`/orders/${made[3]!.order.id}/delete`, { reason: 'Old gap' }).expect(200);
      expect((await h.prisma.invoice.findMany({ orderBy: { number: 'asc' } })).map((bill) => bill.number)).toEqual([1, 3, 5, 6]);

      // Back on automatic, the next delete of a billed order leaves no gap anywhere, even though it removed the last bill.
      await s.owner.patch('/settings', { orderRenumberMode: 'AUTO' }).expect(200);
      const removed = await s.owner.post(`/orders/${made[5]!.order.id}/delete`, { reason: 'Mistake' }).expect(200);
      expect(removed.body.bills).toBe(2);
      expect((await h.prisma.invoice.findMany({ orderBy: { number: 'asc' } })).map((bill) => [bill.id, bill.number])).toEqual([
        [made[0]!.invoice.id, 1], [made[2]!.invoice.id, 2], [made[4]!.invoice.id, 3],
      ]);
      expect(await nextBillNumber()).toBe(`A1/${FY}/000004`);
    });

    it('moves credit notes up in the same way when a refunded bill is deleted', async () => {
      const refundOf = async (made: { invoice: { id: string } }) => {
        const payment = await h.prisma.payment.findFirstOrThrow({ where: { invoiceId: made.invoice.id } });
        return (await s.owner.post(`/invoices/${made.invoice.id}/refunds`, { id: randomUUID(), paymentId: payment.id, amountPaise: 1000, reason: 'Cold food' }).expect(200)).body;
      };
      const first = await paidBill();
      const second = await paidBill();
      await refundOf(first);
      const later = await refundOf(second);
      expect(later.refunds[0].creditNoteNumber).toBe(`C-A1/${FY}/000002`);

      const removed = await s.owner.post(`/orders/${first.order.id}/delete`, { reason: 'Test bill' }).expect(200);
      expect(removed.body.bills).toBe(2);   // one bill and one credit note moved
      expect((await s.owner.get(`/invoices/${second.invoice.id}`).expect(200)).body).toMatchObject({
        invoiceNumber: `A1/${FY}/000001`, refunds: [expect.objectContaining({ creditNoteNumber: `C-A1/${FY}/000001`, amountPaise: 1000 })],
      });
    });

    it('leaves the gap with manual renumbering, until the owner resets the numbers', async () => {
      await s.owner.patch('/settings', { orderRenumberMode: 'MANUAL' }).expect(200);
      await paidBill();
      const second = await paidBill();
      const third = await paidBill();
      const removed = await s.owner.post(`/orders/${second.order.id}/delete`, { reason: 'Mistake' }).expect(200);
      expect(removed.body).toEqual({ changes: [], bills: 0 });
      expect((await h.prisma.invoice.findMany({ orderBy: { number: 'asc' } })).map((bill) => bill.number)).toEqual([1, 3]);
      // The number at the end of the series is still handed out again; the one in the middle stays missing.
      expect(await nextBillNumber()).toBe(`A1/${FY}/000004`);

      // A manager may reset order numbers but not bill numbers.
      await h.prisma.user.update({ where: { id: s.fx.cashier.id }, data: { roleId: s.fx.roles.manager! } });
      const manager = h.client();
      await manager.loginPos(s.fx.cashier.email, undefined, { terminalId: s.fx.terminal.id });
      const byManager = (await manager.post('/orders/renumber', {}).expect(200)).body;
      expect(byManager.bills).toBe(0);
      expect(byManager.changes.length).toBeGreaterThan(0);
      expect((await h.prisma.invoice.findMany({ orderBy: { number: 'asc' } })).map((bill) => bill.number)).toEqual([1, 3, 4]);

      // The owner's reset closes the bill numbers too.
      const byOwner = (await s.owner.post('/orders/renumber', {}).expect(200)).body;
      expect(byOwner).toEqual({ changes: [], bills: 2 });
      expect((await h.prisma.invoice.findMany({ orderBy: { number: 'asc' } })).map((bill) => [bill.number, bill.invoiceNumber])).toEqual([
        [1, `A1/${FY}/000001`], [2, `A1/${FY}/000002`], [3, `A1/${FY}/000003`],
      ]);
      expect((await s.owner.get(`/invoices/${third.invoice.id}`).expect(200)).body.invoiceNumber).toBe(`A1/${FY}/000002`);
      expect(await nextBillNumber()).toBe(`A1/${FY}/000004`);
      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'order.renumbered' }, orderBy: { createdAt: 'desc' } });
      expect((audit.after as { billsRenumbered: unknown }).billsRenumbered).toEqual([{ series: `A1/${FY}`, count: 2, moved: [{ from: 3, to: 4, by: -1 }] }]);
    });

    it('is the owner\'s alone: a cashier or manager needs the owner\'s PIN', async () => {
      const { order } = await paidBill();
      expect((await s.cashier.post(`/orders/${order.id}/delete`, { reason: 'Hide the sale' })).body).toMatchObject({ code: 'APPROVAL_REQUIRED', details: { permission: 'invoice.delete' } });

      // A manager may delete unbilled orders, and may approve that, but not this.
      await h.prisma.user.update({ where: { id: s.fx.cashier.id }, data: { roleId: s.fx.roles.manager! } });
      const manager = h.client();
      await manager.loginPos(s.fx.cashier.email, undefined, { terminalId: s.fx.terminal.id });
      expect((await manager.post(`/orders/${order.id}/delete`, { reason: 'Hide the sale' })).body.code).toBe('APPROVAL_REQUIRED');
      expect(await h.prisma.invoice.count()).toBe(1);
      expect(await h.prisma.payment.count()).toBe(1);

      await manager.post(`/orders/${order.id}/delete`, { reason: 'Owner agreed', approval: s.ownerApproval }).expect(200);
      expect(await h.prisma.invoice.count()).toBe(0);
      expect((await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'order.deleted' } })).after).toMatchObject({ approvedBy: s.fx.owner.id });
    });

    it('stays inside the restaurant', async () => {
      const { order } = await paidBill();
      const other = await scene(h, 'b');
      expect((await other.owner.post(`/orders/${order.id}/delete`, { reason: 'Not mine' })).status).toBe(404);
      expect((await other.owner.post(`/orders/${order.id}/reopen`, { reason: 'Not mine' })).status).toBe(404);
      expect(await h.prisma.invoice.count()).toBe(1);
    });
  });

  describe('reopening a billed order to change it', () => {
    it('erases the bill and payment, and lets the order be changed and billed again', async () => {
      const { order, invoice } = await paidBill('CASH');
      const reopened = await s.owner.post(`/orders/${order.id}/reopen`, { reason: 'Guest added a cola after paying' });
      expect(reopened.status).toBe(200);
      expect(reopened.body).toMatchObject({ id: order.id, status: 'OPEN', displayNumber: 'A1-1', invoices: [] });
      expect(reopened.body.items).toHaveLength(1);
      expect(await h.prisma.invoice.count()).toBe(0);
      expect(await h.prisma.payment.count()).toBe(0);
      expect((await s.cashier.get('/orders/running').expect(200)).body.map((running: { id: string }) => running.id)).toEqual([order.id]);
      expect(figure(await summary('sales-daily'), 'Total sales amount')).toBe(0);

      // Changed at the counter and billed again: the bill takes the number that was freed.
      const item = reopened.body.items[0];
      await saveOrder(s.cashier, { items: [{ id: item.id, productId: s.menu.paneer.id, quantity: 1 }, line(s.menu.cola.id, 1)], version: reopened.body.version }, order.id).expect(200);
      const [again] = (await s.cashier.post(`/orders/${order.id}/invoices`, {}).expect(201)).body;
      expect(again).toMatchObject({ invoiceNumber: invoice.invoiceNumber, totalPaise: 33200, paymentStatus: 'UNPAID' });
      expect(again.id).not.toBe(invoice.id);
      await pay(s.cashier, again.id, [{ method: 'UPI', amountPaise: 33200 }]).expect(200);
      expect((await s.owner.get(`/orders/${order.id}`).expect(200)).body.status).toBe('SETTLED');

      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'order.reopened' } });
      expect(audit).toMatchObject({ reason: 'Guest added a cola after paying', before: { status: 'SETTLED', bills: [{ invoiceNumber: invoice.invoiceNumber, payments: [{ method: 'CASH', amountPaise: 27300 }] }] } });
    });

    it('gives a table order its table back when it is free, and comes back without one when it is taken', async () => {
      const dineIn = async () => {
        const order = (await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.paneer.id, 1)] }).expect(200)).body;
        const [invoice] = (await s.cashier.post(`/orders/${order.id}/invoices`, {}).expect(201)).body;
        await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 27300 }]).expect(200);
        return order;
      };
      const tableStatus = async () => (await h.prisma.diningTable.findUniqueOrThrow({ where: { id: s.menu.t1.id } })).status;

      const first = await dineIn();
      expect(await tableStatus()).toBe('FREE');
      expect((await s.owner.post(`/orders/${first.id}/reopen`, { reason: 'Wrong item' }).expect(200)).body).toMatchObject({ status: 'OPEN', tableId: s.menu.t1.id });
      expect(await tableStatus()).toBe('OCCUPIED');

      // Bill it again, seat new guests at the table, then reopen the first order once more.
      const [invoice] = (await s.cashier.post(`/orders/${first.id}/invoices`, {}).expect(201)).body;
      await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 27300 }]).expect(200);
      const second = (await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.cola.id, 1)] }).expect(200)).body;
      expect((await s.owner.post(`/orders/${first.id}/reopen`, { reason: 'Wrong item again' }).expect(200)).body).toMatchObject({ status: 'OPEN', type: 'DINE_IN', tableId: null });
      expect((await s.owner.get(`/orders/${second.id}`).expect(200)).body).toMatchObject({ status: 'OPEN', tableId: s.menu.t1.id });
      expect(await tableStatus()).toBe('OCCUPIED');
    });

    it('applies only to billed orders, and only with the right to erase bills', async () => {
      const open = (await saveOrder(s.cashier, { items: [line(s.menu.cola.id, 1)] }).expect(200)).body;
      expect((await s.owner.post(`/orders/${open.id}/reopen`, { reason: 'Nothing to reopen' })).body.code).toBe('ORDER_NOT_BILLED');

      const { order } = await paidBill();
      expect((await s.owner.post(`/orders/${order.id}/reopen`, {})).status).toBe(400);
      expect((await s.cashier.post(`/orders/${order.id}/reopen`, { reason: 'Let me fix it' })).body.code).toBe('APPROVAL_REQUIRED');
      expect(await h.prisma.invoice.count()).toBe(1);
      await s.cashier.post(`/orders/${order.id}/reopen`, { reason: 'Owner agreed', approval: s.ownerApproval }).expect(200);
      expect(await h.prisma.invoice.count()).toBe(0);
    });
  });

  describe('changing the items of a billed order from the back office', () => {
    const keepLine = (order: { items: { id: string }[] }, quantity = 1) => ({ id: order.items[0]!.id, productId: s.menu.paneer.id, quantity });

    it('replaces the bill under the same number and date, and records the new total as paid', async () => {
      // Each order went to the kitchen with KOT before it was billed, so the kitchen has a ticket for each.
      await h.prisma.product.updateMany({ where: { id: { in: [s.menu.paneer.id, s.menu.cola.id] } }, data: { stationId: s.fx.station.id } });
      await paidBill('CASH', { kot: true });
      const { order, invoice } = await paidBill('CASH', { kot: true });
      await paidBill('CASH', { kot: true });
      expect(await h.prisma.kot.count()).toBe(3);

      const amended = await s.owner.post(`/orders/${order.id}/amend`, {
        items: [keepLine(order), line(s.menu.cola.id, 1)], payment: { method: 'UPI', reference: 'UPI-77' }, reason: 'Cola was left off the bill',
      });
      expect(amended.status).toBe(200);
      expect(amended.body).toMatchObject({ id: order.id, status: 'SETTLED', displayNumber: 'A1-2', paymentMethods: ['UPI'], totals: { totalPaise: 33200 } });
      expect(amended.body.items.map((item: { name: string; quantity: number }) => [item.name, item.quantity])).toEqual([['Paneer Tikka', 1], ['Cola', 1]]);

      // One bill, with the old number and date, the new items and one payment for the new total.
      expect(amended.body.invoices).toHaveLength(1);
      const bill = (await s.owner.get(`/invoices/${amended.body.invoices[0].id}`).expect(200)).body;
      expect(bill).toMatchObject({ invoiceNumber: invoice.invoiceNumber, issuedAt: invoice.issuedAt, businessDate: invoice.businessDate, totalPaise: 33200, paidPaise: 33200, paymentStatus: 'PAID', cashierName: 'Cashier' });
      expect(bill.id).not.toBe(invoice.id);
      expect(bill.items.map((item: { name: string }) => item.name)).toEqual(['Paneer Tikka', 'Cola']);
      expect(bill.payments).toEqual([expect.objectContaining({ method: 'UPI', amountPaise: 33200, reference: 'UPI-77' })]);
      expect((await h.prisma.invoice.findMany({ orderBy: { number: 'asc' } })).map((row) => row.number)).toEqual([1, 2, 3]);
      // The kitchen is not sent the cola, and nothing is cancelled: the order was served long ago.
      expect(await h.prisma.kot.count()).toBe(3);
      expect(await h.prisma.kot.count({ where: { type: 'CANCEL' } })).toBe(0);
      // The numbering carries on from where it was: nothing reused, nothing skipped.
      expect(await nextBillNumber()).toBe(`A1/${FY}/000004`);

      const daily = await summary('sales-daily');
      // Three paid bills; the cola bill made just above to check the numbering is not paid, so it is not a sale yet.
      expect(figure(daily, 'Total sales (receipts)')).toBe(3);
      expect(figure(daily, 'UPI')).toBe(33200);
      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'order.amended' } });
      expect(audit).toMatchObject({
        userId: s.fx.owner.id, entityId: order.id, reason: 'Cola was left off the bill',
        before: { number: 'A1-2', status: 'SETTLED', totalPaise: 27300, bills: [{ invoiceNumber: invoice.invoiceNumber, payments: [{ method: 'CASH', amountPaise: 27300 }] }] },
        after: { invoiceNumber: invoice.invoiceNumber, totalPaise: 33200, paidPaise: 33200, payments: [{ method: 'UPI', amountPaise: 33200 }] },
      });
    });

    it('keeps the number of the latest bill too, and the next bill follows it', async () => {
      await paidBill();
      const { order, invoice } = await paidBill();
      const amended = await s.owner.post(`/orders/${order.id}/amend`, { items: [keepLine(order, 2)], payment: { method: 'CASH' }, reason: 'Two were served' }).expect(200);
      expect(amended.body).toMatchObject({ status: 'SETTLED', totals: { totalPaise: 54600 } });
      expect(amended.body.invoices[0].invoiceNumber).toBe(invoice.invoiceNumber);
      expect(await nextBillNumber()).toBe(`A1/${FY}/000003`);
    });

    it('can leave the new bill unpaid, to be paid at the counter', async () => {
      const { order, invoice } = await paidBill();
      const amended = await s.owner.post(`/orders/${order.id}/amend`, { items: [keepLine(order), line(s.menu.cola.id, 2)], reason: 'Guest is still here and added drinks' }).expect(200);
      expect(amended.body).toMatchObject({ status: 'BILLED', paymentMethods: [], totals: { totalPaise: 39100 } });
      expect(amended.body.invoices[0]).toMatchObject({ invoiceNumber: invoice.invoiceNumber, paymentStatus: 'UNPAID', paidPaise: 0 });
      expect(await h.prisma.payment.count()).toBe(0);
      await pay(s.cashier, amended.body.invoices[0].id, [{ method: 'CARD', amountPaise: 39100 }]).expect(200);
      expect((await s.owner.get(`/orders/${order.id}`).expect(200)).body).toMatchObject({ status: 'SETTLED', paymentMethods: ['CARD'] });
    });

    it('changes nothing at all when the new items cannot be saved', async () => {
      const { order, invoice } = await paidBill('CASH');
      await h.prisma.product.update({ where: { id: s.menu.cola.id }, data: { isAvailable: false } });
      const failed = await s.owner.post(`/orders/${order.id}/amend`, { items: [keepLine(order), line(s.menu.cola.id, 1)], payment: { method: 'CASH' }, reason: 'Add a cola' });
      expect(failed.status).toBe(422);
      expect(failed.body.code).toBe('ITEM_UNAVAILABLE');
      // The bill, its payment and the order are exactly as they were.
      expect((await s.owner.get(`/invoices/${invoice.id}`).expect(200)).body).toMatchObject({ invoiceNumber: invoice.invoiceNumber, totalPaise: 27300, paidPaise: 27300, paymentStatus: 'PAID' });
      expect((await s.owner.get(`/orders/${order.id}`).expect(200)).body).toMatchObject({ status: 'SETTLED', totals: { totalPaise: 27300 } });
      expect(await h.prisma.auditLog.count({ where: { action: 'order.amended' } })).toBe(0);
      // And the protection is back on after the failed attempt.
      await expect(h.prisma.invoice.delete({ where: { id: invoice.id } })).rejects.toThrow();
    });

    it('works for a table order whose table has new guests, without disturbing them', async () => {
      const first = (await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.paneer.id, 1)] }).expect(200)).body;
      const [invoice] = (await s.cashier.post(`/orders/${first.id}/invoices`, {}).expect(201)).body;
      await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 27300 }]).expect(200);
      const second = (await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.cola.id, 1)] }).expect(200)).body;

      const amended = await s.owner.post(`/orders/${first.id}/amend`, { items: [keepLine(first, 3)], payment: { method: 'CASH' }, reason: 'Three were served' }).expect(200);
      expect(amended.body).toMatchObject({ status: 'SETTLED', tableId: s.menu.t1.id, totals: { totalPaise: 81900 } });
      expect((await s.owner.get(`/orders/${second.id}`).expect(200)).body).toMatchObject({ status: 'OPEN', tableId: s.menu.t1.id });
      expect((await h.prisma.diningTable.findUniqueOrThrow({ where: { id: s.menu.t1.id } })).status).toBe('OCCUPIED');
    });

    it('is for billed orders, needs at least one item, and needs the right to erase bills', async () => {
      const open = (await saveOrder(s.cashier, { items: [line(s.menu.cola.id, 1)] }).expect(200)).body;
      expect((await s.owner.post(`/orders/${open.id}/amend`, { items: [line(s.menu.cola.id, 2)], reason: 'Not billed yet' })).body.code).toBe('ORDER_NOT_BILLED');

      const { order } = await paidBill();
      expect((await s.owner.post(`/orders/${order.id}/amend`, { items: [], reason: 'Empty it' })).status).toBe(400);
      expect((await s.owner.post(`/orders/${order.id}/amend`, { items: [keepLine(order, 2)] })).status).toBe(400);
      expect((await s.cashier.post(`/orders/${order.id}/amend`, { items: [keepLine(order, 2)], reason: 'Fix it myself' })).body).toMatchObject({ code: 'APPROVAL_REQUIRED', details: { permission: 'invoice.delete' } });
      expect((await s.owner.get(`/orders/${order.id}`).expect(200)).body.totals.totalPaise).toBe(27300);
      await s.cashier.post(`/orders/${order.id}/amend`, { items: [keepLine(order, 2)], payment: { method: 'CASH' }, reason: 'Owner agreed', approval: s.ownerApproval }).expect(200);
      expect((await s.owner.get(`/orders/${order.id}`).expect(200)).body.totals.totalPaise).toBe(54600);
    });
  });
});
