import { randomUUID } from 'node:crypto';
import { businessDateOf } from '@pos/billing-core';
import { billed, FY, line, pay, saveOrder, type Scene, scene } from './support/billing.js';
import { CASHIER_PIN, createHarness, type Harness, OWNER_PIN, PASSWORD, type TestClient } from './support/harness.js';

const TODAY = businessDateOf(new Date());
const range = 'from=' + TODAY + '&to=' + TODAY;
const num = (n: number, fy = FY, prefix = 'A1') => `${prefix}/${fy}/${String(n).padStart(6, '0')}`;

type Res = { status: number; body: any };
type Report = { summary: { label: string; value: number }[]; rows: Record<string, any>[]; totals: Record<string, number> | null; note: string | null };

/** Exploratory tests written by an independent tester: owner corrections, permissions, reports, concurrency. */
describe('exploratory', () => {
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

  // ── helpers ──

  const must = (res: Res, status = 200) => {
    if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const getOrder = async (id: string, client: TestClient = s.owner) => must(await client.get(`/orders/${id}`));
  const getInvoice = async (id: string, client: TestClient = s.owner) => must(await client.get(`/invoices/${id}`));
  const payFull = async (invoice: { id: string; totalPaise: number }, method = 'CASH', client: TestClient = s.cashier) =>
    must(await pay(client, invoice.id, [{ method, amountPaise: invoice.totalPaise }]));
  async function paidBill(items?: object[], method = 'CASH', body: object = {}, client: TestClient = s.cashier) {
    const made = await billed(client, items ?? [line(s.menu.paneer.id, 1)], body);
    const paid = await payFull(made.invoice, method, client);
    return { ...made, paid };
  }
  const refund = async (invoiceId: string, paymentId: string, amountPaise: number) =>
    must(await s.owner.post(`/invoices/${invoiceId}/refunds`, { id: randomUUID(), paymentId, amountPaise, reason: 'Cold food' }));
  /** A line of an existing order, sent back unchanged (or with another quantity). */
  const keep = (item: any, quantity: number = item.quantity) => ({
    id: item.id, productId: item.productId, variantId: item.variantId, modifierIds: item.modifiers.map((m: any) => m.id), quantity,
    ...(item.discount ? { discount: { type: item.discount.type, value: item.discount.value, reason: item.discount.reason } } : {}),
  });
  const report = async (type: string, query = range, client: TestClient = s.owner): Promise<Report> => must(await client.get(`/reports/${type}?${query}`));
  const figure = (r: Report, label: string) => r.summary.find((entry) => entry.label === label)?.value;

  /** Every series: its counter against the highest number in use. In a healthy database next = max + 1. */
  async function seriesState() {
    const rows = await h.prisma.numberSeries.findMany({ orderBy: [{ type: 'asc' }, { financialYear: 'asc' }] });
    const out = [];
    for (const row of rows) {
      const inv = await h.prisma.invoice.aggregate({ where: { seriesId: row.id }, _max: { number: true } });
      const ref = await h.prisma.refund.aggregate({ where: { seriesId: row.id }, _max: { number: true } });
      out.push({ type: row.type, fy: row.financialYear, next: row.nextNumber, max: Math.max(inv._max.number ?? 0, ref._max.number ?? 0) });
    }
    return out;
  }
  async function expectSeriesHealthy() {
    for (const row of await seriesState()) expect(row, JSON.stringify(row)).toMatchObject({ next: row.max + 1 });
    const invoices = await h.prisma.invoice.findMany({ select: { seriesId: true, number: true, invoiceNumber: true } });
    expect(new Set(invoices.map((i) => `${i.seriesId}:${i.number}`)).size).toBe(invoices.length);
    expect(new Set(invoices.map((i) => i.invoiceNumber)).size).toBe(invoices.length);
  }
  const invoiceNumbers = async () => (await h.prisma.invoice.findMany({ orderBy: { number: 'asc' } })).map((row) => row.number);
  const nextBill = async () => (await billed(s.cashier, [line(s.menu.cola.id, 1)])).invoice.invoiceNumber as string;
  /** Runs test set-up statements with the database protection lifted, the way the API does. */
  const withOverride = <T>(work: (tx: any) => Promise<T>) =>
    h.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.owner_override', 'on', true)`;
      return work(tx);
    });
  /** The order and its standing bill must agree with each other and with the money recorded. */
  async function expectOrderConsistent(orderId: string) {
    const order = await getOrder(orderId);
    const invoices = await h.prisma.invoice.findMany({ where: { orderId, status: 'ISSUED' }, include: { items: true, payments: true, taxes: true } });
    const total = invoices.reduce((sum, i) => sum + i.totalPaise, 0);
    expect(order.totals.totalPaise).toBe(total);
    expect(order.totals.grossPaise).toBe(invoices.reduce((sum, i) => sum + i.grossPaise, 0));
    expect(order.totals.discountPaise).toBe(invoices.reduce((sum, i) => sum + i.discountPaise, 0));
    for (const invoice of invoices) {
      expect(invoice.items.reduce((sum, item) => sum + item.grossPaise, 0)).toBe(invoice.grossPaise);
      expect(invoice.items.reduce((sum, item) => sum + item.discountPaise, 0)).toBe(invoice.discountPaise);
      expect(invoice.items.reduce((sum, item) => sum + item.totalPaise, 0) + invoice.serviceChargePaise + invoice.roundOffPaise).toBe(invoice.totalPaise);
      expect(invoice.payments.filter((p) => p.status === 'SUCCESS').reduce((sum, p) => sum + p.amountPaise, 0)).toBe(invoice.paidPaise);
      expect(invoice.paidPaise).toBeLessThanOrEqual(invoice.totalPaise);
    }
    expect(order.items.reduce((sum: number, item: any) => sum + item.quantity, 0)).toBe(invoices.flatMap((i) => i.items).reduce((sum, item) => sum + item.quantity, 0));
    return { order, invoices };
  }

  // ── 1. amend ──

  describe('amend: variety', () => {
    it('keeps a percentage bill discount and a line discount, and totals agree everywhere', async () => {
      const made = await paidBill(
        [line(s.menu.paneer.id, 2, { discount: { type: 'PERCENT', value: 1000, reason: 'Line' } }), line(s.menu.cola.id, 1)], 'CASH',
        { discount: { type: 'PERCENT', value: 1000, reason: 'Regular' } },
      );
      const before = await getOrder(made.order.id);
      const amended = must(await s.owner.post(`/orders/${made.order.id}/amend`, {
        items: [keep(before.items[0], 3), keep(before.items[1], 2)], discount: { type: 'PERCENT', value: 1000, reason: 'Regular' },
        payment: { method: 'UPI' }, reason: 'More was served',
      }));
      // 3 paneer = 78000 − 10% = 70200; 2 cola = 10000; net 80200 − 10% = 72180. Tax: paneer 63180 × 5% = 3159, cola 9000 × 18% = 1620. Total 76959 → 77000.
      expect(amended.totals).toMatchObject({ grossPaise: 88000, discountPaise: 7800 + 8020, totalPaise: 77000 });
      expect(amended.status).toBe('SETTLED');
      expect(amended.invoices).toHaveLength(1);
      expect(amended.invoices[0]).toMatchObject({ invoiceNumber: made.invoice.invoiceNumber, totalPaise: 77000, paidPaise: 77000, paymentStatus: 'PAID' });
      expect(amended.discount).toMatchObject({ type: 'PERCENT', value: 1000, amountPaise: 8020 });
      expect(amended.items[0].discount).toMatchObject({ type: 'PERCENT', value: 1000, amountPaise: 7800 });
      await expectOrderConsistent(made.order.id);
      await expectSeriesHealthy();
      // The discounts report adds up to the discount on the bill.
      const discounts = await report('discounts');
      expect(figure(discounts, 'Total discount')).toBe(15820);
      expect(figure(await report('sales-daily'), 'Total sales amount')).toBe(77000);
      expect((await report('sales-daily')).rows[0]).toMatchObject({ discount: 15820, upi: 77000, cash: 0 });
    });

    it('caps an amount discount at the new, smaller bill and can bring the total to zero', async () => {
      const made = await paidBill([line(s.menu.paneer.id, 2)], 'CASH', { discount: { type: 'AMOUNT', value: 5000 } });
      expect(made.invoice.totalPaise).toBe(49400); // 52000 − 5000 = 47000 + 5% = 49350 → 49400
      const amended = must(await s.owner.post(`/orders/${made.order.id}/amend`, {
        items: [line(s.menu.cola.id, 1)], discount: { type: 'AMOUNT', value: 5000 }, payment: { method: 'CASH' }, reason: 'Only a cola was served',
      }));
      expect(amended.totals).toMatchObject({ grossPaise: 5000, discountPaise: 5000, totalPaise: 0 });
      expect(amended.status).toBe('SETTLED');
      expect(amended.invoices[0]).toMatchObject({ invoiceNumber: made.invoice.invoiceNumber, totalPaise: 0, paidPaise: 0, paymentStatus: 'PAID' });
      // Nothing to pay, so no payment row even though a method was given.
      expect(await h.prisma.payment.count()).toBe(0);
      expect(amended.paymentMethods).toEqual([]);
      await expectOrderConsistent(made.order.id);
      await expectSeriesHealthy();
      expect(await nextBill()).toBe(num(2));
      // The bill for nothing is a completed order of its own; the cola bill just made is not paid, so it is not a sale yet.
      expect((await getOrder(made.order.id)).status).toBe('SETTLED');
      expect((await s.owner.get('/dashboard').expect(200)).body.sales).toMatchObject({ bills: 1, totalPaise: 0 });
    });

    it('asks for approval for a new discount above the cap, from a cashier holding only the owner PIN for the erase', async () => {
      const made = await paidBill([line(s.menu.paneer.id, 2)]);
      const before = await getOrder(made.order.id);
      const body = { items: [keep(before.items[0])], discount: { type: 'PERCENT', value: 5000 }, payment: { method: 'CASH' }, reason: 'Half off' };
      // Cashier alone: refused for the erase.
      expect((await s.cashier.post(`/orders/${made.order.id}/amend`, body)).body).toMatchObject({ code: 'APPROVAL_REQUIRED', details: { permission: 'invoice.delete' } });
      // With the owner's PIN both the erase and the discount are covered (the owner may approve both).
      const amended = must(await s.cashier.post(`/orders/${made.order.id}/amend`, { ...body, approval: s.ownerApproval }));
      expect(amended.totals).toMatchObject({ discountPaise: 26000, totalPaise: 27300 });
      const row = await h.prisma.discount.findFirstOrThrow();
      expect(row).toMatchObject({ approvedById: s.fx.owner.id, appliedById: s.fx.cashier.id });
      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'order.amended' } });
      expect(audit.after).toMatchObject({ approvedBy: s.fx.owner.id });
      expect(audit.userId).toBe(s.fx.cashier.id);
      await expectOrderConsistent(made.order.id);
    });

    it('turns a bill split in three back into one under the first number; the other numbers become gaps', async () => {
      // Written for bill numbers that stay put after an erase, which is what manual renumbering gives.
      await s.owner.patch('/settings', { orderRenumberMode: 'MANUAL' }).expect(200);
      await paidBill();
      const order = must(await saveOrder(s.cashier, { items: [line(s.menu.paneer.id, 2), line(s.menu.cola.id, 2), line(s.menu.chicken.id, 1, { variantId: s.menu.full.id })] }));
      const parts = [
        [{ orderItemId: order.items[0].id, quantity: 1 }, { orderItemId: order.items[1].id, quantity: 1 }],
        [{ orderItemId: order.items[0].id, quantity: 1 }],
        [{ orderItemId: order.items[1].id, quantity: 1 }, { orderItemId: order.items[2].id, quantity: 1 }],
      ];
      const invoices = must(await s.cashier.post(`/orders/${order.id}/invoices`, { parts }), 201);
      expect(invoices.map((i: any) => i.invoiceNumber)).toEqual([num(2), num(3), num(4)]);
      await payFull(invoices[0], 'CASH');
      await payFull(invoices[2], 'CARD');
      await paidBill();
      expect(await invoiceNumbers()).toEqual([1, 2, 3, 4, 5]);

      const amended = must(await s.owner.post(`/orders/${order.id}/amend`, {
        items: order.items.map((item: any) => keep(item)), payment: { method: 'UPI' }, reason: 'One bill after all',
      }));
      expect(amended.invoices).toHaveLength(1);
      expect(amended.invoices[0]).toMatchObject({ invoiceNumber: num(2), paymentStatus: 'PAID' });
      expect(amended.status).toBe('SETTLED');
      expect(await invoiceNumbers()).toEqual([1, 2, 5]);
      await expectOrderConsistent(order.id);
      await expectSeriesHealthy();
      expect(await nextBill()).toBe(num(6));
      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'order.amended' } });
      expect((audit.before as any).bills.map((b: any) => b.invoiceNumber).sort()).toEqual([num(2), num(3), num(4)]);
    });

    it('a split bill that was the latest: the freed numbers are handed out again', async () => {
      await paidBill();
      const order = must(await saveOrder(s.cashier, { items: [line(s.menu.paneer.id, 1), line(s.menu.cola.id, 1)] }));
      const parts = [[{ orderItemId: order.items[0].id, quantity: 1 }], [{ orderItemId: order.items[1].id, quantity: 1 }]];
      must(await s.cashier.post(`/orders/${order.id}/invoices`, { parts }), 201);
      const amended = must(await s.owner.post(`/orders/${order.id}/amend`, { items: order.items.map((item: any) => keep(item)), reason: 'One bill' }));
      expect(amended.invoices.map((i: any) => i.invoiceNumber)).toEqual([num(2)]);
      expect(amended.status).toBe('BILLED');
      await expectSeriesHealthy();
      expect(await nextBill()).toBe(num(3));
      await expectSeriesHealthy();
    });

    it('an order with a cancelled bill and a standing one keeps the standing bill number', async () => {
      const paneer = line(s.menu.paneer.id);
      const order = must(await saveOrder(s.cashier, { items: [paneer] }));
      const [first] = must(await s.cashier.post(`/orders/${order.id}/invoices`, {}), 201);
      must(await s.owner.post(`/invoices/${first.id}/cancel`, { reason: 'Wrong quantity', reopenOrder: true }));
      const reopened = await getOrder(order.id);
      must(await saveOrder(s.cashier, { items: [{ ...paneer, quantity: 2 }], version: reopened.version }, order.id));
      const [second] = must(await s.cashier.post(`/orders/${order.id}/invoices`, {}), 201);
      expect(second.invoiceNumber).toBe(num(2));
      await payFull(second);

      const now = await getOrder(order.id);
      const amended = must(await s.owner.post(`/orders/${order.id}/amend`, { items: [keep(now.items[0], 3)], payment: { method: 'CASH' }, reason: 'Three' }));
      // The bill cancelled earlier is a record in its own right and stays; only the standing bill is replaced.
      expect(amended.invoices.map((i: any) => [i.invoiceNumber, i.status])).toEqual([[num(1), 'CANCELLED'], [num(2), 'ISSUED']]);
      expect(amended.totals.totalPaise).toBe(81900);
      await expectOrderConsistent(order.id);
      await expectSeriesHealthy();
      expect(await nextBill()).toBe(num(3));
      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'order.amended' } });
      expect((audit.before as any).bills.map((b: any) => [b.invoiceNumber, b.status])).toEqual([[num(2), 'ISSUED']]);
    });

    it('replaces a partially paid and a partially refunded bill; the credit-note series stays usable', async () => {
      // Written for bill numbers that stay put after an erase, which is what manual renumbering gives.
      await s.owner.patch('/settings', { orderRenumberMode: 'MANUAL' }).expect(200);
      // Partially paid.
      const part = await billed(s.cashier, [line(s.menu.paneer.id, 2)]);
      must(await pay(s.cashier, part.invoice.id, [{ method: 'CASH', amountPaise: 10000 }]));
      // Paid and partially refunded (credit note 1), and another bill refunded (credit note 2).
      const refunded = await paidBill();
      await refund(refunded.invoice.id, refunded.paid.payments[0].id, 5000);
      const other = await paidBill();
      await refund(other.invoice.id, other.paid.payments[0].id, 1000);

      const partOrder = await getOrder(part.order.id);
      const a = must(await s.owner.post(`/orders/${part.order.id}/amend`, { items: [keep(partOrder.items[0], 1)], payment: { method: 'CARD' }, reason: 'One only' }));
      expect(a).toMatchObject({ status: 'SETTLED', paymentMethods: ['CARD'], totals: { totalPaise: 27300 } });
      const refOrder = await getOrder(refunded.order.id);
      const b = must(await s.owner.post(`/orders/${refunded.order.id}/amend`, { items: [keep(refOrder.items[0], 1), line(s.menu.cola.id, 1)], payment: { method: 'CASH' }, reason: 'Cola added' }));
      expect(b.invoices[0]).toMatchObject({ invoiceNumber: num(2), paymentStatus: 'PAID', refundedPaise: 0, paidPaise: 33200 });
      expect((await h.prisma.refund.findMany()).map((r) => r.creditNoteNumber)).toEqual([`C-${num(2)}`]);
      await expectSeriesHealthy();
      await expectOrderConsistent(part.order.id);
      await expectOrderConsistent(refunded.order.id);
      // A new refund takes the next credit-note number without colliding.
      const again = await getInvoice(b.invoices[0].id);
      const withRefund = await refund(again.id, again.payments[0].id, 1000);
      expect(withRefund.refunds[0].creditNoteNumber).toBe(`C-${num(3)}`);
      await expectSeriesHealthy();
      // Reports: refunds only show what still exists.
      expect(figure(await report('refunds'), 'Total refunded')).toBe(2000);
      const daily = await report('sales-daily');
      expect(daily.rows[0]).toMatchObject({ bills: 3, total: 27300 + 33200 + 27300, cash: 33200 + 27300, card: 27300, refunds: 2000 });
    });

    it('removes the only line and adds a different one; then amends a second and third time', async () => {
      await paidBill();
      const made = await paidBill();
      await paidBill();
      const one = must(await s.owner.post(`/orders/${made.order.id}/amend`, { items: [line(s.menu.cola.id, 3)], payment: { method: 'UPI' }, reason: 'It was colas' }));
      expect(one.items.map((i: any) => [i.name, i.quantity])).toEqual([['Cola', 3]]);
      expect(one.totals.totalPaise).toBe(17700);
      const two = must(await s.owner.post(`/orders/${made.order.id}/amend`, { items: [keep(one.items[0], 1), line(s.menu.paneer.id, 1)], payment: { method: 'CARD' }, reason: 'Again' }));
      expect(two.totals.totalPaise).toBe(33200);
      const three = must(await s.owner.post(`/orders/${made.order.id}/amend`, { items: two.items.map((i: any) => keep(i)), reason: 'Unpaid now' }));
      expect(three).toMatchObject({ status: 'BILLED', paymentMethods: [] });
      expect(three.invoices.map((i: any) => i.invoiceNumber)).toEqual([num(2)]);
      expect(await invoiceNumbers()).toEqual([1, 2, 3]);
      expect(await h.prisma.payment.count()).toBe(2);
      const stored = await h.prisma.invoice.findFirstOrThrow({ where: { number: 2 } });
      expect(stored.issuedAt.toISOString()).toBe(made.invoice.issuedAt);
      expect(stored.createdById).toBe(s.fx.cashier.id);
      await expectOrderConsistent(made.order.id);
      await expectSeriesHealthy();
      expect(await nextBill()).toBe(num(4));
      expect(await h.prisma.auditLog.count({ where: { action: 'order.amended' } })).toBe(3);
    });

    it('handles variants and modifiers, old and new', async () => {
      const made = await paidBill([
        line(s.menu.chicken.id, 1, { variantId: s.menu.half.id }),
        line(s.menu.biryani.id, 1, { modifierIds: [s.menu.mild.id, s.menu.raita.id] }),
      ]);
      expect(made.invoice.totalPaise).toBe(59900); // 28000 + 5% = 29400, (25000 + 4000) + 5% = 30450; 59850 rounds to 59900
      const before = await getOrder(made.order.id);
      // Missing required modifier group: refused, nothing changes.
      const bad = await s.owner.post(`/orders/${made.order.id}/amend`, { items: [keep(before.items[0]), line(s.menu.biryani.id, 1)], payment: { method: 'CASH' }, reason: 'x' });
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe('MODIFIER_SELECTION');
      expect((await getInvoice(made.invoice.id)).totalPaise).toBe(59900);
      // Variant swapped on an existing line; a new biryani with other add-ons; old biryani kept.
      const amended = must(await s.owner.post(`/orders/${made.order.id}/amend`, {
        items: [
          { ...keep(before.items[0]), variantId: s.menu.full.id },
          keep(before.items[1], 2),
          line(s.menu.biryani.id, 1, { modifierIds: [s.menu.spicy.id, s.menu.egg.id, s.menu.raita.id] }),
        ],
        payment: { method: 'CASH' }, reason: 'Full chicken',
      }));
      expect(amended.items.map((i: any) => [i.name, i.variantName, i.quantity, i.unitPricePaise])).toEqual([
        ['Tandoori Chicken', 'Full', 1, 52000], ['Veg Biryani', null, 2, 29000], ['Veg Biryani', null, 1, 31500],
      ]);
      expect(amended.totals.totalPaise).toBe(Math.round((52000 + 58000 + 31500) * 1.05 / 100) * 100);
      const bill = await getInvoice(amended.invoices[0].id);
      expect(bill.items.map((i: any) => i.name)).toEqual(['Tandoori Chicken (Full)', 'Veg Biryani + Raita, Mild', 'Veg Biryani + Raita, Boiled Egg, Spicy'].map((n) => expect.stringContaining(n.split(' + ')[0]!)));
      await expectOrderConsistent(made.order.id);
      await expectSeriesHealthy();
    });

    it('keeps a line whose product has since been made unavailable, deactivated or deleted', async () => {
      const made = await paidBill([line(s.menu.paneer.id, 2), line(s.menu.cola.id, 1), line(s.menu.chicken.id, 1, { variantId: s.menu.half.id })]);
      const before = await getOrder(made.order.id);
      await h.prisma.product.update({ where: { id: s.menu.paneer.id }, data: { isAvailable: false, basePricePaise: 99900 } });
      await h.prisma.product.update({ where: { id: s.menu.cola.id }, data: { deletedAt: new Date(), isActive: false } });
      await h.prisma.variant.update({ where: { id: s.menu.half.id }, data: { deletedAt: new Date() } });
      const amended = must(await s.owner.post(`/orders/${made.order.id}/amend`, {
        items: [keep(before.items[0], 1), keep(before.items[1], 2), keep(before.items[2], 1)], payment: { method: 'CASH' }, reason: 'Quantities',
      }));
      // Old prices are kept: paneer 26000, cola 5000, chicken 28000.
      expect(amended.items.map((i: any) => [i.name, i.quantity, i.unitPricePaise])).toEqual([['Paneer Tikka', 1, 26000], ['Cola', 2, 5000], ['Tandoori Chicken', 1, 28000]]);
      expect(amended.totals.totalPaise).toBe(27300 + 11800 + 29400);
      await expectOrderConsistent(made.order.id);
      // The item and category reports still run with the deleted product.
      for (const type of ['items', 'item-summary', 'categories', 'hsn', 'gst']) must(await s.owner.get(`/reports/${type}?${range}`));
    });

    it('a bill of an earlier financial year keeps its own series and number', async () => {
      // Written for bill numbers that stay put after an erase, which is what manual renumbering gives.
      await s.owner.patch('/settings', { orderRenumberMode: 'MANUAL' }).expect(200);
      const made = await paidBill();
      const current = await h.prisma.numberSeries.findFirstOrThrow({ where: { type: 'INVOICE' } });
      // Move the bill into last financial year: number 7 of series 2526, dated 30 March.
      const old = await h.prisma.numberSeries.create({ data: { restaurantId: s.fx.restaurant.id, terminalId: s.fx.terminal.id, type: 'INVOICE', financialYear: '2526', prefix: 'A1', nextNumber: 8 } });
      await withOverride(async (tx) => {
        await tx.invoice.update({ where: { id: made.invoice.id }, data: { seriesId: old.id, number: 7, invoiceNumber: 'A1/2526/000007', businessDate: new Date('2026-03-30T00:00:00.000Z') } });
        await tx.payment.updateMany({ data: { businessDate: new Date('2026-03-30T00:00:00.000Z') } });
      });
      await h.prisma.numberSeries.update({ where: { id: current.id }, data: { nextNumber: 1 } });
      await h.prisma.order.update({ where: { id: made.order.id }, data: { businessDate: new Date('2026-03-30T00:00:00.000Z') } });

      const before = await getOrder(made.order.id);
      const amended = must(await s.owner.post(`/orders/${made.order.id}/amend`, { items: [keep(before.items[0], 2)], payment: { method: 'UPI' }, reason: 'Two were served' }));
      expect(amended.invoices[0]).toMatchObject({ invoiceNumber: 'A1/2526/000007', totalPaise: 54600, paymentStatus: 'PAID' });
      const stored = await h.prisma.invoice.findFirstOrThrow({ include: { payments: true } });
      expect(stored).toMatchObject({ seriesId: old.id, number: 7 });
      expect(stored.businessDate.toISOString().slice(0, 10)).toBe('2026-03-30');
      expect(stored.payments[0]!.businessDate.toISOString().slice(0, 10)).toBe('2026-03-30');
      expect(await seriesState()).toEqual([
        { type: 'INVOICE', fy: '2526', next: 8, max: 7 },
        { type: 'INVOICE', fy: FY, next: 1, max: 0 },
      ]);
      expect(await nextBill()).toBe(num(1));
      // Reports for that day in March agree with each other; today has only the new cola bill.
      const march = 'from=2026-03-30&to=2026-03-30';
      expect((await report('sales-daily', march)).rows[0]).toMatchObject({ bills: 1, total: 54600, upi: 54600, cash: 0 });
      expect(figure(await report('payments', march), 'Total received')).toBe(54600);
      // Today's cola bill is not paid, so today has no sale and no money yet.
      expect(figure(await report('sales-daily'), 'Total sales amount')).toBe(0);
      expect((await report('sales-daily')).rows).toEqual([]);
    });

    it('refuses line ids that belong to another order with a clear 4xx, and touches neither order', async () => {
      const victim = await paidBill([line(s.menu.cola.id, 4)]);
      const victimLine = (await getOrder(victim.order.id)).items[0];
      const made = await paidBill();
      const before = await getOrder(made.order.id);
      const res = await s.owner.post(`/orders/${made.order.id}/amend`, {
        items: [keep(before.items[0]), { id: victimLine.id, productId: s.menu.cola.id, quantity: 1 }], payment: { method: 'CASH' }, reason: 'Steal a line',
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect((await getOrder(victim.order.id)).items).toHaveLength(1);
      expect((await getInvoice(made.invoice.id)).totalPaise).toBe(27300);
      await expectSeriesHealthy();
    });
  });

  // ── 2. delete and reopen ──

  describe('delete and reopen: variety', () => {
    it('delete: invoice and credit-note counters follow the highest number left', async () => {
      // Written for bill numbers that stay put after an erase, which is what manual renumbering gives.
      await s.owner.patch('/settings', { orderRenumberMode: 'MANUAL' }).expect(200);
      const a = await paidBill();
      await refund(a.invoice.id, a.paid.payments[0].id, 1000);
      const b = await paidBill();
      await refund(b.invoice.id, b.paid.payments[0].id, 1000);
      const c = await paidBill();
      await refund(c.invoice.id, c.paid.payments[0].id, 1000);
      expect((await h.prisma.refund.findMany({ orderBy: { number: 'asc' } })).map((r) => r.number)).toEqual([1, 2, 3]);

      must(await s.owner.post(`/orders/${b.order.id}/delete`, { reason: 'Middle' }));
      expect(await seriesState()).toEqual([{ type: 'INVOICE', fy: FY, next: 4, max: 3 }, { type: 'CREDIT_NOTE', fy: FY, next: 4, max: 3 }]);
      must(await s.owner.post(`/orders/${c.order.id}/delete`, { reason: 'Latest' }));
      await expectSeriesHealthy();
      // A new bill and a new credit note do not collide with anything.
      const d = await paidBill();
      const withRefund = await refund(d.invoice.id, d.paid.payments[0].id, 1000);
      expect(withRefund.refunds).toHaveLength(1);
      await expectSeriesHealthy();
      expect((await h.prisma.order.findMany({ orderBy: { orderNumber: 'asc' } })).map((o) => o.orderNumber)).toEqual([1, 2]);
      expect(figure(await report('refunds'), 'Total refunded')).toBe(2000);
      expect((await s.owner.get('/dashboard').expect(200)).body.sales).toMatchObject({ bills: 2, totalPaise: 54600, refundsPaise: 2000 });
    });

    it('reopen from the back office (no terminal): a split, part-paid, refunded table order comes back whole', async () => {
      const web = h.client();
      must(await web.login(s.fx.owner.email));
      const order = must(await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.paneer.id, 2), line(s.menu.cola.id, 2)] }));
      const parts = [
        [{ orderItemId: order.items[0].id, quantity: 1 }, { orderItemId: order.items[1].id, quantity: 2 }],
        [{ orderItemId: order.items[0].id, quantity: 1 }],
      ];
      const [first] = must(await s.cashier.post(`/orders/${order.id}/invoices`, { parts }), 201);
      const paid = await payFull(first, 'UPI');
      await refund(first.id, paid.payments[0].id, 5900);
      const tableStatus = async () => (await h.prisma.diningTable.findUniqueOrThrow({ where: { id: s.menu.t1.id } })).status;
      expect(await tableStatus()).toBe('BILL_PRINTED');

      const reopened = must(await web.post(`/orders/${order.id}/reopen`, { reason: 'Start over' }));
      expect(reopened).toMatchObject({ status: 'OPEN', tableId: s.menu.t1.id, invoices: [], paymentMethods: [], totals: { totalPaise: 66400 } });
      expect(reopened.items.map((i: any) => [i.name, i.quantity])).toEqual([['Paneer Tikka', 2], ['Cola', 2]]);
      expect(await tableStatus()).toBe('OCCUPIED');
      expect([await h.prisma.invoice.count(), await h.prisma.payment.count(), await h.prisma.refund.count(), await h.prisma.invoiceItem.count(), await h.prisma.refundItem.count()]).toEqual([0, 0, 0, 0, 0]);
      await expectSeriesHealthy();
      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'order.reopened' } });
      expect((audit.before as any).bills).toHaveLength(2);
      expect((audit.before as any).bills[0]).toMatchObject({ invoiceNumber: num(1), payments: [{ method: 'UPI' }], refunds: [{ creditNoteNumber: `C-${num(1)}`, amountPaise: 5900 }] });
      expect(audit.terminalId).toBeNull();

      // Billed again from the counter as one bill: number 1 again.
      const [again] = must(await s.cashier.post(`/orders/${order.id}/invoices`, {}), 201);
      expect(again).toMatchObject({ invoiceNumber: num(1), totalPaise: 66400 });
      expect(await tableStatus()).toBe('BILL_PRINTED');
      // And deleted from the back office while unpaid: the table is free again.
      must(await web.post(`/orders/${order.id}/delete`, { reason: 'Never mind' }));
      expect(await tableStatus()).toBe('FREE');
      expect(await h.prisma.order.count()).toBe(0);
      await expectSeriesHealthy();
    });

    it('amend from the back office (no terminal) works for a counter order', async () => {
      const web = h.client();
      must(await web.login(s.fx.owner.email));
      const made = await paidBill();
      const before = await getOrder(made.order.id);
      const amended = must(await web.post(`/orders/${made.order.id}/amend`, { items: [keep(before.items[0], 2)], payment: { method: 'CASH' }, reason: 'Two' }));
      expect(amended.invoices[0]).toMatchObject({ invoiceNumber: num(1), totalPaise: 54600 });
    });

    it('reopen keeps discounts, and the reopened order bills to the same total', async () => {
      const made = await paidBill([line(s.menu.paneer.id, 2, { discount: { type: 'AMOUNT', value: 2000 } }), line(s.menu.cola.id, 1)], 'CASH', { discount: { type: 'PERCENT', value: 1000 } });
      const reopened = must(await s.owner.post(`/orders/${made.order.id}/reopen`, { reason: 'Fix at the counter' }));
      expect(reopened.totals).toEqual((await getOrder(made.order.id)).totals);
      expect(reopened.totals.totalPaise).toBe(made.invoice.totalPaise);
      expect(reopened.discount).toMatchObject({ type: 'PERCENT', value: 1000 });
      expect(reopened.items[0].discount).toMatchObject({ type: 'AMOUNT', value: 2000 });
      const [again] = must(await s.cashier.post(`/orders/${made.order.id}/invoices`, {}), 201);
      expect(again).toMatchObject({ invoiceNumber: made.invoice.invoiceNumber, totalPaise: made.invoice.totalPaise });
      // The discounts report does not list an order that is still running, and lists it again once it is paid.
      expect((await report('discounts')).rows).toHaveLength(0);
      must(await pay(s.cashier, again.id, [{ method: 'CASH', amountPaise: again.totalPaise }]));
      expect((await report('discounts')).rows).toHaveLength(2);
    });

    it('delete: an order that others were merged into, and a cancelled order with a cancelled bill', async () => {
      const target = must(await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.paneer.id, 1)] }));
      const source = must(await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t2.id, items: [line(s.menu.cola.id, 2)] }));
      must(await s.cashier.post(`/orders/${target.id}/merge`, { sourceOrderId: source.id }));
      const [invoice] = must(await s.cashier.post(`/orders/${target.id}/invoices`, {}), 201);
      await payFull(invoice);
      must(await s.owner.post(`/orders/${target.id}/delete`, { reason: 'Test table' }));
      expect((await getOrder(source.id)).status).toBe('MERGED');
      await expectSeriesHealthy();

      const other = await billed(s.cashier, [line(s.menu.cola.id, 1)]);
      must(await s.owner.post(`/invoices/${other.invoice.id}/cancel`, { reason: 'Mistake' }));
      expect((await getOrder(other.order.id)).status).toBe('CANCELLED');
      // A cancelled order with a cancelled bill is neither amendable nor reopenable, but it can be erased by the owner only.
      expect((await s.owner.post(`/orders/${other.order.id}/reopen`, { reason: 'x' })).body.code).toBe('ORDER_NOT_BILLED');
      expect((await s.owner.post(`/orders/${other.order.id}/amend`, { items: [line(s.menu.cola.id, 1)], reason: 'x' })).body.code).toBe('ORDER_NOT_BILLED');
      expect((await s.cashier.post(`/orders/${other.order.id}/delete`, { reason: 'x' })).body).toMatchObject({ code: 'APPROVAL_REQUIRED', details: { permission: 'invoice.delete' } });
      must(await s.owner.post(`/orders/${other.order.id}/delete`, { reason: 'x' }));
      expect(await h.prisma.invoice.count()).toBe(0);
      await expectSeriesHealthy();
    });
  });

  // ── 3. payment method ──

  describe('change payment method: variety', () => {
    it('keeps the date and time of the payment, works on one tender of a split payment, and stays inside the restaurant', async () => {
      const made = await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
      const paid = must(await pay(s.cashier, made.invoice.id, [{ method: 'CASH', amountPaise: 20000, tenderedPaise: 50000 }, { method: 'CARD', amountPaise: 7300, reference: 'SLIP-1' }]));
      const cash = paid.payments.find((p: any) => p.method === 'CASH');
      const before = await h.prisma.payment.findUniqueOrThrow({ where: { id: cash.id } });
      const other = await scene(h, 'b');
      expect((await other.owner.patch(`/invoices/${made.invoice.id}/payments/${cash.id}`, { method: 'UPI', reason: 'Not mine' })).status).toBe(404);
      const theirs = await billed(other.cashier, [line(other.menu.cola.id)]);
      expect((await s.owner.patch(`/invoices/${theirs.invoice.id}/payments/${cash.id}`, { method: 'UPI', reason: 'Not mine' })).status).toBe(404);

      const changed = must(await s.owner.patch(`/invoices/${made.invoice.id}/payments/${cash.id}`, { method: 'CARD', reason: 'Both by card' }));
      expect(changed.payments.map((p: any) => [p.method, p.amountPaise, p.reference])).toEqual([['CARD', 20000, null], ['CARD', 7300, 'SLIP-1']]);
      const after = await h.prisma.payment.findUniqueOrThrow({ where: { id: cash.id } });
      expect(after.businessDate).toEqual(before.businessDate);
      expect(after.paidAt).toEqual(before.paidAt);
      expect(after.receivedById).toBe(before.receivedById);
      expect((await getOrder(made.order.id)).paymentMethods).toEqual(['CARD']);
      expect((await report('payment-summary')).rows).toEqual([expect.objectContaining({ method: 'Card', count: 2, amount: 27300 })]);
      expect((await report('sales-daily')).rows[0]).toMatchObject({ cash: 0, card: 27300 });
      expect((await report('cashiers')).rows.find((r) => r.name === 'Cashier')).toMatchObject({ cash: 0, card: 27300, collected: 27300 });
      expect((await s.owner.get('/dashboard').expect(200)).body.payments).toEqual([{ method: 'CARD', amountPaise: 27300, count: 2 }]);
    });

    it('validation: unknown method, long reference, missing reason, unknown ids', async () => {
      const made = await paidBill();
      const path = `/invoices/${made.invoice.id}/payments/${made.paid.payments[0].id}`;
      expect((await s.owner.patch(path, { method: 'UPI', reason: 'x', reference: 'R'.repeat(61) })).status).toBe(400);
      expect((await s.owner.patch(path, { method: 'UPI', reason: '' })).status).toBe(400);
      expect((await s.owner.patch(path, { method: 'upi', reason: 'x' })).status).toBe(400);
      expect((await s.owner.patch(`/invoices/${made.invoice.id}/payments/${randomUUID()}`, { method: 'UPI', reason: 'x' })).status).toBe(404);
      expect((await s.owner.patch(`/invoices/${randomUUID()}/payments/${made.paid.payments[0].id}`, { method: 'UPI', reason: 'x' })).status).toBe(404);
      expect((await s.owner.patch(`/invoices/not-a-uuid/payments/${made.paid.payments[0].id}`, { method: 'UPI', reason: 'x' })).status).toBe(400);
      expect(await h.prisma.auditLog.count({ where: { action: 'payment.method_changed' } })).toBe(0);
    });

    it('two changes at once both land one after the other, each audited with what it replaced', async () => {
      const made = await paidBill();
      const path = `/invoices/${made.invoice.id}/payments/${made.paid.payments[0].id}`;
      const results = await Promise.all([
        s.owner.patch(path, { method: 'UPI', reason: 'One' }),
        s.owner.patch(path, { method: 'CARD', reason: 'Two' }),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const audits = await h.prisma.auditLog.findMany({ where: { action: 'payment.method_changed' }, orderBy: { createdAt: 'asc' } });
      expect(audits).toHaveLength(2);
      const final = (await h.prisma.payment.findFirstOrThrow()).method;
      const chain = audits.map((a) => [(a.before as any).method, (a.after as any).method]);
      // Whichever went second replaced the first one's method.
      expect(chain.some(([from]) => from === 'CASH')).toBe(true);
      expect(chain.some(([from, to]) => from !== 'CASH' && to === final)).toBe(true);
    });
  });

  // ── 4. the override never leaks; audit log is append-only ──

  describe('database protection', () => {
    /** Direct writes to protected tables on every pooled connection: all must be refused. */
    async function expectProtected(label: string) {
      const settings = await Promise.all(Array.from({ length: 24 }, () => h.prisma.$queryRaw<{ v: string | null }[]>`SELECT current_setting('app.owner_override', true) AS v`));
      expect(settings.map((rows) => rows[0]!.v).filter((v) => v === 'on'), label).toEqual([]);
      const invoice = await h.prisma.invoice.findFirstOrThrow({ where: { payments: { some: {} }, refunds: { some: {} } }, include: { payments: true, refunds: true, items: true, taxes: true } });
      const attempts = Array.from({ length: 4 }).flatMap(() => [
        h.prisma.invoice.update({ where: { id: invoice.id }, data: { totalPaise: 1 } }),
        h.prisma.invoice.delete({ where: { id: invoice.id } }),
        h.prisma.payment.update({ where: { id: invoice.payments[0]!.id }, data: { amountPaise: 1 } }),
        h.prisma.payment.update({ where: { id: invoice.payments[0]!.id }, data: { method: 'OTHER' } }),
        h.prisma.payment.deleteMany({ where: { id: invoice.payments[0]!.id } }),
        h.prisma.refund.update({ where: { id: invoice.refunds[0]!.id }, data: { amountPaise: 1 } }),
        h.prisma.refund.deleteMany({ where: { id: invoice.refunds[0]!.id } }),
        h.prisma.invoiceItem.update({ where: { id: invoice.items[0]!.id }, data: { quantity: 99 } }),
        h.prisma.invoiceItem.deleteMany({ where: { id: invoice.items[0]!.id } }),
        h.prisma.invoiceTax.deleteMany({ where: { invoiceId: invoice.id } }),
        h.prisma.$executeRaw`DELETE FROM invoices WHERE id = ${invoice.id}::uuid`,
        h.prisma.$executeRaw`UPDATE payments SET amount_paise = 1 WHERE invoice_id = ${invoice.id}::uuid`,
      ]);
      const settled = await Promise.allSettled(attempts);
      expect(settled.filter((r) => r.status === 'fulfilled'), label).toHaveLength(0);
    }

    it('after many successful and failed corrections, direct changes are still refused on every connection', async () => {
      // A sentinel bill with a payment and a refund that no correction touches.
      const sentinel = await paidBill([line(s.menu.paneer.id, 2)]);
      await refund(sentinel.invoice.id, sentinel.paid.payments[0].id, 1000);
      await expectProtected('before');

      for (let round = 0; round < 6; round += 1) {
        const a = await paidBill();
        const b = await paidBill();
        const c = await paidBill();
        const d = await paidBill();
        const ao = await getOrder(a.order.id);
        const results = await Promise.all([
          // success
          s.owner.patch(`/invoices/${a.invoice.id}/payments/${a.paid.payments[0].id}`, { method: 'UPI', reason: 'ok' }),
          s.owner.post(`/orders/${b.order.id}/reopen`, { reason: 'ok' }),
          s.owner.post(`/orders/${c.order.id}/delete`, { reason: 'ok' }),
          // failures of every kind: same method, unknown item (fails inside the transaction after the erase), no permission, wrong PIN
          s.owner.patch(`/invoices/${d.invoice.id}/payments/${d.paid.payments[0].id}`, { method: 'CASH', reason: 'same' }),
          s.owner.post(`/orders/${d.order.id}/amend`, { items: [{ id: randomUUID(), productId: randomUUID(), quantity: 1 }], payment: { method: 'CASH' }, reason: 'fails' }),
          s.cashier.post(`/orders/${d.order.id}/delete`, { reason: 'no' }),
        ]);
        expect(results.map((r) => r.status), JSON.stringify(results.map((r) => r.body?.code))).toEqual([200, 200, 200, 422, 422, 403]);
        must(await s.owner.post(`/orders/${a.order.id}/amend`, { items: [keep(ao.items[0], 2)], payment: { method: 'CARD' }, reason: 'ok' }));
        await expectProtected(`round ${round}`);
        // The failed amend left the bill exactly as it was.
        expect(await getInvoice(d.invoice.id)).toMatchObject({ totalPaise: 27300, paidPaise: 27300, paymentStatus: 'PAID' });
      }
      await expectSeriesHealthy();
      expect(await getInvoice(sentinel.invoice.id)).toMatchObject({ totalPaise: 54600, paidPaise: 54600, refundedPaise: 1000 });
    });

    it('a correction that fails while the protection is lifted (a foreign key inside the erase) leaves it in force afterwards', async () => {
      const sentinel = await paidBill([line(s.menu.paneer.id, 2)]);
      await refund(sentinel.invoice.id, sentinel.paid.payments[0].id, 1000);
      const d = await paidBill();
      const existing = await h.prisma.refund.findFirstOrThrow();
      // A crafted refund row on the sentinel bill that points at d's payment: erasing d's payment hits the foreign key, with the override on.
      await h.prisma.refund.create({
        data: {
          restaurantId: existing.restaurantId, invoiceId: sentinel.invoice.id, paymentId: d.paid.payments[0].id, seriesId: existing.seriesId, number: 2,
          creditNoteNumber: 'C-A1/0000/000002', method: 'CASH', amountPaise: 100, reason: 'crafted', idempotencyKey: randomUUID(),
          businessDate: existing.businessDate, createdById: existing.createdById,
        },
      });
      await h.prisma.numberSeries.update({ where: { id: existing.seriesId }, data: { nextNumber: 3 } });
      const item = (await getOrder(d.order.id)).items[0];
      for (const res of [
        await s.owner.post(`/orders/${d.order.id}/delete`, { reason: 'x' }),
        await s.owner.post(`/orders/${d.order.id}/reopen`, { reason: 'x' }),
        await s.owner.post(`/orders/${d.order.id}/amend`, { items: [keep(item, 2)], payment: { method: 'CASH' }, reason: 'x' }),
      ]) expect([res.status, res.body.code]).toEqual([409, 'IN_USE']);
      await expectProtected('after failures inside the override');
      expect(await getInvoice(d.invoice.id)).toMatchObject({ totalPaise: 27300, paidPaise: 27300, paymentStatus: 'PAID' });
      expect((await getOrder(d.order.id)).status).toBe('SETTLED');
      expect(await h.prisma.auditLog.count({ where: { action: { in: ['order.amended', 'order.reopened', 'order.deleted'] } } })).toBe(0);
      await expectSeriesHealthy();
    });

    it('audit log rows cannot be updated or deleted, even inside a transaction with the override on', async () => {
      const made = await paidBill();
      must(await s.owner.post(`/orders/${made.order.id}/delete`, { reason: 'Gone' }));
      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'order.deleted' } });
      await expect(h.prisma.auditLog.update({ where: { id: audit.id }, data: { reason: 'Edited' } })).rejects.toThrow(/append-only/);
      await expect(h.prisma.auditLog.deleteMany({})).rejects.toThrow(/append-only/);
      await expect(withOverride((tx) => tx.auditLog.update({ where: { id: audit.id }, data: { reason: 'Edited' } }))).rejects.toThrow(/append-only/);
      await expect(withOverride((tx) => tx.auditLog.delete({ where: { id: audit.id } }))).rejects.toThrow(/append-only/);
      await expect(withOverride((tx) => tx.$executeRaw`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
      await expect(withOverride((tx) => tx.$executeRaw`UPDATE audit_logs SET before = NULL`)).rejects.toThrow(/append-only/);
      expect((await h.prisma.auditLog.findUniqueOrThrow({ where: { id: audit.id } })).reason).toBe('Gone');
      // With the override, line tables allow only deletes, never edits.
      const other = await paidBill();
      const item = await h.prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: other.invoice.id } });
      await expect(withOverride((tx) => tx.invoiceItem.update({ where: { id: item.id }, data: { quantity: 5 } }))).rejects.toThrow(/append-only/);
    });

    it('writes one audit entry per correction, with who, why and what was replaced', async () => {
      const a = await paidBill();
      const b = await paidBill();
      const c = await paidBill();
      const d = await paidBill();
      const ao = await getOrder(a.order.id);
      must(await s.owner.post(`/orders/${a.order.id}/amend`, { items: [keep(ao.items[0], 2)], payment: { method: 'CARD' }, reason: 'R-amend' }));
      must(await s.owner.post(`/orders/${b.order.id}/reopen`, { reason: 'R-reopen' }));
      must(await s.owner.post(`/orders/${c.order.id}/delete`, { reason: 'R-delete' }));
      must(await s.owner.patch(`/invoices/${d.invoice.id}/payments/${d.paid.payments[0].id}`, { method: 'UPI', reason: 'R-method' }));
      const rows = await h.prisma.auditLog.findMany({ where: { action: { in: ['order.amended', 'order.reopened', 'order.deleted', 'payment.method_changed'] } }, orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => [r.action, r.reason, r.userId, r.restaurantId])).toEqual([
        ['order.amended', 'R-amend', s.fx.owner.id, s.fx.restaurant.id],
        ['order.reopened', 'R-reopen', s.fx.owner.id, s.fx.restaurant.id],
        ['order.deleted', 'R-delete', s.fx.owner.id, s.fx.restaurant.id],
        ['payment.method_changed', 'R-method', s.fx.owner.id, s.fx.restaurant.id],
      ]);
      for (const row of rows.slice(0, 3)) expect((row.before as any).bills[0]).toMatchObject({ totalPaise: 27300, paidPaise: 27300, payments: [{ method: 'CASH', amountPaise: 27300 }] });
    });
  });

  // ── 5. concurrency ──

  describe('concurrency', () => {
    const tally = (label: string, results: Res[]) => {
      const seen = results.map((r) => `${r.status}${r.body?.code ? ':' + r.body.code : ''}`);
      if (process.env.RACE_LOG) process.stderr.write(`[race] ${label}: ${seen.join(' | ')}\n`);
      return seen;
    };
    /** No orphaned money, no duplicate numbers, each order agrees with its bills. */
    async function expectDatabaseSound() {
      await expectSeriesHealthy();
      const orders = await h.prisma.order.findMany({ include: { invoices: { include: { payments: true } } } });
      for (const order of orders) {
        const standing = order.invoices.filter((i) => i.status === 'ISSUED');
        if (order.status === 'OPEN' || order.status === 'HELD') expect(standing, `open order ${order.orderNumber} has a standing bill`).toHaveLength(0);
        if (order.status === 'BILLED' || order.status === 'SETTLED') {
          expect(standing.length, `billed order ${order.orderNumber} has no bill`).toBeGreaterThan(0);
          expect(standing.reduce((sum, i) => sum + i.totalPaise, 0)).toBe(order.totalPaise);
        }
        if (order.status === 'SETTLED') expect(standing.every((i) => i.paidPaise >= i.totalPaise)).toBe(true);
        for (const invoice of order.invoices) {
          expect(invoice.payments.filter((p) => p.status === 'SUCCESS').reduce((sum, p) => sum + p.amountPaise, 0)).toBe(invoice.paidPaise);
        }
      }
    }

    it('corrections on the latest bills while new bills are issued on the same terminal: no duplicate, no 5xx', async () => {
      for (let round = 0; round < 4; round += 1) {
        const a = await paidBill();
        const b = await paidBill();
        const c = await paidBill();
        const ao = await getOrder(a.order.id);
        const fresh = [];
        for (let i = 0; i < 5; i += 1) fresh.push(must(await saveOrder(s.cashier, { items: [line(s.menu.cola.id)] })));
        const results = await Promise.all([
          s.owner.post(`/orders/${a.order.id}/amend`, { items: [keep(ao.items[0], 2)], payment: { method: 'UPI' }, reason: 'amend' }),
          ...fresh.slice(0, 2).map((order) => s.cashier.post(`/orders/${order.id}/invoices`, {})),
          s.owner.post(`/orders/${c.order.id}/delete`, { reason: 'delete latest' }),
          ...fresh.slice(2, 4).map((order) => s.cashier.post(`/orders/${order.id}/invoices`, {})),
          s.owner.post(`/orders/${b.order.id}/reopen`, { reason: 'reopen' }),
          s.cashier.post(`/orders/${fresh[4].id}/invoices`, {}),
        ]);
        const seen = tally(`round ${round}`, results);
        expect(seen.filter((entry) => !entry.startsWith('200') && !entry.startsWith('201'))).toEqual([]);
        // The amended bill kept its number.
        expect((await getOrder(a.order.id)).invoices[0].invoiceNumber).toBe(a.invoice.invoiceNumber);
        await expectDatabaseSound();
        await h.redis.flushdb();
      }
    });

    it('two amendments of the same order at once: one clean result, never a half-applied change', async () => {
      for (let round = 0; round < 5; round += 1) {
        const a = await paidBill();
        const ao = await getOrder(a.order.id);
        const results = await Promise.all([
          s.owner.post(`/orders/${a.order.id}/amend`, { items: [keep(ao.items[0], 2)], payment: { method: 'UPI' }, reason: 'two' }),
          s.owner.post(`/orders/${a.order.id}/amend`, { items: [keep(ao.items[0], 3)], payment: { method: 'CARD' }, reason: 'three' }),
        ]);
        const seen = tally(`amend×2 round ${round}`, results);
        expect(seen.some((entry) => entry.startsWith('200'))).toBe(true);
        expect(seen.filter((entry) => entry.startsWith('5'))).toEqual([]);
        const { order, invoices } = await expectOrderConsistent(a.order.id);
        expect(invoices).toHaveLength(1);
        expect(invoices[0]!.invoiceNumber).toBe(a.invoice.invoiceNumber);
        expect(invoices[0]!.payments).toHaveLength(1);
        expect([54600, 81900]).toContain(order.totals.totalPaise);
        expect(await h.prisma.auditLog.count({ where: { action: 'order.amended', entityId: a.order.id } })).toBe(seen.filter((entry) => entry.startsWith('200')).length);
        await expectDatabaseSound();
      }
    });

  });

  // ── 6. inputs that should be a 4xx ──

  describe('bad input', () => {
    it('odd bodies on the correction endpoints are refused with a 4xx', async () => {
      const made = await paidBill();
      const item = (await getOrder(made.order.id)).items[0];
      const attempts: [string, object | undefined][] = [
        [`/orders/${made.order.id}/amend`, undefined],
        [`/orders/${made.order.id}/amend`, { items: [keep(item, 0)], reason: 'zero' }],
        [`/orders/${made.order.id}/amend`, { items: [keep(item, 1000)], reason: 'too many' }],
        [`/orders/${made.order.id}/amend`, { items: [keep(item, 1.5)], reason: 'fraction' }],
        [`/orders/${made.order.id}/amend`, { items: [keep(item), keep(item)], reason: 'same line twice' }],
        [`/orders/${made.order.id}/amend`, { items: [keep(item)], reason: 'x', payment: { method: 'CHEQUE' } }],
        [`/orders/${made.order.id}/amend`, { items: [keep(item)], reason: 'x', discount: { type: 'PERCENT', value: 10001 } }],
        [`/orders/${made.order.id}/amend`, { items: [keep(item)], reason: 'x', discount: { type: 'AMOUNT', value: -5 } }],
        [`/orders/${made.order.id}/amend`, { items: [{ ...keep(item), variantId: s.menu.full.id }], reason: 'variant of another product' }],
        [`/orders/${made.order.id}/amend`, { items: [{ ...keep(item), modifierIds: [s.menu.raita.id] }], reason: 'modifier of another product' }],
        [`/orders/${made.order.id}/amend`, { items: [keep(item)], reason: 'x'.repeat(201) }],
        [`/orders/${made.order.id}/amend`, { items: [keep(item)], reason: 'x', approval: { userId: 'nope', pin: '1' } }],
        [`/orders/${randomUUID()}/amend`, { items: [keep(item)], reason: 'x' }],
        [`/orders/not-a-uuid/amend`, { items: [keep(item)], reason: 'x' }],
        [`/orders/${made.order.id}/reopen`, undefined],
        [`/orders/${made.order.id}/reopen`, { reason: '   ' }],
        [`/orders/${randomUUID()}/reopen`, { reason: 'x' }],
        [`/orders/${made.order.id}/delete`, undefined],
        [`/orders/${randomUUID()}/delete`, { reason: 'x' }],
      ];
      const seen: string[] = [];
      for (const [path, body] of attempts) {
        const res = await s.owner.post(path, body);
        if (res.status < 400 || res.status >= 500) seen.push(`${path} ${JSON.stringify(body)?.slice(0, 80)} → ${res.status}`);
      }
      expect(seen).toEqual([]);
      expect(await getInvoice(made.invoice.id)).toMatchObject({ totalPaise: 27300, paidPaise: 27300 });
      await expectSeriesHealthy();
    });
  });

  // ── 7. permissions and tenant isolation ──

  describe('permissions', () => {
    /** A user with the cashier's password and PIN, in a system role or a custom role with the given permissions. */
    async function member(name: string, role: string | string[], fx = s.fx) {
      let roleId = typeof role === 'string' ? fx.roles[role]! : '';
      if (typeof role !== 'string') {
        const permissions = await h.prisma.permission.findMany({ where: { key: { in: role } } });
        roleId = (await h.prisma.role.create({
          data: { restaurantId: fx.restaurant.id, key: `custom-${name}`, name: `Custom ${name}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } },
        })).id;
      }
      const user = await h.prisma.user.create({
        data: { restaurantId: fx.restaurant.id, roleId, name, email: `${name}-${randomUUID().slice(0, 6)}@test.local`, passwordHash: fx.cashier.passwordHash, pinHash: fx.cashier.pinHash },
      });
      const client = h.client();
      must(await client.loginPos(user.email, PASSWORD, { terminalId: fx.terminal.id }));
      return { user, client, approval: { userId: user.id, pin: CASHIER_PIN } };
    }

    it('amend, reopen and delete of a billed order: who may, who may approve, and who may not', async () => {
      const manager = await member('manager', 'manager');
      const captain = await member('captain', 'captain');
      const kitchen = await member('kitchen', 'kitchen');
      const eraser = await member('eraser', ['order.create', 'invoice.delete', 'discount.apply']);
      const eraserOnly = await member('eraseronly', ['invoice.delete']);
      await h.redis.flushdb();
      const other = await scene(h, 'b');
      const anonymous = h.client();
      const pinless = await h.prisma.user.create({ data: { restaurantId: s.fx.restaurant.id, roleId: s.fx.roles.owner!, name: 'No PIN', email: 'nopin@test.local', passwordHash: s.fx.owner.passwordHash } });
      const inactive = await h.prisma.user.create({ data: { restaurantId: s.fx.restaurant.id, roleId: s.fx.roles.owner!, name: 'Gone', email: 'gone@test.local', passwordHash: s.fx.owner.passwordHash, pinHash: s.fx.owner.pinHash, isActive: false } });

      const made = await paidBill();
      const item = (await getOrder(made.order.id)).items[0];
      const bodies: Record<string, object> = {
        amend: { items: [keep(item, 2)], payment: { method: 'CASH' }, reason: 'try' },
        reopen: { reason: 'try' },
        delete: { reason: 'try' },
      };
      for (const action of ['amend', 'reopen', 'delete']) {
        const path = `/orders/${made.order.id}/${action}`;
        const attempt = async (client: TestClient, approval?: object) => {
          const res = await client.post(path, { ...bodies[action], ...(approval ? { approval } : {}) });
          return `${res.status}:${res.body.code}`;
        };
        expect(await attempt(anonymous), action).toBe('401:UNAUTHENTICATED');
        expect(await attempt(kitchen.client), action).toBe('403:FORBIDDEN');
        expect(await attempt(kitchen.client, s.ownerApproval), action).toBe('403:FORBIDDEN');
        expect(await attempt(eraserOnly.client), action).toBe('403:FORBIDDEN');
        expect(await attempt(s.cashier), action).toBe('403:APPROVAL_REQUIRED');
        expect(await attempt(captain.client), action).toBe('403:APPROVAL_REQUIRED');
        expect(await attempt(manager.client), action).toBe('403:APPROVAL_REQUIRED');
        // Approvers who cannot approve this: a manager, the cashier themself, someone of another restaurant, a user without a PIN, a deactivated owner.
        expect(await attempt(s.cashier, manager.approval), action).toBe('403:APPROVAL_INVALID');
        expect(await attempt(manager.client, manager.approval), action).toBe('403:APPROVAL_INVALID');
        expect(await attempt(s.cashier, { userId: s.fx.cashier.id, pin: CASHIER_PIN }), action).toBe('403:APPROVAL_INVALID');
        expect(await attempt(s.cashier, other.ownerApproval), action).toBe('403:APPROVAL_INVALID');
        expect(await attempt(s.cashier, { userId: pinless.id, pin: OWNER_PIN }), action).toBe('403:APPROVAL_INVALID');
        expect(await attempt(s.cashier, { userId: inactive.id, pin: OWNER_PIN }), action).toBe('403:APPROVAL_INVALID');
        expect(await attempt(s.cashier, { userId: s.fx.owner.id, pin: '0000' }), action).toBe('403:APPROVAL_INVALID');
        // Another restaurant cannot see the order at all, with or without its own owner's sign-off.
        expect(await attempt(other.owner), action).toBe('404:NOT_FOUND');
        expect(await attempt(other.cashier, other.ownerApproval), action).toBe('404:NOT_FOUND');
        await h.redis.flushdb();
      }
      // Nothing happened.
      expect(await getInvoice(made.invoice.id)).toMatchObject({ totalPaise: 27300, paidPaise: 27300 });
      expect(await h.prisma.auditLog.count({ where: { action: { in: ['order.amended', 'order.reopened', 'order.deleted'] } } })).toBe(0);

      // Those who may: a captain with the owner's PIN, a custom role that holds the permission, a manager approved by that custom role.
      const amended = must(await captain.client.post(`/orders/${made.order.id}/amend`, { ...bodies.amend, approval: s.ownerApproval }));
      expect(amended.totals.totalPaise).toBe(54600);
      must(await eraser.client.post(`/orders/${made.order.id}/reopen`, bodies.reopen));
      const [again] = must(await s.cashier.post(`/orders/${made.order.id}/invoices`, {}), 201);
      expect(again.invoiceNumber).toBe(num(1));
      must(await manager.client.post(`/orders/${made.order.id}/delete`, { reason: 'ok', approval: eraser.approval }));
      const audits = await h.prisma.auditLog.findMany({ where: { action: { in: ['order.amended', 'order.reopened', 'order.deleted'] } }, orderBy: { createdAt: 'asc' } });
      expect(audits.map((a) => [a.action, a.userId, (a.after as any).approvedBy])).toEqual([
        ['order.amended', captain.user.id, s.fx.owner.id],
        ['order.reopened', eraser.user.id, null],
        ['order.deleted', manager.user.id, eraser.user.id],
      ]);
    });

    it('five wrong PINs lock approvals by that approver, including a correct PIN afterwards', async () => {
      const made = await paidBill();
      const wrong = { reason: 'guess', approval: { userId: s.fx.owner.id, pin: '0000' } };
      for (let i = 0; i < 5; i += 1) expect((await s.cashier.post(`/orders/${made.order.id}/reopen`, wrong)).body.code).toBe('APPROVAL_INVALID');
      const locked = await s.cashier.post(`/orders/${made.order.id}/reopen`, { reason: 'now right', approval: s.ownerApproval });
      expect([locked.status, locked.body.code]).toEqual([429, 'APPROVAL_LOCKED']);
      expect(await h.prisma.invoice.count()).toBe(1);
    });

    it('payment method change: owner, manager and a role holding only that permission; nobody else', async () => {
      const manager = await member('manager', 'manager');
      const fixer = await member('fixer', ['payment.change_method']);
      const captain = await member('captain', 'captain');
      const made = await paidBill();
      const path = `/invoices/${made.invoice.id}/payments/${made.paid.payments[0].id}`;
      expect((await h.client().patch(path, { method: 'UPI', reason: 'x' })).status).toBe(401);
      expect((await s.cashier.patch(path, { method: 'UPI', reason: 'x' })).status).toBe(403);
      expect((await captain.client.patch(path, { method: 'UPI', reason: 'x' })).status).toBe(403);
      // There is no PIN approval path for this one.
      expect((await s.cashier.patch(path, { method: 'UPI', reason: 'x', approval: s.ownerApproval })).status).toBe(403);
      expect((await h.prisma.payment.findFirstOrThrow()).method).toBe('CASH');
      must(await manager.client.patch(path, { method: 'UPI', reason: 'manager' }));
      must(await fixer.client.patch(path, { method: 'CARD', reason: 'fixer' }));
      must(await s.owner.patch(path, { method: 'OTHER', reason: 'owner' }));
      expect((await h.prisma.auditLog.findMany({ where: { action: 'payment.method_changed' }, orderBy: { createdAt: 'asc' } })).map((a) => a.userId)).toEqual([manager.user.id, fixer.user.id, s.fx.owner.id]);
    });

    it('reports: only report.view or a share opens a report; sharing is for report.share and stays inside the restaurant', async () => {
      const manager = await member('manager', 'manager');
      const captain = await member('captain', 'captain');
      await paidBill();
      await h.redis.flushdb();
      const other = await scene(h, 'b');
      const theirs = await billed(other.cashier, [line(other.menu.cola.id, 3)]);
      must(await pay(other.cashier, theirs.invoice.id, [{ method: 'UPI', amountPaise: 17700 }]));

      // Cashier: nothing available, nothing runs, no sharing, no dashboard.
      expect(must(await s.cashier.get('/reports/available'))).toEqual({ all: false, types: [] });
      expect((await s.cashier.get(`/reports/sales-daily?${range}`)).status).toBe(403);
      expect((await s.cashier.get(`/reports/sales-daily/export?${range}&format=csv`)).status).toBe(403);
      expect((await s.cashier.get('/reports/sharing')).status).toBe(403);
      expect((await s.cashier.put('/reports/sales-daily/sharing', { userIds: [s.fx.cashier.id] })).status).toBe(403);
      expect((await s.cashier.get('/dashboard')).status).toBe(403);
      expect((await h.client().get('/reports/available')).status).toBe(401);
      expect((await h.client().get(`/reports/sales-daily?${range}`)).status).toBe(401);

      // Manager shares two reports with the cashier; a share to a stranger or an unknown report is refused.
      expect((await manager.client.put('/reports/sales-daily/sharing', { userIds: [other.fx.cashier.id] })).status).toBe(422);
      expect((await manager.client.put('/reports/sales-daily/sharing', { userIds: [s.fx.cashier.id, other.fx.cashier.id] })).status).toBe(422);
      expect((await manager.client.put('/reports/nonsense/sharing', { userIds: [s.fx.cashier.id] })).status).toBe(400);
      expect((await manager.client.put('/reports/sales-daily/sharing', { userIds: ['x'] })).status).toBe(400);
      expect(await h.prisma.reportShare.count()).toBe(0);
      const sharing = must(await manager.client.put('/reports/sales-daily/sharing', { userIds: [s.fx.cashier.id] }));
      must(await manager.client.put('/reports/payments/sharing', { userIds: [s.fx.cashier.id, captain.user.id] }));
      expect(sharing.shares).toEqual({ 'sales-daily': [s.fx.cashier.id] });
      expect(sharing.candidates.map((c: any) => c.name).sort()).toEqual(['Cashier', 'captain']);

      expect(must(await s.cashier.get('/reports/available'))).toEqual({ all: false, types: ['sales-daily', 'payments'] });
      expect(figure(await report('sales-daily', range, s.cashier), 'Total sales amount')).toBe(27300);
      expect((await s.cashier.get(`/reports/sales-daily/export?${range}&format=csv`)).status).toBe(200);
      for (const type of ['sales-monthly', 'orders', 'items', 'item-summary', 'categories', 'gst', 'hsn', 'payment-summary', 'discounts', 'refunds', 'cancellations', 'cashiers']) {
        expect((await s.cashier.get(`/reports/${type}?${range}`)).status, type).toBe(403);
        expect((await s.cashier.get(`/reports/${type}/export?${range}&format=csv`)).status, type).toBe(403);
      }
      expect((await captain.client.get(`/reports/sales-daily?${range}`)).status).toBe(403);
      expect((await captain.client.get(`/reports/payments?${range}`)).status).toBe(200);

      // The other restaurant sees neither the shares nor the figures, and cannot change them.
      expect(must(await other.owner.get('/reports/sharing')).shares).toEqual({});
      expect(figure(await report('sales-daily', range, other.owner), 'Total sales amount')).toBe(17700);
      must(await other.owner.put('/reports/sales-daily/sharing', { userIds: [] }));
      expect(await h.prisma.reportShare.count({ where: { reportType: 'sales-daily' } })).toBe(1);
      expect(must(await other.cashier.get('/reports/available'))).toEqual({ all: false, types: [] });
      expect((await other.cashier.get(`/reports/sales-daily?${range}`)).status).toBe(403);

      // Unsharing closes the report again; a deactivated user cannot be shared with.
      must(await s.owner.put('/reports/sales-daily/sharing', { userIds: [] }));
      expect((await s.cashier.get(`/reports/sales-daily?${range}`)).status).toBe(403);
      await h.prisma.user.update({ where: { id: captain.user.id }, data: { isActive: false } });
      expect((await s.owner.put('/reports/gst/sharing', { userIds: [captain.user.id] })).status).toBe(422);
      expect(await h.prisma.auditLog.count({ where: { action: 'report.shared', restaurantId: s.fx.restaurant.id } })).toBe(3);
      expect((await s.owner.get(`/reports/nonsense?${range}`)).status).toBe(400);
      expect((await s.owner.get('/reports/sales-daily')).status).toBe(400);
      expect((await s.owner.get(`/reports/sales-daily?from=${TODAY}&to=2020-01-01`)).status).toBe(400);
      expect((await s.owner.get(`/reports/sales-daily/export?${range}&format=exe`)).status).toBe(400);
    });

    it('back office sign-in needs backoffice.access: login, refresh and PIN switch on web, pos and kds', async () => {
      const attempt = async (email: string, client: string, password = PASSWORD) => {
        const res = await h.client().login(email, password, { client });
        return `${res.status}:${res.body.code ?? 'ok'}`;
      };
      expect(await attempt(s.fx.owner.email, 'web')).toBe('200:ok');
      expect(await attempt(s.fx.cashier.email, 'web')).toBe('403:BACKOFFICE_NOT_ALLOWED');
      expect(await attempt(s.fx.cashier.email, 'pos')).toBe('200:ok');
      expect(await attempt(s.fx.cashier.email, 'kds')).toBe('200:ok');
      // A wrong password says nothing about the account, even for a billing-only one.
      expect(await attempt(s.fx.cashier.email, 'web', 'wrong password')).toBe('401:INVALID_CREDENTIALS');
      expect(await attempt(s.fx.cashier.email, 'backoffice')).toBe('400:VALIDATION_FAILED');
      await h.redis.flushdb();

      // Custom roles: without the permission billing only, with it the back office opens.
      const permissions = await h.prisma.permission.findMany({ where: { key: { in: ['order.create', 'report.view', 'dashboard.view'] } } });
      const role = await h.prisma.role.create({ data: { restaurantId: s.fx.restaurant.id, key: 'supervisor', name: 'Supervisor', permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
      const supervisor = await h.prisma.user.create({ data: { restaurantId: s.fx.restaurant.id, roleId: role.id, name: 'Supervisor', email: 'supervisor@test.local', passwordHash: s.fx.cashier.passwordHash, pinHash: s.fx.cashier.pinHash } });
      expect(await attempt(supervisor.email, 'web')).toBe('403:BACKOFFICE_NOT_ALLOWED');
      expect(await attempt(supervisor.email, 'pos')).toBe('200:ok');
      const access = await h.prisma.permission.findUniqueOrThrow({ where: { key: 'backoffice.access' } });
      await h.prisma.rolePermission.create({ data: { roleId: role.id, permissionId: access.id } });
      await h.redis.flushdb();
      const web = h.client();
      must(await web.login(supervisor.email));
      must(await web.get('/dashboard'));

      // The role loses the permission: the session ends at its next renewal, and the old token stops working.
      await h.prisma.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: access.id } });
      await h.redis.flushdb();
      const renewed = await web.post('/auth/refresh', { client: 'web' });
      expect([renewed.status, renewed.body.code]).toEqual([403, 'BACKOFFICE_NOT_ALLOWED']);
      expect((await web.get('/dashboard')).status).toBe(401);
      expect((await web.post('/auth/refresh', { client: 'web' })).status).toBe(401);

      // PIN switch: on the owner's back-office session a cashier's PIN is refused and the owner stays signed in; on the POS it works.
      const office = h.client();
      must(await office.login(s.fx.owner.email));
      const refused = await office.post('/auth/pin-login', { client: 'web', userId: s.fx.cashier.id, pin: CASHIER_PIN });
      expect([refused.status, refused.body.code]).toEqual([403, 'BACKOFFICE_NOT_ALLOWED']);
      must(await office.get('/dashboard'));
      must(await office.post('/auth/refresh', { client: 'web' }));
      // A back-office cookie is not accepted as a POS or kitchen session, and the other way round.
      expect((await office.post('/auth/refresh', { client: 'pos' })).status).toBe(401);
      expect((await office.post('/auth/pin-login', { client: 'pos', userId: s.fx.cashier.id, pin: CASHIER_PIN })).status).toBe(401);
      const till = h.client();
      must(await till.loginPos(s.fx.owner.email, PASSWORD, { terminalId: s.fx.terminal.id }));
      expect((await till.post('/auth/refresh', { client: 'web' })).status).toBe(401);
      expect((await till.post('/auth/pin-login', { client: 'web', userId: s.fx.owner.id, pin: OWNER_PIN })).status).toBe(401);
      const switched = must(await till.post('/auth/pin-login', { client: 'pos', userId: s.fx.cashier.id, pin: CASHIER_PIN }));
      expect(switched.user).toMatchObject({ id: s.fx.cashier.id, terminalId: s.fx.terminal.id });
      expect(switched.user.permissions).not.toContain('backoffice.access');
    });
  });

  // ── 8. reports after corrections; paymentMethods ──

  describe('reports and order lists after corrections', () => {
    it('every report and the dashboard agree with the bills and payments that remain', async () => {
      // Written for bill numbers that stay put after an erase, which is what manual renumbering gives.
      await s.owner.patch('/settings', { orderRenumberMode: 'MANUAL' }).expect(200);
      // A day of trading followed by every kind of correction.
      const plain = await paidBill([line(s.menu.paneer.id, 2), line(s.menu.cola.id, 1)], 'CASH');
      const discounted = await paidBill([line(s.menu.chicken.id, 1, { variantId: s.menu.full.id })], 'CARD', { discount: { type: 'PERCENT', value: 1000, reason: 'Regular' } });
      const toAmend = await paidBill([line(s.menu.paneer.id, 1)], 'CASH');
      const toDelete = await paidBill([line(s.menu.cola.id, 5)], 'UPI');
      const toReopen = await paidBill([line(s.menu.biryani.id, 1, { modifierIds: [s.menu.mild.id] })], 'UPI');
      const toSwitch = await paidBill([line(s.menu.cola.id, 2)], 'CASH');
      const refunded = await paidBill([line(s.menu.paneer.id, 1)], 'UPI');
      await refund(refunded.invoice.id, refunded.paid.payments[0].id, 7300);
      const unpaid = await billed(s.cashier, [line(s.menu.cola.id, 1)]);
      const cancelled = await billed(s.cashier, [line(s.menu.cola.id, 1)]);
      must(await s.owner.post(`/invoices/${cancelled.invoice.id}/cancel`, { reason: 'Twice' }));

      const item = (await getOrder(toAmend.order.id)).items[0];
      must(await s.owner.post(`/orders/${toAmend.order.id}/amend`, {
        items: [keep(item, 3), line(s.menu.cola.id, 2, { discount: { type: 'AMOUNT', value: 500 } })], discount: { type: 'PERCENT', value: 500 }, payment: { method: 'UPI' }, reason: 'More',
      }));
      must(await s.owner.post(`/orders/${toDelete.order.id}/delete`, { reason: 'Test' }));
      must(await s.owner.post(`/orders/${toReopen.order.id}/reopen`, { reason: 'Fix' }));
      must(await s.owner.patch(`/invoices/${toSwitch.invoice.id}/payments/${toSwitch.paid.payments[0].id}`, { method: 'CARD', reason: 'Card' }));

      // The truth, straight from the tables.
      // Sales are the bills of completed orders; the GST reports also take the one bill nobody has paid yet.
      const issued = await h.prisma.invoice.findMany({ where: { status: 'ISSUED' }, include: { items: true } });
      const invoices = await h.prisma.invoice.findMany({ where: { status: 'ISSUED', order: { status: 'SETTLED' } }, include: { items: true } });
      const payments = await h.prisma.payment.findMany({ where: { status: 'SUCCESS' } });
      const refunds = await h.prisma.refund.findMany();
      const sumOf = <T>(rows: T[], pick: (row: T) => number) => rows.reduce((sum, row) => sum + pick(row), 0);
      const truth = {
        bills: invoices.length,
        total: sumOf(invoices, (i) => i.totalPaise),
        gross: sumOf(invoices, (i) => i.grossPaise),
        discount: sumOf(invoices, (i) => i.discountPaise),
        taxable: sumOf(invoices, (i) => i.taxablePaise),
        tax: sumOf(invoices, (i) => i.cgstPaise + i.sgstPaise + i.igstPaise + i.cessPaise),
        units: sumOf(invoices.flatMap((i) => i.items), (item) => item.quantity),
        lineTotal: sumOf(invoices.flatMap((i) => i.items), (item) => item.totalPaise),
        received: sumOf(payments, (p) => p.amountPaise),
        by: (method: string) => sumOf(payments.filter((p) => p.method === method), (p) => p.amountPaise),
        refunded: sumOf(refunds, (r) => r.amountPaise),
        refundTaxable: sumOf(refunds, (r) => r.taxablePaise),
        refundTax: sumOf(refunds, (r) => r.cgstPaise + r.sgstPaise + r.igstPaise + r.cessPaise),
      };
      expect(truth.bills).toBe(5); // plain, discounted, amended, switched, refunded
      expect(issued.map((i) => i.id).filter((id) => !invoices.some((i) => i.id === id))).toEqual([unpaid.invoice.id]);
      const taxOf = (i: (typeof issued)[number]) => i.cgstPaise + i.sgstPaise + i.igstPaise + i.cessPaise;
      const onPaper = {
        bills: issued.length, taxable: sumOf(issued, (i) => i.taxablePaise), tax: sumOf(issued, taxOf),
        units: sumOf(issued.flatMap((i) => i.items), (item) => item.quantity), lineTotal: sumOf(issued.flatMap((i) => i.items), (item) => item.totalPaise),
      };
      expect(await h.prisma.payment.count()).toBe(5);

      for (const type of ['sales-daily', 'sales-monthly']) {
        const sales = await report(type);
        expect(sales.rows, type).toHaveLength(1);
        expect(sales.rows[0], type).toMatchObject({
          bills: truth.bills, unit: truth.units, gross: truth.gross, discount: truth.discount, taxable: truth.taxable, total: truth.total,
          cash: truth.by('CASH'), upi: truth.by('UPI'), card: truth.by('CARD'), other: 0, refunds: truth.refunded, net: truth.total - truth.refunded,
        });
        expect(sales.rows[0]!.cgst + sales.rows[0]!.sgst + sales.rows[0]!.igst).toBe(truth.tax);
        expect(figure(sales, 'Total sales (receipts)')).toBe(truth.bills);
        expect(figure(sales, 'Total sales quantity')).toBe(truth.units);
        expect(figure(sales, 'Total sales amount')).toBe(truth.total);
      }
      const items = await report('items');
      expect([figure(items, 'Total sales (receipts)'), figure(items, 'Total sales quantity'), figure(items, 'Total sales amount')]).toEqual([truth.bills, truth.units, truth.lineTotal]);
      expect(items.totals).toMatchObject({ unit: truth.units, amount: truth.gross, discount: truth.discount, tax: truth.tax, total: truth.lineTotal });
      // No line of a deleted, reopened or replaced bill is left behind.
      expect(new Set(items.rows.map((row) => row.receipt))).toEqual(new Set(invoices.map((i) => i.invoiceNumber)));
      for (const type of ['item-summary', 'categories']) {
        const r = await report(type);
        expect(r.totals, type).toMatchObject({ quantity: truth.units, gross: truth.gross, discount: truth.discount, taxable: truth.taxable, tax: truth.tax, total: truth.lineTotal });
      }
      const hsn = await report('hsn');
      expect(hsn.totals).toMatchObject({ quantity: onPaper.units, taxable: onPaper.taxable, total: onPaper.lineTotal });
      const gst = await report('gst');
      expect(figure(gst, 'Receipts issued')).toBe(onPaper.bills);
      expect(figure(gst, 'Net taxable value')).toBe(onPaper.taxable - truth.refundTaxable);
      expect(figure(gst, 'Net tax')).toBe(onPaper.tax - truth.refundTax);
      expect(gst.note).toContain('Includes 1 bill(s) worth ₹59.00 still waiting for payment');
      for (const type of ['payments', 'payment-summary']) {
        const r = await report(type);
        expect([figure(r, 'Payments'), figure(r, 'Total received'), figure(r, 'Net after refunds')], type).toEqual([payments.length, truth.received, truth.received - truth.refunded]);
      }
      expect((await report('payments')).rows.map((row) => row.receipt).sort()).toEqual(payments.map((p) => invoices.find((i) => i.id === p.invoiceId)!.invoiceNumber).sort());
      const cashiers = await report('cashiers');
      expect(cashiers.totals).toMatchObject({ bills: truth.bills, unit: truth.units, gross: truth.gross, discount: truth.discount, billed: truth.total, collected: truth.received, cash: truth.by('CASH'), upi: truth.by('UPI'), card: truth.by('CARD'), refunds: truth.refunded, cancelled: 1 });
      // The amended payment stays with the cashier who took the original one.
      expect(cashiers.rows.find((row) => row.name === 'Cashier')).toMatchObject({ collected: truth.received, bills: truth.bills });
      const discounts = await report('discounts');
      expect(figure(discounts, 'Total discount')).toBe(truth.discount);
      expect(cashiers.totals!.discounts).toBe(truth.discount);
      expect(figure(await report('refunds'), 'Total refunded')).toBe(truth.refunded);
      expect((await report('cancellations')).rows.map((row) => row.bill)).toEqual([cancelled.invoice.invoiceNumber]);

      const orders = await report('orders');
      // Completed orders only: the reopened order and the one waiting for payment are not among them.
      expect(orders.rows).toHaveLength(await h.prisma.order.count({ where: { status: 'SETTLED' } }));
      expect(orders.rows.every((row) => row.status === 'Settled')).toBe(true);
      expect(orders.rows.find((row) => row.bills === toSwitch.invoice.invoiceNumber)).toMatchObject({ method: 'Card', status: 'Settled' });
      expect(orders.rows.find((row) => row.bills === toAmend.invoice.invoiceNumber)).toMatchObject({ method: 'UPI', status: 'Settled', unit: 5 });
      expect(orders.rows.some((row) => row.bills === unpaid.invoice.invoiceNumber)).toBe(false);
      expect(orders.rows.some((row) => String(row.bills).includes(toDelete.invoice.invoiceNumber))).toBe(false);

      const dash = must(await s.owner.get('/dashboard'));
      expect(dash.sales).toMatchObject({ totalPaise: truth.total, bills: truth.bills, discountPaise: truth.discount, refundsPaise: truth.refunded, netPaise: truth.total - truth.refunded });
      expect(dash.unpaid).toEqual({ bills: 1, amountPaise: 5900 });
      expect(Object.fromEntries(dash.payments.map((p: any) => [p.method, p.amountPaise]))).toEqual({ CASH: truth.by('CASH'), UPI: truth.by('UPI'), CARD: truth.by('CARD') });
      expect(dash.orders).toEqual({ taken: 8, running: 2, cancelled: 1 });
      // The list of recent bills shows every bill, whatever its state.
      expect(dash.recentBills.map((b: any) => b.invoiceNumber).sort()).toEqual([...issued.map((i) => i.invoiceNumber), cancelled.invoice.invoiceNumber].sort());
      expect(dash.trend[6]).toMatchObject({ date: TODAY, totalPaise: truth.total, bills: truth.bills });
      expect(sumOf(dash.topItems as any[], (t) => t.quantity)).toBe(truth.units);
      await expectSeriesHealthy();
      expect([plain.invoice.invoiceNumber, discounted.invoice.invoiceNumber]).toEqual([num(1), num(2)]);
    });

    it('a bill of an earlier day amended today: its payment stays on that day, and both days add up', async () => {
      const yesterday = new Date(new Date(`${TODAY}T00:00:00.000Z`).getTime() - 86_400_000);
      const day = yesterday.toISOString().slice(0, 10);
      const old = await paidBill([line(s.menu.paneer.id, 1)], 'CASH');
      const oldUnpaid = await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
      await withOverride(async (tx) => {
        await tx.invoice.updateMany({ data: { businessDate: yesterday } });
        await tx.payment.updateMany({ data: { businessDate: yesterday, paidAt: new Date(yesterday.getTime() + 13 * 3_600_000) } });
      });
      await h.prisma.order.updateMany({ data: { businessDate: yesterday } });
      const todayBill = await paidBill([line(s.menu.cola.id, 1)], 'UPI');

      const a = (await getOrder(old.order.id)).items[0];
      must(await s.owner.post(`/orders/${old.order.id}/amend`, { items: [keep(a, 2)], payment: { method: 'CARD' }, reason: 'Two' }));
      const b = (await getOrder(oldUnpaid.order.id)).items[0];
      must(await s.owner.post(`/orders/${oldUnpaid.order.id}/amend`, { items: [keep(b, 3)], payment: { method: 'CASH' }, reason: 'Three, paid now' }));

      const past = `from=${day}&to=${day}`;
      const then = await report('sales-daily', past);
      // Both bills stay on their day. The replaced payment stays there too; the bill that was unpaid is paid today.
      expect(then.rows).toEqual([expect.objectContaining({ period: day, bills: 2, total: 54600 + 81900, card: 54600, cash: 0, upi: 0 })]);
      const now = await report('sales-daily');
      expect(now.rows).toEqual([expect.objectContaining({ period: TODAY, bills: 1, total: 5900, upi: 5900, cash: 81900, card: 0 })]);
      const both = await report('sales-daily', `from=${day}&to=${TODAY}`);
      expect(both.totals).toMatchObject({ bills: 3, total: 142400, cash: 81900, card: 54600, upi: 5900 });
      expect(figure(await report('payments', past), 'Total received')).toBe(54600);
      expect((await report('payments', past)).rows[0]!.date).toBe(new Date(yesterday.getTime() + 13 * 3_600_000).toISOString());
      expect(figure(await report('payment-summary', past), 'Total received')).toBe(54600);
      expect((await report('cashiers', past)).totals).toMatchObject({ billed: 136500, collected: 54600 });
      expect((await report('orders', past)).rows).toHaveLength(2);
      const dash = must(await s.owner.get('/dashboard'));
      expect(dash.sales).toMatchObject({ bills: 1, totalPaise: 5900 });
      expect(dash.trend[5]).toMatchObject({ date: day, bills: 2, totalPaise: 136500 });
      expect(Object.fromEntries(dash.payments.map((p: any) => [p.method, p.amountPaise]))).toEqual({ UPI: 5900, CASH: 81900 });
      expect(todayBill.invoice.invoiceNumber).toBe(num(3));
      await expectSeriesHealthy();
    });

    it('paymentMethods is the same in the list, the single order and running orders, through every change', async () => {
      const look = async (orderId: string) => {
        const single = (await getOrder(orderId)).paymentMethods;
        const listed = must(await s.owner.get(`/orders?${range}&pageSize=100`)).items.find((row: any) => row.id === orderId)?.paymentMethods;
        const running = must(await s.owner.get('/orders/running')).find((row: any) => row.id === orderId)?.paymentMethods;
        expect(listed).toEqual(single);
        if (running !== undefined) expect(running).toEqual(single);
        return single;
      };
      // Split into two bills: part payments by card and UPI on one, other by cash.
      const order = must(await saveOrder(s.cashier, { items: [line(s.menu.paneer.id, 1), line(s.menu.cola.id, 1)] }));
      expect(await look(order.id)).toEqual([]);
      const [one, two] = must(await s.cashier.post(`/orders/${order.id}/invoices`, { parts: [[{ orderItemId: order.items[0].id, quantity: 1 }], [{ orderItemId: order.items[1].id, quantity: 1 }]] }), 201);
      expect(await look(order.id)).toEqual([]);
      const paidOne = must(await pay(s.cashier, one.id, [{ method: 'CARD', amountPaise: 7300 }]));
      expect(await look(order.id)).toEqual(['CARD']);
      must(await pay(s.cashier, one.id, [{ method: 'UPI', amountPaise: 20000 }]));
      const paidTwo = must(await pay(s.cashier, two.id, [{ method: 'CASH', amountPaise: 5900 }]));
      expect(await look(order.id)).toEqual(['CASH', 'UPI', 'CARD']);
      // A payment that did not go through is not a way the order was paid.
      await h.prisma.payment.create({ data: { restaurantId: s.fx.restaurant.id, invoiceId: one.id, method: 'OTHER', status: 'FAILED', amountPaise: 100, idempotencyKey: randomUUID(), businessDate: new Date(`${TODAY}T00:00:00.000Z`), receivedById: s.fx.cashier.id } });
      expect(await look(order.id)).toEqual(['CASH', 'UPI', 'CARD']);
      must(await s.owner.patch(`/invoices/${one.id}/payments/${paidOne.payments[0].id}`, { method: 'UPI', reason: 'All UPI' }));
      expect(await look(order.id)).toEqual(['CASH', 'UPI']);
      // The cash bill is refunded in full and cancelled: cash no longer describes the order.
      await refund(two.id, paidTwo.payments[0].id, 5900);
      expect(await look(order.id)).toEqual(['CASH', 'UPI']);
      must(await s.owner.post(`/invoices/${two.id}/cancel`, { reason: 'Returned' }));
      expect(await look(order.id)).toEqual(['UPI']);
      // Amended and left unpaid: nothing; reopened: nothing.
      const now = await getOrder(order.id);
      must(await s.owner.post(`/orders/${order.id}/amend`, { items: now.items.map((i: any) => keep(i)), reason: 'Unpaid again' }));
      expect(await look(order.id)).toEqual([]);
      must(await s.owner.post(`/orders/${order.id}/reopen`, { reason: 'Open again' }));
      expect(await look(order.id)).toEqual([]);
      // Another restaurant's lists never show it.
      await h.redis.flushdb();
      const other = await scene(h, 'b');
      expect(must(await other.owner.get('/orders/running'))).toEqual([]);
      expect(must(await other.owner.get(`/orders?${range}`)).total).toBe(0);
      expect((await other.owner.get(`/orders/${order.id}`)).status).toBe(404);
    });
  });

  // ── 9. further checks ──

  describe('further checks', () => {
    it('amend and tables: unpaid amend of a settled table order, paid amend of an unpaid one, table taken meanwhile', async () => {
      const tableStatus = async (id: string) => (await h.prisma.diningTable.findUniqueOrThrow({ where: { id } })).status;
      const dineIn = async (tableId: string) => {
        const order = must(await saveOrder(s.cashier, { type: 'DINE_IN', tableId, items: [line(s.menu.paneer.id, 1)] }));
        const [invoice] = must(await s.cashier.post(`/orders/${order.id}/invoices`, {}), 201);
        return { order, invoice };
      };
      // Settled, table free → amended and left unpaid: it is a running order at its table again.
      const one = await dineIn(s.menu.t1.id);
      await payFull(one.invoice);
      expect(await tableStatus(s.menu.t1.id)).toBe('FREE');
      const a = must(await s.owner.post(`/orders/${one.order.id}/amend`, { items: [keep(one.order.items[0], 2)], reason: 'Unpaid' }));
      expect(a).toMatchObject({ status: 'BILLED', tableId: s.menu.t1.id });
      expect(await tableStatus(s.menu.t1.id)).toBe('BILL_PRINTED');
      expect(must(await s.cashier.get('/tables')).find((t: any) => t.id === s.menu.t1.id)).toMatchObject({ orderId: one.order.id, orderTotalPaise: 54600 });
      // Unpaid at its table → amended as paid: settled, table free.
      const b = must(await s.owner.post(`/orders/${one.order.id}/amend`, { items: [keep(one.order.items[0], 1)], payment: { method: 'CASH' }, reason: 'Paid' }));
      expect(b).toMatchObject({ status: 'SETTLED', tableId: s.menu.t1.id });
      expect(await tableStatus(s.menu.t1.id)).toBe('FREE');
      // Table taken by other guests → amended and left unpaid: runs without a table and does not disturb them; paying it leaves their table alone.
      const guests = must(await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.cola.id, 1)] }));
      const c = must(await s.owner.post(`/orders/${one.order.id}/amend`, { items: [keep(one.order.items[0], 3)], reason: 'Unpaid, table taken' }));
      expect(c).toMatchObject({ status: 'BILLED', tableId: null, type: 'DINE_IN' });
      expect(await tableStatus(s.menu.t1.id)).toBe('OCCUPIED');
      await payFull(c.invoices[0]);
      expect(await tableStatus(s.menu.t1.id)).toBe('OCCUPIED');
      expect((await getOrder(guests.id)).status).toBe('OPEN');
      // A blocked table stays blocked through an amend.
      const two = await dineIn(s.menu.t2.id);
      await payFull(two.invoice);
      await h.prisma.diningTable.update({ where: { id: s.menu.t2.id }, data: { status: 'BLOCKED' } });
      const d = must(await s.owner.post(`/orders/${two.order.id}/amend`, { items: [keep(two.order.items[0], 2)], payment: { method: 'UPI' }, reason: 'Blocked table' }));
      expect(d).toMatchObject({ status: 'SETTLED', tableId: s.menu.t2.id });
      expect(await tableStatus(s.menu.t2.id)).toBe('BLOCKED');
      const e = must(await s.owner.post(`/orders/${two.order.id}/reopen`, { reason: 'Blocked table' }));
      expect(e).toMatchObject({ status: 'OPEN', tableId: null });
      expect(await tableStatus(s.menu.t2.id)).toBe('BLOCKED');
      await expectSeriesHealthy();
    });

    it('amend keeps an inter-state place of supply, and the amended bill still renders as a PDF', async () => {
      const order = must(await saveOrder(s.cashier, { items: [line(s.menu.paneer.id, 1)] }));
      const [invoice] = must(await s.cashier.post(`/orders/${order.id}/invoices`, { placeOfSupply: '29' }), 201);
      expect(invoice).toMatchObject({ isInterState: true, igstPaise: 1300, cgstPaise: 0 });
      const amended = must(await s.owner.post(`/orders/${order.id}/amend`, { items: [keep(order.items[0], 2)], payment: { method: 'CASH' }, reason: 'Two' }));
      const bill = await getInvoice(amended.invoices[0].id);
      expect(bill).toMatchObject({ placeOfSupply: '29', isInterState: true, igstPaise: 2600, cgstPaise: 0, sgstPaise: 0, totalPaise: 54600 });
      const pdf = await s.owner.get(`/invoices/${bill.id}/pdf`);
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      // The old bill id is gone everywhere.
      expect((await s.owner.get(`/invoices/${invoice.id}`)).status).toBe(404);
      expect((await s.owner.get(`/invoices/${invoice.id}/pdf`)).status).toBe(404);
      expect((await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 100 }])).status).toBe(404);
      expect((await s.owner.post(`/invoices/${invoice.id}/cancel`, { reason: 'x' })).status).toBe(404);
    });

    it('amend refuses products, variants and modifiers of another restaurant, and changes nothing', async () => {
      const made = await paidBill();
      const item = (await getOrder(made.order.id)).items[0];
      const other = await scene(h, 'b');
      const theirs = must(await saveOrder(other.cashier, { items: [line(other.menu.cola.id, 1)] }));
      const tries = [
        [keep(item), line(other.menu.cola.id, 1)],
        [keep(item), line(s.menu.chicken.id, 1, { variantId: other.menu.half.id })],
        [keep(item), line(s.menu.biryani.id, 1, { modifierIds: [s.menu.mild.id, other.menu.raita.id] })],
        [keep(item), { id: theirs.items[0].id, productId: s.menu.cola.id, quantity: 1 }],
      ];
      for (const items of tries) {
        const res = await s.owner.post(`/orders/${made.order.id}/amend`, { items, payment: { method: 'CASH' }, reason: 'x' });
        expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      }
      expect(await getInvoice(made.invoice.id)).toMatchObject({ totalPaise: 27300, paidPaise: 27300 });
      expect((await getOrder(theirs.id, other.owner)).items).toHaveLength(1);
      await expectSeriesHealthy();
    });
  });
});
