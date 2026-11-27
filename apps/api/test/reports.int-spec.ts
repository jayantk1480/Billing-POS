import { randomUUID } from 'node:crypto';
import { businessDateOf } from '@pos/billing-core';
import ExcelJS from 'exceljs';
import { billed, line, pay, saveOrder, type Scene, scene } from './support/billing.js';
import { createHarness, type Harness, type TestClient } from './support/harness.js';

const TODAY = businessDateOf(new Date());
const range = 'from=' + TODAY + '&to=' + TODAY;

type Report = { summary: { label: string; value: number; type: string }[]; columns: { key: string; label: string }[]; rows: Record<string, string | number | null>[]; totals: Record<string, number> | null; note: string | null };

/** Fetches a binary response body as a Buffer. */
function download(client: TestClient, path: string) {
  return client.get(path).buffer(true).parse((res, callback) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
  });
}

describe('reports and dashboard', () => {
  let h: Harness;
  let s: Scene;
  const report = async (type: string, query = range): Promise<Report> => (await s.owner.get('/reports/' + type + '?' + query).expect(200)).body;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  /**
   * One day's trading, used by every test below:
   *   Bill 1 (cashier): 2 paneer + 1 cola = ₹605, paid ₹400 cash + ₹205 UPI, then ₹100 cash refunded by the owner.
   *   Bill 2 (owner):   1 paneer with a 10% bill discount = ₹245.70 → ₹246, paid by card.
   *   Bill 3 (cashier): 1 cola = ₹59, issued then cancelled by the owner.
   *   One order left open, never billed.
   */
  beforeEach(async () => {
    await h.reset();
    s = await scene(h);
    const first = await billed(s.cashier, [line(s.menu.paneer.id, 2), line(s.menu.cola.id, 1)]);
    const paid = (await pay(s.cashier, first.invoice.id, [{ method: 'CASH', amountPaise: 40000 }, { method: 'UPI', amountPaise: 20500 }]).expect(200)).body;
    await s.owner.post('/invoices/' + first.invoice.id + '/refunds', { id: randomUUID(), paymentId: paid.payments[0].id, amountPaise: 10000, reason: 'Cold food' }).expect(200);

    const second = await billed(s.owner, [line(s.menu.paneer.id, 1)], { discount: { type: 'PERCENT', value: 1000, reason: 'Regular guest' } });
    await pay(s.owner, second.invoice.id, [{ method: 'CARD', amountPaise: 24600 }]).expect(200);

    const third = await billed(s.cashier, [line(s.menu.cola.id, 1)]);
    await s.owner.post('/invoices/' + third.invoice.id + '/cancel', { reason: 'Billed twice' }).expect(200);

    await saveOrder(s.cashier, { items: [line(s.menu.cola.id, 4)] }).expect(200);
  });

  it('daily sales: counts standing bills only, and subtracts refunds for net sales', async () => {
    const daily = await report('sales-daily');
    expect(daily.rows).toEqual([{
      sr: 1, period: TODAY, bills: 2, unit: 4, gross: 57000 + 26000, discount: 2600, taxable: 57000 + 23400, cgst: 1750 + 585, sgst: 1750 + 585, igst: 0,
      roundOff: 30, total: 60500 + 24600, cash: 40000, upi: 20500, card: 24600, other: 0, refunds: 10000, net: 75100,
    }]);
    expect(daily.columns.map((column) => column.label)).toEqual([
      'Sr. no.', 'Date', 'Receipts', 'Unit', 'Amount', 'Discount', 'Taxable value', 'CGST', 'SGST', 'IGST + Cess', 'Round off', 'Total amount',
      'Cash', 'UPI', 'Card', 'Other', 'Refunds', 'Net sales',
    ]);
    expect(daily.totals).toMatchObject({ bills: 2, total: 85100, refunds: 10000, net: 75100 });
    expect(daily.summary.map((figure) => [figure.label, figure.value])).toEqual([
      ['Total sales (receipts)', 2], ['Total sales quantity', 4], ['Total sales amount', 85100],
      ['Cash', 40000], ['UPI', 20500], ['Card', 24600], ['Net sales after refunds', 75100],
    ]);

    const monthly = await report('sales-monthly');
    expect(monthly.rows).toMatchObject([{ period: TODAY.slice(0, 7), bills: 2, net: 75100 }]);
  });

  it('agrees with itself: every report adds up to the same sales', async () => {
    const [daily, items, categories, gst, hsn, payments, cashiers] = (await Promise.all(
      ['sales-daily', 'item-summary', 'categories', 'gst', 'hsn', 'payment-summary', 'cashiers'].map((type) => report(type)),
    )) as [Report, Report, Report, Report, Report, Report, Report];
    const taxable = daily.totals!.taxable;
    const tax = daily.totals!.cgst! + daily.totals!.sgst! + daily.totals!.igst!;
    expect(items.totals).toMatchObject({ taxable, tax });
    expect(categories.totals).toMatchObject({ taxable, tax });
    expect(hsn.totals!.taxable).toBe(taxable);
    // Item totals carry no round-off; the bills do.
    expect(items.totals!.total! + daily.totals!.roundOff!).toBe(daily.totals!.total);
    // GST summary is net of the credit note.
    const creditNote = gst.rows.find((row) => String(row.description).startsWith('Less: credit notes'))!;
    expect(gst.totals!.tax! - Number(creditNote.tax)).toBe(tax);
    // Everything billed was collected, and the cashier report matches both.
    expect(payments.totals).toMatchObject({ amount: 85100, refunded: 10000, net: 75100 });
    expect(cashiers.totals).toMatchObject({ billed: 85100, collected: 85100, refunds: 10000, unit: 4 });
    // Every report numbers its rows from 1.
    for (const one of [daily, items, categories, gst, hsn, payments, cashiers]) {
      expect(one.columns[0]).toMatchObject({ key: 'sr', label: 'Sr. no.' });
      expect(one.rows.map((row) => row.sr)).toEqual(one.rows.map((_, index) => index + 1));
    }
  });

  it('item-wise sales: one row per item on each receipt, with payment method and who billed it', async () => {
    const lines = await report('items');
    expect(lines.columns.map((column) => column.label)).toEqual([
      'Sr. no.', 'Date', 'Receipt no.', 'Item', 'Category', 'Payment method', 'Unit', 'Rate', 'Amount', 'Discount', 'Tax', 'Total amount', 'Created by',
    ]);
    expect(lines.rows.map((row) => [row.sr, String(row.receipt).slice(-6), row.item, row.method, row.unit, row.rate, row.amount, row.discount, row.tax, row.total, row.createdBy])).toEqual([
      [1, '000001', 'Paneer Tikka', 'Cash + UPI', 2, 26000, 52000, 0, 2600, 54600, 'Cashier'],
      [2, '000001', 'Cola', 'Cash + UPI', 1, 5000, 5000, 0, 900, 5900, 'Cashier'],
      [3, '000002', 'Paneer Tikka', 'Card', 1, 26000, 26000, 2600, 1170, 24570, 'Owner'],
    ]);
    expect(lines.rows.every((row) => row.category === 'Starters' && !Number.isNaN(Date.parse(String(row.date))))).toBe(true);
    expect(lines.totals).toEqual({ unit: 4, amount: 83000, discount: 2600, tax: 4670, total: 85070 });
    // The headline figures above the table.
    expect(lines.summary).toEqual([
      { label: 'Total sales (receipts)', value: 2, type: 'number' },
      { label: 'Total sales quantity', value: 4, type: 'number' },
      { label: 'Total sales amount', value: 85070, type: 'money' },
    ]);

    // A bill that has not been paid yet is not a sale yet: it joins the report once it is paid.
    const waiting = await billed(s.cashier, [line(s.menu.cola.id, 2)]);
    expect((await report('items')).rows).toHaveLength(3);
    await pay(s.cashier, waiting.invoice.id, [{ method: 'UPI', amountPaise: 11800 }]).expect(200);
    expect((await report('items')).rows.at(-1)).toMatchObject({ sr: 4, method: 'UPI', unit: 2, total: 11800 });
  });

  it('item summary and category-wise sales', async () => {
    const items = await report('item-summary');
    expect(items.rows.map((row) => [row.name, row.category, row.quantity, row.gross, row.discount, row.total])).toEqual([
      ['Paneer Tikka', 'Starters', 3, 78000, 2600, 54600 + 24570],
      ['Cola', 'Starters', 1, 5000, 0, 5900],
    ]);
    const categories = await report('categories');
    expect(categories.rows).toMatchObject([{ name: 'Starters', quantity: 4, total: 85070 }]);
    expect(categories.columns.map((column) => column.key)).not.toContain('category');
  });

  it('GST summary by rate, with credit notes deducted and cancelled bills left out', async () => {
    const gst = await report('gst');
    expect(gst.rows.map((row) => [row.description, row.taxable, row.cgst, row.sgst, row.tax])).toEqual([
      ['GST 5%', 52000 + 23400, 1300 + 585, 1300 + 585, 3770],
      ['GST 18%', 5000, 450, 450, 900],
      ['Less: credit notes (1)', -9421, -289, -289, -578],
    ]);
    expect(gst.note).toBe('2 bill(s) issued and 1 cancelled in this period. Cancelled bills are not included in the figures.');

    const hsn = await report('hsn');
    expect(hsn.rows.map((row) => [row.hsn, row.rate, row.quantity, row.taxable])).toEqual([['Not set', 18, 1, 5000], ['996331', 5, 3, 75400]]);
  });

  it('payments: every payment line by line, and added up by day and method', async () => {
    const lines = await report('payments');
    expect(lines.columns.map((column) => column.label)).toEqual([
      'Sr. no.', 'Date', 'Receipt no.', 'Payment method', 'Amount', 'Refunded since', 'Total amount', 'Reference', 'Created by',
    ]);
    expect(lines.rows.map((row) => [row.sr, String(row.receipt).slice(-6), row.method, row.amount, row.refunded, row.net, row.createdBy])).toEqual([
      [1, '000001', 'Cash', 40000, 10000, 30000, 'Cashier'],
      [2, '000001', 'UPI', 20500, 0, 20500, 'Cashier'],
      [3, '000002', 'Card', 24600, 0, 24600, 'Owner'],
    ]);
    expect(lines.summary.map((figure) => [figure.label, figure.value])).toEqual([['Payments', 3], ['Total received', 85100], ['Net after refunds', 75100]]);

    const summary = await report('payment-summary');
    expect(summary.rows.map((row) => [row.date, row.method, row.count, row.amount, row.refunded, row.net])).toEqual([
      [TODAY, 'Card', 1, 24600, 0, 24600],
      [TODAY, 'Cash', 1, 40000, 10000, 30000],
      [TODAY, 'UPI', 1, 20500, 0, 20500],
    ]);
  });

  it('discounts, refunds and cancelled bills name who did it and why', async () => {
    const discounts = await report('discounts');
    expect(discounts.rows).toMatchObject([{
      sr: 1, order: 'A1-2', method: 'Card', on: 'Whole bill', unit: null, given: '10%', gross: 26000, amount: 2600, total: 24600,
      reason: 'Regular guest', by: 'Owner', approvedBy: '',
    }]);
    expect(discounts.summary.map((figure) => [figure.label, figure.value])).toEqual([['Discounts given', 1], ['Total discount', 2600]]);
    expect(String(discounts.rows[0]!.bill)).toMatch(/^A1\/\d{4}\/000002$/);

    const refunds = await report('refunds');
    expect(refunds.rows).toMatchObject([{ sr: 1, method: 'Cash', unit: null, billTotal: 60500, amount: 10000, reason: 'Cold food', by: 'Owner' }]);
    expect(String(refunds.rows[0]!.bill)).toMatch(/000001$/);
    expect(String(refunds.rows[0]!.creditNote)).toMatch(/^C-A1\//);

    const cancelled = await report('cancellations');
    expect(cancelled.rows).toMatchObject([{ sr: 1, unit: 1, gross: 5000, discount: 0, total: 5900, reason: 'Billed twice', issuedBy: 'Cashier', cancelledBy: 'Owner' }]);
    expect(cancelled.summary.map((figure) => [figure.label, figure.value])).toEqual([['Cancelled receipts', 1], ['Total amount cancelled', 5900]]);
    expect(String(cancelled.rows[0]!.bill)).toMatch(/000003$/);
  });

  it('cashier-wise: who billed, collected, discounted, refunded and cancelled', async () => {
    const cashiers = await report('cashiers');
    expect(cashiers.rows).toEqual([
      { sr: 1, name: 'Cashier', bills: 1, unit: 3, gross: 57000, discount: 0, billed: 60500, cash: 40000, upi: 20500, card: 0, other: 0, collected: 60500, discounts: 0, refunds: 0, cancelled: 0 },
      { sr: 2, name: 'Owner', bills: 1, unit: 1, gross: 26000, discount: 2600, billed: 24600, cash: 0, upi: 0, card: 24600, other: 0, collected: 24600, discounts: 2600, refunds: 10000, cancelled: 1 },
    ]);
    expect(cashiers.summary.map((figure) => [figure.label, figure.value])).toEqual([
      ['Total sales (receipts)', 2], ['Total sales quantity', 4], ['Total sales amount', 85100],
    ]);
  });

  it('orders report lists completed orders with their bills, leaving out open and cancelled ones', async () => {
    const orders = await report('orders');
    // A1-3 was cancelled and A1-4 is still open: neither is a completed order.
    expect(orders.rows.map((row) => [row.number, row.status, row.total])).toEqual([
      ['A1-1', 'Settled', 60500], ['A1-2', 'Settled', 24600],
    ]);
    expect(orders.columns.map((column) => column.label)).toEqual([
      'Sr. no.', 'Date', 'Order', 'Receipt no.', 'Type', 'Table', 'Status', 'Payment method', 'Unit', 'Amount', 'Discount', 'Tax', 'Total amount', 'Created by',
    ]);
    expect(orders.rows[0]).toMatchObject({ sr: 1, method: 'Cash + UPI', unit: 3, gross: 57000, tax: 3500, createdBy: 'Cashier' });
    expect(orders.rows[1]).toMatchObject({ method: 'Card', unit: 1, discount: 2600, createdBy: 'Owner' });
    expect(orders.summary.map((figure) => [figure.label, figure.value])).toEqual([['Total orders', 2], ['Total quantity', 4], ['Total amount', 85100]]);
    expect(orders.note).toContain('Completed orders only');
  });

  it('returns nothing, without error, for a period with no sales', async () => {
    for (const type of ['sales-daily', 'items', 'item-summary', 'gst', 'payments', 'payment-summary', 'discounts', 'refunds', 'cancellations', 'cashiers', 'orders']) {
      const empty = await report(type, 'from=2001-01-01&to=2001-01-31');
      expect(empty.rows).toEqual([]);
    }
  });

  it('validates the report name and the period', async () => {
    expect((await s.owner.get('/reports/nonsense?' + range)).status).toBe(400);
    expect((await s.owner.get('/reports/items')).status).toBe(400);
    expect((await s.owner.get('/reports/items?from=2026-02-01&to=2026-01-01')).status).toBe(400);
    expect((await s.owner.get('/reports/items?from=2020-01-01&to=2026-01-01')).status).toBe(400);
    expect((await s.owner.get('/reports/items?from=01-01-2026&to=2026-01-01')).status).toBe(400);
  });

  it('is open only to roles with the report permission, and never shows another restaurant', async () => {
    expect((await s.cashier.get('/reports/sales-daily?' + range)).status).toBe(403);
    expect((await s.cashier.get('/reports/sales-daily/export?format=csv&' + range)).status).toBe(403);
    expect((await s.cashier.get('/dashboard')).status).toBe(403);

    const other = await scene(h, 'b');
    const theirs = (await other.owner.get('/reports/sales-daily?' + range).expect(200)).body as Report;
    expect(theirs.rows).toEqual([]);
    expect((await other.owner.get('/dashboard').expect(200)).body.sales.totalPaise).toBe(0);
  });

  describe('exports', () => {
    it('CSV: rupees with two decimals, a totals line, and a file name with the period', async () => {
      const response = await s.owner.get('/reports/payment-summary/export?format=csv&' + range).expect(200);
      expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(response.headers['content-disposition']).toBe('attachment; filename="payment-summary_' + TODAY + '_to_' + TODAY + '.csv"');
      expect(response.text.replace(/^\uFEFF/, '').trim().split('\r\n')).toEqual([
        'Sr. no.,Date,Payment method,Payments,Amount,Refunded since,Total amount',
        '1,' + TODAY + ',Card,1,246.00,0.00,246.00',
        '2,' + TODAY + ',Cash,1,400.00,100.00,300.00',
        '3,' + TODAY + ',UPI,1,205.00,0.00,205.00',
        'Total,,,3,851.00,100.00,751.00',
      ]);
    });

    it('CSV: quotes text containing commas and defuses spreadsheet formulas', async () => {
      const risky = await billed(s.owner, [line(s.menu.cola.id, 1)], { discount: { type: 'AMOUNT', value: 100, reason: '=HYPERLINK("http://evil"), "quoted"' } });
      expect(risky.invoice.totalPaise).toBeGreaterThan(0);
      await pay(s.owner, risky.invoice.id, [{ method: 'CASH', amountPaise: risky.invoice.totalPaise }]).expect(200);
      const csv = (await s.owner.get('/reports/discounts/export?format=csv&' + range).expect(200)).text;
      expect(csv).toContain('"\'=HYPERLINK(""http://evil""), ""quoted"""');
    });

    it('Excel: real numbers that add up, with a totals row', async () => {
      const response = await download(s.owner, '/reports/sales-daily/export?format=xlsx&' + range).expect(200);
      expect(response.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(response.body as unknown as ArrayBuffer);
      const sheet = workbook.worksheets[0]!;
      const rows = sheet.getSheetValues().filter(Boolean).map((row) => (row as unknown[]).slice(1));
      const header = rows.findIndex((row) => row[0] === 'Sr. no.');
      expect(rows[0]![0]).toBe('Test Restaurant A');
      // The headline figures sit above the table.
      expect(rows.slice(0, header).map((row) => [row[0], row[1]])).toEqual(expect.arrayContaining([['Total sales quantity', 4], ['Total sales amount', 851]]));
      expect(rows[header]!.slice(0, 5)).toEqual(['Sr. no.', 'Date', 'Receipts', 'Unit', 'Amount']);
      expect(rows[header + 1]!.slice(0, 5)).toEqual([1, TODAY, 2, 4, 830]);
      expect(rows[header + 2]![0]).toBe('Total');
      expect(rows[header + 2]!.at(-1)).toBe(751);
      expect(typeof rows[header + 1]![4]).toBe('number');
    });

    it('PDF: a real PDF, and the export is written to the audit log', async () => {
      const response = await download(s.owner, '/reports/items/export?format=pdf&' + range).expect(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect((response.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'report.exported' } });
      expect(audit).toMatchObject({ userId: s.fx.owner.id, entityId: 'items', after: { format: 'pdf', rows: 3 } });
      expect((await s.owner.get('/reports/items/export?format=docx&' + range)).status).toBe(400);
    });
  });

  describe('sharing a report with a biller', () => {
    it('lets a cashier open only the report shared with them, until it is unshared', async () => {
      expect((await s.cashier.get('/reports/available').expect(200)).body).toEqual({ all: false, types: [] });
      expect((await s.cashier.get('/reports/items?' + range)).status).toBe(403);
      expect((await s.owner.get('/reports/sharing').expect(200)).body).toEqual({
        shares: {}, candidates: [{ id: s.fx.cashier.id, name: 'Cashier', roleName: 'Cashier' }],
      });

      const shared = await s.owner.put('/reports/items/sharing', { userIds: [s.fx.cashier.id] });
      expect(shared.status).toBe(200);
      expect(shared.body.shares).toEqual({ items: [s.fx.cashier.id] });

      expect((await s.cashier.get('/reports/available')).body).toEqual({ all: false, types: ['items'] });
      const items = (await s.cashier.get('/reports/items?' + range).expect(200)).body as Report;
      expect(items.rows).toHaveLength(3);
      await s.cashier.get('/reports/items/export?format=csv&' + range).expect(200);
      // Nothing else opens: not another report, not the dashboard, not the sharing settings.
      expect((await s.cashier.get('/reports/sales-daily?' + range)).status).toBe(403);
      expect((await s.cashier.get('/reports/item-summary/export?format=pdf&' + range)).status).toBe(403);
      expect((await s.cashier.get('/dashboard')).status).toBe(403);
      // Their sign-in now carries the shared report, which is what puts Reports in their sidebar.
      expect((await s.cashier.get('/auth/me')).body.sharedReports).toEqual(['items']);
      const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'report.shared' } });
      expect(audit).toMatchObject({ userId: s.fx.owner.id, entityId: 'items', after: { userIds: [s.fx.cashier.id], names: ['Cashier'] } });

      // A second report can be added, and the first taken away, independently.
      await s.owner.put('/reports/payments/sharing', { userIds: [s.fx.cashier.id] }).expect(200);
      await s.owner.put('/reports/items/sharing', { userIds: [] }).expect(200);
      expect((await s.cashier.get('/reports/available')).body.types).toEqual(['payments']);
      expect((await s.cashier.get('/reports/items?' + range)).status).toBe(403);
      await s.cashier.get('/reports/payments?' + range).expect(200);
    });

    it('can only be done by someone allowed to share, and only within the restaurant', async () => {
      expect((await s.cashier.put('/reports/items/sharing', { userIds: [s.fx.cashier.id] })).status).toBe(403);
      expect((await s.cashier.get('/reports/sharing')).status).toBe(403);
      expect((await s.owner.put('/reports/nonsense/sharing', { userIds: [] })).status).toBe(400);

      const other = await scene(h, 'b');
      const outsider = await s.owner.put('/reports/items/sharing', { userIds: [other.fx.cashier.id] });
      expect(outsider.status).toBe(422);
      expect(outsider.body.code).toBe('USER_NOT_FOUND');
      expect(await h.prisma.reportShare.count()).toBe(0);
      // A share in one restaurant gives nothing in another.
      await other.owner.put('/reports/items/sharing', { userIds: [other.fx.cashier.id] }).expect(200);
      expect((await s.cashier.get('/reports/available')).body.types).toEqual([]);
    });

    it('is not needed by roles that already see every report', async () => {
      const mine = (await s.owner.get('/reports/available').expect(200)).body;
      expect(mine.all).toBe(true);
      expect(mine.types).toHaveLength(14);
      // The owner is not offered as someone to share with.
      expect((await s.owner.get('/reports/sharing')).body.candidates.map((person: { name: string }) => person.name)).toEqual(['Cashier']);
    });
  });

  it('dashboard: today at a glance', async () => {
    const dashboard = (await s.owner.get('/dashboard').expect(200)).body;
    expect(dashboard.businessDate).toBe(TODAY);
    expect(dashboard.sales).toEqual({ totalPaise: 85100, bills: 2, averagePaise: 42550, discountPaise: 2600, refundsPaise: 10000, netPaise: 75100 });
    expect(dashboard.orders).toEqual({ taken: 4, running: 1, cancelled: 1 });
    expect(dashboard.unpaid).toEqual({ bills: 0, amountPaise: 0 });
    expect(dashboard.payments).toEqual([
      { method: 'CASH', amountPaise: 40000, count: 1 }, { method: 'CARD', amountPaise: 24600, count: 1 }, { method: 'UPI', amountPaise: 20500, count: 1 },
    ]);
    expect(dashboard.trend).toHaveLength(7);
    expect(dashboard.trend.at(-1)).toEqual({ date: TODAY, totalPaise: 85100, bills: 2 });
    expect(dashboard.trend.slice(0, 6).every((day: { totalPaise: number }) => day.totalPaise === 0)).toBe(true);
    expect(dashboard.topItems).toEqual([{ name: 'Paneer Tikka', quantity: 3, totalPaise: 79170 }, { name: 'Cola', quantity: 1, totalPaise: 5900 }]);
    expect(dashboard.recentBills).toHaveLength(3);
    expect(dashboard.recentBills[0]).toMatchObject({ status: 'CANCELLED', totalPaise: 5900 });
  });

  it('dashboard: shows money still owed on unpaid bills, apart from the day\'s sales', async () => {
    await billed(s.cashier, [line(s.menu.paneer.id, 1)]);
    const dashboard = (await s.owner.get('/dashboard').expect(200)).body;
    expect(dashboard.unpaid).toEqual({ bills: 1, amountPaise: 27300 });
    // Not a sale until it is paid.
    expect(dashboard.sales).toMatchObject({ bills: 2, totalPaise: 85100 });
    expect(dashboard.orders.running).toBe(2);
  });

  describe('an order that is still running', () => {
    const figure = (data: Report, label: string) => data.summary.find((entry) => entry.label === label)?.value;
    const salesNow = async () => {
      const daily = await report('sales-daily');
      return [figure(daily, 'Total sales (receipts)'), figure(daily, 'Total sales amount')];
    };

    it('is in no sales report until it is paid in full, and then counts on the day it was billed', async () => {
      const before = await salesNow();
      expect(before).toEqual([2, 85100]);
      const items = (await report('item-summary')).rows.length;
      const categories = figure(await report('categories'), 'Total sales amount');
      const cashiers = figure(await report('cashiers'), 'Total sales amount');

      // Billed with a discount, waiting for payment: ₹273 less 10% is ₹245.70, rounded to ₹246.
      const { order, invoice } = await billed(s.cashier, [line(s.menu.paneer.id, 1)], { discount: { type: 'PERCENT', value: 1000, reason: 'Regular guest' } });
      expect(invoice.totalPaise).toBe(24600);
      const discounts = (await report('discounts')).rows.length;
      expect(await salesNow()).toEqual(before);
      expect((await report('orders')).rows.map((row) => row.number)).not.toContain(order.displayNumber);
      expect((await report('items')).rows.map((row) => row.receipt)).not.toContain(invoice.invoiceNumber);
      expect((await report('item-summary')).rows).toHaveLength(items);
      expect(figure(await report('categories'), 'Total sales amount')).toBe(categories);
      expect(figure(await report('cashiers'), 'Total sales amount')).toBe(cashiers);

      // Half paid is still running.
      await pay(s.cashier, invoice.id, [{ method: 'CASH', amountPaise: 10000 }]).expect(200);
      expect(await salesNow()).toEqual(before);
      // The money itself is real and is in the payment reports straight away.
      expect(figure(await report('sales-daily'), 'Cash')).toBe(40000 + 10000);

      await pay(s.cashier, invoice.id, [{ method: 'UPI', amountPaise: 14600 }]).expect(200);
      expect(await salesNow()).toEqual([3, 85100 + 24600]);
      expect((await report('orders')).rows.map((row) => row.number)).toContain(order.displayNumber);
      expect((await report('items')).rows.map((row) => row.receipt)).toContain(invoice.invoiceNumber);
      expect((await report('discounts')).rows).toHaveLength(discounts + 1);
      expect(figure(await report('cashiers'), 'Total sales amount')).toBe(Number(cashiers) + 24600);
      expect((await s.owner.get('/dashboard').expect(200)).body.sales).toMatchObject({ bills: 3, totalPaise: 85100 + 24600 });
    });

    it('still counts in the GST and HSN summaries, which say so, because tax is due once a bill is issued', async () => {
      const gstBefore = figure(await report('gst'), 'Net tax');
      expect((await report('gst')).note).not.toContain('still waiting for payment');
      await billed(s.cashier, [line(s.menu.paneer.id, 1)]);

      const gst = await report('gst');
      expect(figure(gst, 'Net tax')).toBe(Number(gstBefore) + 1300);
      expect(gst.note).toContain('Includes 1 bill(s) worth ₹273.00 still waiting for payment');
      const hsn = await report('hsn');
      expect(hsn.note).toContain('Includes 1 bill(s) worth ₹273.00 still waiting for payment');
      // (Item lines carry no round-off, so the day's ₹851.00 of bills is ₹850.70 of items.)
      expect(figure(hsn, 'Total sales amount')).toBe(85070 + 27300);
      // The sales report and the tax report differ by exactly that bill until it is paid.
      expect(figure(await report('sales-daily'), 'Total sales amount')).toBe(85100);
    });
  });
});
