import { randomUUID } from 'node:crypto';
import { businessDateOf } from '@pos/billing-core';
import { PAPER_COLUMNS, type PrintDocument } from '@pos/types';
import { FY, line, pay, saveOrder, type Scene, scene } from './support/billing.js';
import { createHarness, type Harness, PASSWORD, type TestClient } from './support/harness.js';

/**
 * Independent POS audit (2026-11-24). Expected amounts here were worked out by hand from the GST rules,
 * not copied from the bill engine, and the race tests aim at the gaps the earlier suites did not cover:
 * state changes and kitchen sends racing a bill, two terminals claiming one table, and opposite merges.
 */
const TODAY = businessDateOf(new Date());

describe('POS audit', () => {
  let h: Harness;
  let s: Scene;
  /** A second billing counter, signed in as the same cashier: the multi-terminal case. */
  let t2: TestClient;

  beforeAll(async () => {
    h = await createHarness();
  });
  beforeEach(async () => {
    await h.reset();
    s = await scene(h);
    const counter2 = await h.prisma.terminal.create({ data: { restaurantId: s.fx.restaurant.id, code: 'B2', name: 'Counter 2' } });
    t2 = h.client();
    await t2.login(s.fx.cashier.email, PASSWORD, { client: 'pos', terminalId: counter2.id });
    // Every product goes to the kitchen, cola to its own bar station, as in a real restaurant.
    const bar = await h.prisma.kitchenStation.create({ data: { restaurantId: s.fx.restaurant.id, name: 'Bar' } });
    await h.prisma.product.updateMany({ where: { restaurantId: s.fx.restaurant.id }, data: { stationId: s.fx.station.id } });
    await h.prisma.product.update({ where: { id: s.menu.cola.id }, data: { stationId: bar.id } });
  });
  afterAll(async () => {
    await h.close();
  });

  const settings = (patch: object) => s.owner.patch('/settings', patch).expect(200);
  const order = async (id: string) => (await s.owner.get(`/orders/${id}`).expect(200)).body;
  const issue = (client: TestClient, orderId: string, body: object = {}) => client.post(`/orders/${orderId}/invoices`, body);
  const must = <T extends { status: number; body: unknown }>(res: T, ...ok: number[]) => {
    expect(ok.length ? ok : [200, 201], JSON.stringify(res.body)).toContain(res.status);
    return res.body as any;
  };
  const twoPaneerThreeCola = () => [line(s.menu.paneer.id, 2), line(s.menu.cola.id, 3)];
  const taxRows = (invoice: any) => invoice.taxes.map((t: any) => [t.type, t.rateBps, t.taxablePaise, t.amountPaise]);

  /**
   * Ledger rules that must hold for every bill in the database, whatever happened to it:
   * the total is taxable value plus tax plus round-off, the tax rows add up to the tax, the lines add up to the
   * taxable value, and paid and refunded match the payments and refunds recorded against it.
   */
  async function expectLedgerSound() {
    const broken = await h.prisma.$queryRaw<{ invoice_number: string; rule: string }[]>`
      SELECT i.invoice_number, 'total = taxable + tax + round off' AS rule FROM invoices i
        WHERE i.total_paise <> i.taxable_paise + i.cgst_paise + i.sgst_paise + i.igst_paise + i.cess_paise + i.round_off_paise
      UNION ALL
      SELECT i.invoice_number, 'tax rows = tax' FROM invoices i
        WHERE (SELECT COALESCE(SUM(amount_paise), 0) FROM invoice_taxes t WHERE t.invoice_id = i.id) <> i.cgst_paise + i.sgst_paise + i.igst_paise + i.cess_paise
      UNION ALL
      SELECT i.invoice_number, 'lines + service charge = taxable' FROM invoices i
        WHERE (SELECT COALESCE(SUM(taxable_paise), 0) FROM invoice_items x WHERE x.invoice_id = i.id) + i.service_charge_paise <> i.taxable_paise
      UNION ALL
      SELECT i.invoice_number, 'CGST = SGST' FROM invoices i WHERE i.cgst_paise <> i.sgst_paise
      UNION ALL
      SELECT i.invoice_number, 'paid = payments' FROM invoices i
        WHERE (SELECT COALESCE(SUM(amount_paise), 0) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'SUCCESS') <> i.paid_paise
      UNION ALL
      SELECT i.invoice_number, 'refunded = refunds' FROM invoices i
        WHERE (SELECT COALESCE(SUM(amount_paise), 0) FROM refunds r WHERE r.invoice_id = i.id AND r.status = 'SUCCESS') <> i.refunded_paise
      UNION ALL
      SELECT o.series || '-' || o.order_number, 'open order has no standing bill' FROM orders o
        WHERE o.status IN ('OPEN', 'HELD', 'MERGED', 'CANCELLED') AND EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = o.id AND i.status = 'ISSUED')
      UNION ALL
      SELECT o.series || '-' || o.order_number, 'billed order total = its standing bills' FROM orders o
        WHERE o.status IN ('BILLED', 'SETTLED') AND o.total_paise <> (SELECT COALESCE(SUM(total_paise), 0) FROM invoices i WHERE i.order_id = o.id AND i.status = 'ISSUED')`;
    expect(broken).toEqual([]);
    // Invoice numbers per series: unique and without gaps.
    const series = await h.prisma.$queryRaw<{ series_id: string; n: bigint; max: number; distinct: bigint }[]>`
      SELECT series_id, COUNT(*) AS n, MAX(number) AS max, COUNT(DISTINCT number) AS distinct FROM invoices GROUP BY series_id`;
    for (const row of series) expect([Number(row.n), Number(row.distinct)]).toEqual([row.max, row.max]);
  }

  // ── E. GST: expected values worked out by hand ──

  describe('E. GST calculation against hand-worked figures', () => {
    it('exclusive prices, two rates, within the state: CGST and SGST at half the rate each', async () => {
      const made = must(await saveOrder(s.cashier, { items: twoPaneerThreeCola() }));
      const [invoice] = must(await issue(s.cashier, made.id));
      // Paneer 2 × 260 = 520.00 at 5%: 13.00 + 13.00. Cola 3 × 50 = 150.00 at 18%: 13.50 + 13.50. 670 + 53 = 723.00.
      expect(invoice).toMatchObject({
        grossPaise: 67000, discountPaise: 0, taxablePaise: 67000, cgstPaise: 2650, sgstPaise: 2650, igstPaise: 0,
        roundOffPaise: 0, totalPaise: 72300, docType: 'TAX_INVOICE', isInterState: false,
      });
      expect(taxRows(invoice)).toEqual([['CGST', 250, 52000, 1300], ['CGST', 900, 15000, 1350], ['SGST', 250, 52000, 1300], ['SGST', 900, 15000, 1350]]);
      expect(invoice.amountInWords).toBe('Rupees Seven Hundred Twenty Three Only');
    });

    it('a bill discount is shared across lines before tax, and the total rounds to the rupee', async () => {
      const made = must(await saveOrder(s.owner, { items: twoPaneerThreeCola(), discount: { type: 'PERCENT', value: 1000, reason: 'Regular' } }));
      const [invoice] = must(await issue(s.owner, made.id));
      // 10% of 670 = 67: paneer 52, cola 15. Paneer 468 → 11.70 + 11.70. Cola 135 → 12.15 + 12.15. 603 + 47.70 = 650.70 → 651.
      expect(invoice).toMatchObject({ discountPaise: 6700, taxablePaise: 60300, cgstPaise: 2385, sgstPaise: 2385, roundOffPaise: 30, totalPaise: 65100 });
      expect(invoice.items.map((i: any) => [i.discountPaise, i.taxablePaise, i.cgstPaise])).toEqual([[5200, 46800, 1170], [1500, 13500, 1215]]);
    });

    it('a line discount and a bill discount together', async () => {
      const items = [line(s.menu.paneer.id, 2, { discount: { type: 'AMOUNT', value: 2000 } }), line(s.menu.cola.id, 3)];
      const made = must(await saveOrder(s.owner, { items, discount: { type: 'PERCENT', value: 500 } }));
      const [invoice] = must(await issue(s.owner, made.id));
      // Paneer 520 − 20 = 500; with cola 150 that is 650, 5% off = 32.50 shared 25.00 / 7.50.
      // Paneer 475 at 5%: 11.875 → 11.88 each half. Cola 142.50 at 18%: 12.825 → 12.83 each half.
      // 617.50 + 23.76 + 25.66 = 666.92 → 667.
      expect(invoice).toMatchObject({ discountPaise: 5250, taxablePaise: 61750, cgstPaise: 1188 + 1283, sgstPaise: 1188 + 1283, roundOffPaise: 8, totalPaise: 66700 });
    });

    it('prices that include tax: the guest pays the menu price and the tax is taken out of it', async () => {
      await settings({ pricesIncludeTax: true });
      const made = must(await saveOrder(s.cashier, { items: [line(s.menu.paneer.id, 1), line(s.menu.cola.id, 1)] }));
      const [invoice] = must(await issue(s.cashier, made.id));
      expect(invoice.totalPaise).toBe(31000);
      for (const [item, price, rate] of [[invoice.items[0], 26000, 0.05], [invoice.items[1], 5000, 0.18]] as const) {
        // Taxable value is price / (1 + rate), to the paisa; CGST = SGST = taxable × rate / 2, to the paisa.
        expect(Math.abs(item.taxablePaise - price / (1 + rate))).toBeLessThanOrEqual(1);
        expect(item.cgstPaise).toBe(item.sgstPaise);
        expect(Math.abs(item.cgstPaise - (item.taxablePaise * rate) / 2)).toBeLessThanOrEqual(1);
        expect(item.taxablePaise + item.cgstPaise + item.sgstPaise).toBe(price);
      }
    });

    it('IGST in place of CGST and SGST when the place of supply is another state', async () => {
      const made = must(await saveOrder(s.cashier, { items: twoPaneerThreeCola() }));
      const [invoice] = must(await issue(s.cashier, made.id, { placeOfSupply: '29' }));
      expect(invoice).toMatchObject({ isInterState: true, placeOfSupply: '29', cgstPaise: 0, sgstPaise: 0, igstPaise: 5300, totalPaise: 72300 });
      expect(taxRows(invoice)).toEqual([['IGST', 500, 52000, 2600], ['IGST', 1800, 15000, 2700]]);
    });

    it('service charge is taxed at the default rate; round-off can be switched off', async () => {
      await settings({ serviceChargeEnabled: true, serviceChargeBps: 1000 });
      const made = must(await saveOrder(s.cashier, { items: [line(s.menu.paneer.id, 2)] }));
      const [invoice] = must(await issue(s.cashier, made.id));
      // 520 + 10% = 52 service charge; 5% on 572 = 28.60; 600.60 → 601.
      expect(invoice).toMatchObject({ serviceChargePaise: 5200, taxablePaise: 57200, cgstPaise: 1430, sgstPaise: 1430, roundOffPaise: 40, totalPaise: 60100 });

      await settings({ serviceChargeEnabled: false, roundOffMode: 'NONE' });
      const biryani = line(s.menu.biryani.id, 1, { modifierIds: [s.menu.raita.id, s.menu.spicy.id] });
      const second = must(await saveOrder(s.cashier, { items: [biryani] }));
      const [plain] = must(await issue(s.cashier, second.id));
      // 250 + 40 raita = 290; 5% = 14.50; 304.50 left as it is.
      expect(plain).toMatchObject({ totalPaise: 30450, roundOffPaise: 0 });
      await expectLedgerSound();
    });
  });

  // ── A, B. Dine-in and takeaway end to end ──

  describe('A, B. billing a dine-in table and a takeaway', () => {
    it('dine-in: table, items, quantity change, discount, kitchen, bill, cash, receipt, and the records', async () => {
      const id = randomUUID();
      const paneer = line(s.menu.paneer.id, 1);
      const cola = line(s.menu.cola.id, 2);
      let saved = must(await saveOrder(s.owner, { type: 'DINE_IN', tableId: s.menu.t1.id, guests: 3, items: [paneer, cola] }, id));
      expect(saved).toMatchObject({ status: 'OPEN', tableName: 'T1', guests: 3 });
      expect((await h.prisma.diningTable.findUniqueOrThrow({ where: { id: s.menu.t1.id } })).status).toBe('OCCUPIED');

      // First round to the kitchen: one ticket per station.
      const first = must(await s.owner.post(`/orders/${id}/kots`));
      expect(first.map((k: any) => [k.stationName, k.items.map((i: any) => [i.name, i.quantity])])).toEqual([
        ['Main Kitchen', [['Paneer Tikka', 1]]], ['Bar', [['Cola', 2]]],
      ]);

      // Second paneer, and a 10% discount; only the extra paneer goes to the kitchen.
      saved = must(await saveOrder(s.owner, {
        type: 'DINE_IN', tableId: s.menu.t1.id, guests: 3, version: saved.version,
        items: [{ ...paneer, quantity: 2 }, cola], discount: { type: 'PERCENT', value: 1000 },
      }, id));
      const second = must(await s.owner.post(`/orders/${id}/kots`));
      expect(second.map((k: any) => [k.stationName, k.items.map((i: any) => [i.name, i.quantity])])).toEqual([['Main Kitchen', [['Paneer Tikka', 1]]]]);

      const [invoice] = must(await issue(s.owner, id));
      // 520 + 100 = 620, less 62 = 558; paneer 468 at 5% = 23.40, cola 90 at 18% = 16.20; 597.60 → 598.
      expect(invoice).toMatchObject({ orderType: 'DINE_IN', tableName: 'T1', discountPaise: 6200, taxablePaise: 55800, cgstPaise: 1980, totalPaise: 59800, paymentStatus: 'UNPAID' });
      expect(invoice.invoiceNumber).toBe(`A1/${FY}/000001`);
      expect((await h.prisma.diningTable.findUniqueOrThrow({ where: { id: s.menu.t1.id } })).status).toBe('BILL_PRINTED');
      expect((await s.owner.put(`/orders/${id}`, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [] })).body.code).toBe('ORDER_LOCKED');

      const paid = must(await pay(s.owner, invoice.id, [{ method: 'CASH', amountPaise: 59800, tenderedPaise: 60000 }]));
      expect(paid).toMatchObject({ paymentStatus: 'PAID', paidPaise: 59800 });
      expect(paid.payments[0]).toMatchObject({ method: 'CASH', amountPaise: 59800, tenderedPaise: 60000, changePaise: 200 });
      expect((await order(id)).status).toBe('SETTLED');
      expect((await h.prisma.diningTable.findUniqueOrThrow({ where: { id: s.menu.t1.id } })).status).toBe('FREE');

      const receipt: PrintDocument = must(await s.owner.get(`/invoices/${invoice.id}/print-document?width=MM80`));
      const text = receipt.lines.flatMap((l) => (l.kind === 'text' ? [l.text] : [])).join('\n');
      expect(text).toContain(invoice.invoiceNumber);
      expect(text).toMatch(/598\.00/);
      expect(text).toMatch(/CGST/);

      const db = await h.prisma.order.findUniqueOrThrow({ where: { id }, include: { items: true, kots: true, invoices: { include: { payments: true, items: true, taxes: true } } } });
      expect(db).toMatchObject({ status: 'SETTLED', totalPaise: 59800, discountPaise: 6200 });
      expect(db.kots).toHaveLength(3);
      expect(db.invoices[0]!.payments).toHaveLength(1);
      await expectLedgerSound();
    });

    it('takeaway: order, kitchen ticket, UPI payment, bill, and the day\'s reports agree', async () => {
      const made = must(await saveOrder(s.cashier, { type: 'TAKEAWAY', customer: { name: 'Asha', phone: '9800000001' }, items: twoPaneerThreeCola() }));
      expect(must(await s.cashier.post(`/orders/${made.id}/kots`))).toHaveLength(2);
      const [invoice] = must(await issue(s.cashier, made.id));
      expect(invoice.customer).toMatchObject({ name: 'Asha', phone: '9800000001' });
      must(await pay(s.cashier, invoice.id, [{ method: 'UPI', amountPaise: 72300, reference: 'UPI-REF-1' }]));
      const pdf = await s.cashier.get(`/invoices/${invoice.id}/pdf`);
      expect([pdf.status, pdf.headers['content-type']]).toEqual([200, 'application/pdf']);

      const daily = must(await s.owner.get(`/reports/sales-daily?from=${TODAY}&to=${TODAY}`));
      expect(daily.totals).toMatchObject({ bills: 1, total: 72300, cgst: 2650, sgst: 2650, upi: 72300, cash: 0, net: 72300 });
      const gst = must(await s.owner.get(`/reports/gst?from=${TODAY}&to=${TODAY}`));
      expect(gst.totals).toMatchObject({ taxable: 67000 });
      await expectLedgerSound();
    });

    it('delivery orders keep their address and bill like any other order', async () => {
      const made = must(await saveOrder(s.cashier, { type: 'DELIVERY', deliveryAddress: '12 MG Road', customer: { name: 'Ravi', phone: '9800000002' }, items: [line(s.menu.paneer.id)] }));
      expect(made).toMatchObject({ type: 'DELIVERY', deliveryAddress: '12 MG Road' });
      const [invoice] = must(await issue(s.cashier, made.id));
      expect(invoice).toMatchObject({ orderType: 'DELIVERY', totalPaise: 27300 });
    });
  });

  // ── C. Split bill ──

  describe('C. splitting a bill', () => {
    it('by item, including one item shared between bills: each bill numbered and taxed on its own', async () => {
      const paneer = line(s.menu.paneer.id, 2);
      const cola = line(s.menu.cola.id, 3);
      const made = must(await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t2.id, items: [paneer, cola] }));
      const parts = [
        [{ orderItemId: paneer.id, quantity: 1 }, { orderItemId: cola.id, quantity: 1 }],
        [{ orderItemId: paneer.id, quantity: 1 }, { orderItemId: cola.id, quantity: 2 }],
      ];
      const bills = must(await issue(s.cashier, made.id, { parts }));
      // 260 + 13.00 tax + 50 + 9.00 tax = 332; 260 + 13 + 100 + 18 = 391.
      expect(bills.map((b: any) => [b.invoiceNumber, b.totalPaise])).toEqual([[`A1/${FY}/000001`, 33200], [`A1/${FY}/000002`, 39100]]);
      must(await pay(s.cashier, bills[0].id, [{ method: 'CASH', amountPaise: 33200 }]));
      expect((await order(made.id)).status).toBe('BILLED');
      must(await pay(t2, bills[1].id, [{ method: 'CARD', amountPaise: 39100, reference: 'slip 77' }]));
      expect((await order(made.id)).status).toBe('SETTLED');
      expect((await h.prisma.diningTable.findUniqueOrThrow({ where: { id: s.menu.t2.id } })).status).toBe('FREE');
      await expectLedgerSound();
    });

    it('by amount: one bill paid in parts by different guests and methods', async () => {
      const made = must(await saveOrder(s.cashier, { items: twoPaneerThreeCola() }));
      const [invoice] = must(await issue(s.cashier, made.id));
      expect(must(await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 24100 }])).paymentStatus).toBe('PARTIALLY_PAID');
      expect(must(await pay(s.cashier, invoice.id, [{ method: 'UPI', amountPaise: 24100 }, { method: 'CARD', amountPaise: 24100 }])).paymentStatus).toBe('PAID');
      expect((await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 100 }])).body.code).toBe('OVERPAYMENT');
      expect((await order(made.id)).status).toBe('SETTLED');
    });
  });

  // ── D. Kitchen ──

  describe('D. kitchen stations and the kitchen display', () => {
    it('routes food and drink to their own stations and moves a ticket through its statuses', async () => {
      const made = must(await saveOrder(s.cashier, { items: twoPaneerThreeCola() }));
      const kots = must(await s.cashier.post(`/orders/${made.id}/kots`));
      const kitchen = kots.find((k: any) => k.stationName === 'Main Kitchen');
      const bar = kots.find((k: any) => k.stationName === 'Bar');
      expect([kitchen.items[0].name, bar.items[0].name]).toEqual(['Paneer Tikka', 'Cola']);
      expect(kitchen.kotNumber).not.toBe(bar.kotNumber);

      const barOnly = must(await s.owner.get(`/kots?stationId=${bar.stationId}`));
      expect(barOnly.map((k: any) => k.id)).toEqual([bar.id]);
      for (const status of ['PREPARING', 'READY', 'COMPLETED']) {
        expect(must(await s.owner.patch(`/kots/${kitchen.id}/status`, { status })).status).toBe(status);
      }
      expect(must(await s.owner.get('/kots')).map((k: any) => k.id)).toEqual([bar.id]);
      // The cashier role cannot change a ticket's status.
      expect((await s.cashier.patch(`/kots/${bar.id}/status`, { status: 'READY' })).status).toBe(403);
    });

    it('keeps the newest tickets on the board on a day with more than 500 of them', async () => {
      const made = must(await saveOrder(s.cashier, { items: [line(s.menu.paneer.id)] }));
      const start = Date.now() - 600 * 60_000;
      await h.prisma.kot.createMany({
        data: Array.from({ length: 520 }, (_, i) => ({
          restaurantId: s.fx.restaurant.id, orderId: made.id, stationId: s.fx.station.id, kotNumber: i + 1,
          businessDate: new Date(`${TODAY}T00:00:00.000Z`), type: 'NEW' as const, createdById: s.fx.cashier.id, createdAt: new Date(start + i * 60_000),
        })),
      });
      for (const scope of ['active', 'today']) {
        const board = must(await s.owner.get(`/kots?scope=${scope}`));
        expect(board, scope).toHaveLength(500);
        // Oldest first, ending with the ticket that came in last.
        expect([board[0].kotNumber, board.at(-1).kotNumber], scope).toEqual([21, 520]);
      }
    });
  });

  // ── F. Payments ──

  describe('F. payments and refunds', () => {
    it('refuses bad tenders, records nothing for them, and refunds against the right payment', async () => {
      const made = must(await saveOrder(s.cashier, { items: twoPaneerThreeCola() }));
      const [invoice] = must(await issue(s.cashier, made.id));
      for (const bad of [{ method: 'CASH', amountPaise: 0 }, { method: 'CASH', amountPaise: -100 }, { method: 'WALLET', amountPaise: 100 }, { method: 'CASH', amountPaise: 1.5 }]) {
        expect((await pay(s.cashier, invoice.id, [bad])).status).toBe(400);
      }
      expect((await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 72300, tenderedPaise: 70000 }])).body.code).toBe('TENDER_INVALID');
      expect(await h.prisma.payment.count()).toBe(0);

      const id = randomUUID();
      const body = { payments: [{ id, method: 'CARD', amountPaise: 72300, reference: '1234' }] };
      const [a, b] = await Promise.all([s.cashier.post(`/invoices/${invoice.id}/payments`, body), t2.post(`/invoices/${invoice.id}/payments`, body)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(await h.prisma.payment.count()).toBe(1);

      const paymentId = a.body.payments[0].id;
      const refunded = must(await s.owner.post(`/invoices/${invoice.id}/refunds`, { id: randomUUID(), paymentId, amountPaise: 10000, reason: 'Cold food' }));
      expect(refunded).toMatchObject({ paymentStatus: 'PARTIALLY_REFUNDED', refundedPaise: 10000 });
      expect(refunded.refunds[0].creditNoteNumber).toBe(`C-A1/${FY}/000001`);
      // The cashier needs a manager for a refund.
      expect((await s.cashier.post(`/invoices/${invoice.id}/refunds`, { id: randomUUID(), paymentId, amountPaise: 100, reason: 'x' })).status).toBe(403);
      await expectLedgerSound();
    });

    it('two refunds at once cannot together return more than was paid', async () => {
      const made = must(await saveOrder(s.cashier, { items: twoPaneerThreeCola() }));
      const [invoice] = must(await issue(s.cashier, made.id));
      const paid = must(await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 72300 }]));
      const refund = () => s.owner.post(`/invoices/${invoice.id}/refunds`, { id: randomUUID(), paymentId: paid.payments[0].id, amountPaise: 50000, reason: 'Twice' });
      const results = await Promise.all([refund(), refund(), refund()]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 422, 422]);
      expect((await h.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).refundedPaise).toBe(50000);
      await expectLedgerSound();
    });
  });

  // ── G. Several terminals ──

  describe('G. two terminals on one restaurant', () => {
    it('sees the other terminal\'s orders, refuses a stale save, and bills an order once', async () => {
      const made = must(await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.paneer.id)] }));
      expect(must(await t2.get('/orders/running')).map((o: any) => o.id)).toContain(made.id);

      must(await t2.put(`/orders/${made.id}`, { type: 'DINE_IN', tableId: s.menu.t1.id, version: made.version, items: [...made.items.map((i: any) => ({ id: i.id, productId: i.productId, quantity: 2 }))] }));
      const stale = await s.cashier.put(`/orders/${made.id}`, { type: 'DINE_IN', tableId: s.menu.t1.id, version: made.version, items: [] });
      expect([stale.status, stale.body.code]).toEqual([409, 'ORDER_CHANGED']);

      const results = await Promise.all([issue(s.cashier, made.id), issue(t2, made.id)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await h.prisma.invoice.count()).toBe(1);
    });

    it('lets only one of two terminals open a new order on the same free table, without a server error', async () => {
      for (let round = 0; round < 6; round += 1) {
        await h.prisma.order.updateMany({ data: { status: 'CANCELLED' } });
        await h.prisma.diningTable.updateMany({ data: { status: 'FREE' } });
        const results = await Promise.all([s.cashier, t2].map((client) => saveOrder(client, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.cola.id)] })));
        expect(results.map((r) => r.status).sort(), JSON.stringify(results.map((r) => r.body.code))).toEqual([200, 409]);
        expect(await h.prisma.order.count({ where: { tableId: s.menu.t1.id, status: 'OPEN' } })).toBe(1);
      }
    });

    it('sends each item to the kitchen once when two terminals press send together', async () => {
      for (let round = 0; round < 6; round += 1) {
        const made = must(await saveOrder(s.cashier, { items: twoPaneerThreeCola() }));
        const results = await Promise.all([s.cashier.post(`/orders/${made.id}/kots`), t2.post(`/orders/${made.id}/kots`)]);
        expect(results.map((r) => r.status).filter((status) => status >= 500)).toEqual([]);
        const sent = await h.prisma.kotItem.groupBy({ by: ['name'], where: { kot: { orderId: made.id, type: 'NEW' } }, _sum: { quantity: true } });
        expect(Object.fromEntries(sent.map((row) => [row.name, row._sum.quantity])), `round ${round}`).toEqual({ 'Paneer Tikka': 2, Cola: 3 });
      }
    });

    it('sends each item to the kitchen at most once when one terminal presses KOT while the other bills', async () => {
      for (let round = 0; round < 6; round += 1) {
        const made = must(await saveOrder(s.cashier, { items: twoPaneerThreeCola() }));
        const results = await Promise.all([new Promise((r) => setTimeout(r, round * 3)).then(() => t2.post(`/orders/${made.id}/kots`)), issue(s.cashier, made.id)]);
        expect(results.map((r) => r.status).filter((status) => status >= 500)).toEqual([]);
        const sent = await h.prisma.kotItem.groupBy({ by: ['name'], where: { kot: { orderId: made.id, type: 'NEW' } }, _sum: { quantity: true } });
        // Billing sends nothing itself: KOT went first and sent everything once, or came after the bill and was refused.
        const kot = results[0]!;
        expect(Object.fromEntries(sent.map((row) => [row.name, row._sum.quantity])), `round ${round}`).toEqual(kot.status === 200 ? { 'Paneer Tikka': 2, Cola: 3 } : {});
        if (kot.status !== 200) expect(kot.body.code).toBe('ORDER_LOCKED');
      }
    });
  });

  // ── Races between a bill and other changes to the same order ──

  describe('changes racing a bill on another terminal', () => {
    const rounds = 12;
    /** Starts the change a little later each round, so it lands at a different point of the bill's transaction. */
    const later = <T>(round: number, send: () => PromiseLike<T>) => new Promise((resolve) => setTimeout(resolve, round * 3)).then(send);

    it('hold and bill at once never leave a held order with a standing bill', async () => {
      for (let round = 0; round < rounds; round += 1) {
        const made = must(await saveOrder(s.cashier, { items: [line(s.menu.paneer.id)] }));
        const results = await Promise.all([later(round, () => s.cashier.post(`/orders/${made.id}/hold`)), issue(t2, made.id)]);
        expect(results.map((r) => r.status).filter((status) => status >= 500)).toEqual([]);
        await expectLedgerSound();
      }
    });

    it('resume and bill at once never leave an open order with a standing bill', async () => {
      for (let round = 0; round < rounds; round += 1) {
        const made = must(await saveOrder(s.cashier, { items: [line(s.menu.paneer.id)] }));
        must(await s.cashier.post(`/orders/${made.id}/hold`));
        const results = await Promise.all([later(round, () => s.cashier.post(`/orders/${made.id}/resume`)), issue(t2, made.id)]);
        expect(results.map((r) => r.status).filter((status) => status >= 500)).toEqual([]);
        await expectLedgerSound();
      }
    });

    it('cancel and bill at once never leave a cancelled order with a standing bill', async () => {
      for (let round = 0; round < rounds; round += 1) {
        const made = must(await saveOrder(s.cashier, { items: [line(s.menu.paneer.id)] }));
        const results = await Promise.all([later(round, () => s.owner.post(`/orders/${made.id}/cancel`, { reason: 'Guest left' })), issue(t2, made.id)]);
        expect(results.map((r) => r.status).filter((status) => status >= 500)).toEqual([]);
        await expectLedgerSound();
      }
    });

    it('merging an order that is being billed never bills its items twice', async () => {
      for (let round = 0; round < rounds; round += 1) {
        const target = must(await saveOrder(s.cashier, { items: [line(s.menu.cola.id)] }));
        const source = must(await saveOrder(s.cashier, { items: [line(s.menu.paneer.id)] }));
        const results = await Promise.all([later(round, () => s.owner.post(`/orders/${target.id}/merge`, { sourceOrderId: source.id })), issue(t2, source.id)]);
        expect(results.map((r) => r.status).filter((status) => status >= 500)).toEqual([]);
        await expectLedgerSound();
        // The paneer is on exactly one running or billed order.
        const holders = await h.prisma.orderItem.count({ where: { productId: s.menu.paneer.id, order: { id: { in: [target.id, source.id] }, status: { in: ['OPEN', 'HELD', 'BILLED', 'SETTLED'] } } } });
        expect(holders).toBe(1);
      }
    });

    it('two opposite merges at once lose no items', async () => {
      for (let round = 0; round < rounds; round += 1) {
        const a = must(await saveOrder(s.cashier, { items: [line(s.menu.cola.id)] }));
        const b = must(await saveOrder(s.cashier, { items: [line(s.menu.paneer.id)] }));
        const results = await Promise.all([
          s.owner.post(`/orders/${a.id}/merge`, { sourceOrderId: b.id }),
          later(round % 4, () => s.owner.post(`/orders/${b.id}/merge`, { sourceOrderId: a.id })),
        ]);
        expect(results.map((r) => r.status).filter((status) => status >= 500), JSON.stringify(results.map((r) => r.body))).toEqual([]);
        const running = await h.prisma.order.findMany({ where: { id: { in: [a.id, b.id] }, status: 'OPEN' }, include: { items: true } });
        expect(running, `round ${round}`).toHaveLength(1);
        expect(running[0]!.items).toHaveLength(2);
      }
    });

    it('two terminals moving different parties to the same free table: one wins, no server error', async () => {
      for (let round = 0; round < 4; round += 1) {
        await h.prisma.order.updateMany({ data: { status: 'CANCELLED' } });
        await h.prisma.diningTable.updateMany({ data: { status: 'FREE' } });
        const t3 = await h.prisma.diningTable.create({ data: { restaurantId: s.fx.restaurant.id, areaId: s.menu.t1.areaId, name: `X${round}` } });
        const a = must(await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t1.id, items: [line(s.menu.cola.id)] }));
        const b = must(await saveOrder(s.cashier, { type: 'DINE_IN', tableId: s.menu.t2.id, items: [line(s.menu.cola.id)] }));
        const results = await Promise.all([s.owner.post(`/orders/${a.id}/transfer`, { tableId: t3.id }), s.owner.post(`/orders/${b.id}/transfer`, { tableId: t3.id })]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(await h.prisma.order.count({ where: { tableId: t3.id, status: 'OPEN' } })).toBe(1);
      }
    });
  });

  // ── I. Cash register ──

  describe('I. cash register shift', () => {
    it('opens, takes cash and other methods, pays out, and closes against the count', async () => {
      const opened = must(await s.cashier.post('/registers/open', { openingCashPaise: 100_000 }));
      const made = must(await saveOrder(s.cashier, { items: twoPaneerThreeCola() }));
      const [first] = must(await issue(s.cashier, made.id));
      must(await pay(s.cashier, first.id, [{ method: 'CASH', amountPaise: 72300, tenderedPaise: 80000 }]));
      const other = must(await saveOrder(s.cashier, { items: [line(s.menu.paneer.id)] }));
      const [second] = must(await issue(s.cashier, other.id));
      must(await pay(s.cashier, second.id, [{ method: 'UPI', amountPaise: 27300 }]));
      must(await s.cashier.post('/registers/current/movements', { type: 'CASH_OUT', amountPaise: 20_000, reason: 'Milk', approval: s.ownerApproval }));

      // 1,000 float + 723 cash sale − 200 paid out = 1,523. The change handed back and the UPI sale are not in the drawer.
      const now = must(await s.cashier.get('/registers/current')).register;
      expect(now).toMatchObject({ openingCashPaise: 100_000, cashSalesPaise: 72300, cashOutPaise: 20_000, expectedCashPaise: 152_300 });
      const closed = must(await s.cashier.post(`/registers/${opened.id}/close`, { countedCashPaise: 152_000 }));
      expect(closed).toMatchObject({ status: 'CLOSED', expectedCashPaise: 152_300, countedCashPaise: 152_000, variancePaise: -300 });
      expect((await s.cashier.post(`/registers/${opened.id}/close`, { countedCashPaise: 152_000 })).status).toBeGreaterThanOrEqual(400);
    });
  });

  // ── J. Printing ──

  describe('J. printouts for 58 mm and 80 mm paper', () => {
    it('lays out bills and kitchen tickets within the width of the paper', async () => {
      const long = await h.prisma.product.create({ data: { restaurantId: s.fx.restaurant.id, categoryId: s.fx.category.id, name: 'Paneer Butter Masala With Extra Cheese And Garlic Naan Combo', basePricePaise: 123456, stationId: s.fx.station.id } });
      const made = must(await saveOrder(s.cashier, { customer: { name: 'A Very Long Customer Name For Testing', phone: '9800000003' }, items: [line(long.id, 12), ...twoPaneerThreeCola()] }));
      const [kot] = must(await s.cashier.post(`/orders/${made.id}/kots`));
      const [invoice] = must(await issue(s.cashier, made.id));
      for (const width of ['MM58', 'MM80'] as const) {
        const columns = PAPER_COLUMNS[width];
        for (const path of [`/invoices/${invoice.id}/print-document?width=${width}`, `/kots/${kot.id}/print-document?width=${width}`]) {
          const doc: PrintDocument = must(await s.owner.get(path));
          expect(doc.columns).toBe(columns);
          for (const printed of doc.lines) {
            if (printed.kind !== 'text') continue;
            const room = printed.size === 'wide' || printed.size === 'large' ? Math.floor(columns / 2) : columns;
            expect(printed.text.length, `${width} ${path.split('/')[1]}: "${printed.text}"`).toBeLessThanOrEqual(room);
          }
        }
      }
    });

    it('says plainly when there is no print bridge, so the screen can print through the browser', async () => {
      const made = must(await saveOrder(s.cashier, { items: [line(s.menu.paneer.id)] }));
      const [invoice] = must(await issue(s.cashier, made.id));
      const response = await s.cashier.post(`/invoices/${invoice.id}/print`, {});
      expect(response.status).toBeLessThan(500);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(['PRINT_BRIDGE_OFFLINE', 'NO_PRINTER']).toContain(response.body.code);
    });
  });

  // ── Security spot checks ──

  describe('access control spot checks', () => {
    it('refuses unauthenticated calls, forged tokens, and another restaurant\'s ids', async () => {
      const made = must(await saveOrder(s.cashier, { items: [line(s.menu.paneer.id)] }));
      const [invoice] = must(await issue(s.cashier, made.id));
      const anonymous = h.client();
      expect((await anonymous.get(`/invoices/${invoice.id}`)).status).toBe(401);
      anonymous.token = s.cashier.token!.slice(0, -4) + 'AAAA';
      expect((await anonymous.get(`/invoices/${invoice.id}`)).status).toBe(401);

      const other = await scene(h, 'b');
      for (const path of [`/invoices/${invoice.id}`, `/orders/${made.id}`, `/invoices/${invoice.id}/pdf`, `/invoices/${invoice.id}/print-document`]) {
        expect((await other.owner.get(path)).status, path).toBe(404);
      }
      expect((await pay(other.owner, invoice.id, [{ method: 'CASH', amountPaise: 27300 }])).status).toBe(404);
      expect((await other.owner.put(`/orders/${made.id}`, { type: 'TAKEAWAY', items: [] })).status).toBe(404);
      // A cashier cannot change prices, settings or users.
      expect((await s.cashier.patch(`/products/${s.menu.paneer.id}`, { basePricePaise: 1 })).status).toBe(403);
      expect((await s.cashier.patch('/settings', { discountCapBps: 10000 })).status).toBe(403);
      expect((await s.cashier.get('/users')).status).toBe(403);
    });

    it('gives each signed-in session its own request budget, so the tills of one outlet do not use up each other\'s', async () => {
      await h.redis.flushdb();
      // Same address for every client here, as for every device behind an outlet's router.
      for (let i = 0; i < 600; i += 1) expect((await s.cashier.get('/orders/running')).status).toBe(200);
      expect((await s.cashier.get('/orders/running')).status).toBe(429);
      expect((await t2.get('/orders/running')).status).toBe(200);
      // Without a valid token the budget is the address's, which has barely been touched.
      const forged = h.client();
      forged.token = 'not-a-token';
      expect((await forged.get('/orders/running')).status).toBe(401);
      await h.redis.flushdb();
    });

    it('takes prices from the menu, never from the request', async () => {
      const made = must(await saveOrder(s.cashier, { items: [{ ...line(s.menu.paneer.id), unitPricePaise: 1, totalPaise: 1 }] }));
      expect(made.totals.totalPaise).toBe(27300);
    });
  });
});
