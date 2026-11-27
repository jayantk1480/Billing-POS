import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@pos/database';
import {
  type AvailableReports, type DashboardDto, type PaymentMethod, type ReportCell, type ReportColumn, type ReportData, type ReportQuery, REPORTS, type ReportSharing,
  type ReportType,
} from '@pos/validation';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { PermissionCacheService } from '../../common/auth/permission-cache.service.js';
import { forbidden, invalid } from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { asDate, BillingContextService, fromDate } from '../billing/billing-context.js';
import { displayNumber, invoiceListInclude, toInvoiceListItem } from '../billing/mappers.js';

type Row = Record<string, ReportCell>;
type Raw = Record<string, unknown>;
type Summary = ReportData['summary'];
type Built = { columns: ReportColumn[]; rows: Row[]; totals?: string[]; summary?: Summary; note?: string; truncated?: boolean };
const ROW_LIMIT = 5000;

const col = (key: string, label: string, type: ReportColumn['type'] = 'text'): ReportColumn => ({ key, label, type });
const money = (key: string, label: string) => col(key, label, 'money');
/** PostgreSQL sums come back as bigint; rupee totals fit comfortably in a number. */
const n = (value: unknown): number => Number(value ?? 0);
const count = (label: string, value: number): Summary[number] => ({ label, value, type: 'number' });
const amount = (label: string, value: number): Summary[number] => ({ label, value, type: 'money' });
const TYPES = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' };
const METHODS: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', OTHER: 'Other' };
/** "Cash + UPI" for a bill paid two ways; "Unpaid" when nothing has been received. */
const methodsOf = (payments: { method: string }[]) => {
  // Always in the same order, however the tenders happened to be recorded.
  const names = Object.keys(METHODS).filter((method) => payments.some((payment) => payment.method === method)).map((method) => METHODS[method]!);
  return names.length > 0 ? names.join(' + ') : 'Unpaid';
};
const paidWith = { where: { status: 'SUCCESS' as const }, select: { method: true } };
/** Money on a cancelled bill is not takings: the bill left sales, so its payments and their refunds leave the totals with it. */
const standingBill = (table: string) => Prisma.sql`EXISTS (SELECT 1 FROM invoices sb WHERE sb.id = ${Prisma.raw(table)}.invoice_id AND sb.status = 'ISSUED')`;
const STATUSES = { OPEN: 'Open', HELD: 'On hold', BILLED: 'Awaiting payment', SETTLED: 'Settled', CANCELLED: 'Cancelled', MERGED: 'Merged' };

/**
 * Reports are read straight from invoices, payments and refunds, the same immutable records the
 * bills were printed from, so a report always agrees with the paper. Cancelled bills are excluded
 * from sales; refunds are shown separately and subtracted to give net figures.
 *
 * A sale counts once its order is complete, meaning every bill of the order is paid in full. An order
 * that is still running (open, on hold, or billed and waiting for payment) is in no sales report, and
 * joins the day it was billed on once it is settled. The two reports made for the GST return are the
 * exception: tax is due on a bill from the day it is issued, paid or not, so they follow issued bills.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly context: BillingContextService,
    private readonly permissionCache: PermissionCacheService,
    private readonly audit: AuditService,
  ) {}

  // ── Who may see what ──

  /** A role with report.view sees every report; anyone else sees only the reports shared with them by name. */
  async available(auth: AuthContext): Promise<AvailableReports> {
    if (auth.permissions.has('report.view')) return { all: true, types: REPORTS.map((report) => report.type) };
    const shares = await this.prisma.reportShare.findMany({ where: { restaurantId: auth.restaurantId, userId: auth.userId }, select: { reportType: true } });
    const shared = new Set(shares.map((share) => share.reportType));
    return { all: false, types: REPORTS.map((report) => report.type).filter((type) => shared.has(type)) };
  }

  private async assertCanView(auth: AuthContext, type: ReportType): Promise<void> {
    if (!(await this.available(auth)).types.includes(type)) throw forbidden('This report has not been shared with you.');
  }

  /** For the share dialog: who each report is shared with, and who could be given one. */
  async sharing(auth: AuthContext): Promise<ReportSharing> {
    const [shares, users] = await Promise.all([
      this.prisma.reportShare.findMany({ where: { restaurantId: auth.restaurantId, user: { isActive: true } }, select: { reportType: true, userId: true } }),
      this.prisma.user.findMany({ where: { restaurantId: auth.restaurantId, isActive: true }, include: { role: true }, orderBy: { name: 'asc' } }),
    ]);
    // People whose role already shows every report need nothing shared with them.
    const candidates = [];
    for (const user of users) {
      if (!(await this.permissionCache.rolePermissions(user.roleId)).includes('report.view')) candidates.push({ id: user.id, name: user.name, roleName: user.role.name });
    }
    const byType: Record<string, string[]> = {};
    for (const share of shares) (byType[share.reportType] ??= []).push(share.userId);
    return { shares: byType, candidates };
  }

  /** Sets exactly who one report is shared with. */
  async share(auth: AuthContext, type: ReportType, userIds: string[]): Promise<ReportSharing> {
    const wanted = [...new Set(userIds)];
    const users = await this.prisma.user.findMany({ where: { id: { in: wanted }, restaurantId: auth.restaurantId, isActive: true }, select: { id: true, name: true } });
    if (users.length !== wanted.length) throw invalid('USER_NOT_FOUND', 'One of the chosen people is no longer an active user.');
    const before = await this.prisma.reportShare.findMany({ where: { restaurantId: auth.restaurantId, reportType: type }, select: { userId: true } });
    await this.prisma.$transaction([
      this.prisma.reportShare.deleteMany({ where: { restaurantId: auth.restaurantId, reportType: type, userId: { notIn: wanted } } }),
      this.prisma.reportShare.createMany({
        data: wanted.map((userId) => ({ restaurantId: auth.restaurantId, reportType: type, userId, createdById: auth.userId })),
        skipDuplicates: true,
      }),
    ]);
    await this.audit.record(auth, {
      action: 'report.shared', entityType: 'report', entityId: type,
      before: { userIds: before.map((share) => share.userId) }, after: { userIds: wanted, names: users.map((user) => user.name) },
    });
    return this.sharing(auth);
  }

  // ── Running ──

  async run(auth: AuthContext, type: ReportType, query: ReportQuery): Promise<ReportData> {
    await this.assertCanView(auth, type);
    const builders: Record<ReportType, () => Promise<Built>> = {
      'sales-daily': () => this.sales(auth, query, 'YYYY-MM-DD', 'Date', 'date'),
      'sales-monthly': () => this.sales(auth, query, 'YYYY-MM', 'Month', 'text'),
      orders: () => this.orders(auth, query),
      items: () => this.itemLines(auth, query),
      'item-summary': () => this.items(auth, query, false),
      'payment-summary': () => this.paymentSummary(auth, query),
      categories: () => this.items(auth, query, true),
      gst: () => this.gst(auth, query),
      hsn: () => this.hsn(auth, query),
      payments: () => this.payments(auth, query),
      discounts: () => this.discounts(auth, query),
      refunds: () => this.refunds(auth, query),
      cancellations: () => this.cancellations(auth, query),
      cashiers: () => this.cashiers(auth, query),
    };
    const built = await builders[type]();
    if (built.columns[0]?.key !== 'sr') {
      built.columns.unshift(col('sr', 'Sr. no.', 'number'));
      built.rows = built.rows.map((row, index) => ({ sr: index + 1, ...row }));
    }
    const totals = built.totals
      ? Object.fromEntries(built.totals.map((key) => [key, built.rows.reduce((sum, row) => sum + n(row[key]), 0)]))
      : null;
    return {
      type, title: REPORTS.find((report) => report.type === type)!.title, from: query.from, to: query.to,
      generatedAt: new Date().toISOString(), columns: built.columns, rows: built.rows, summary: built.summary ?? [], totals,
      note: built.note ?? null, truncated: built.truncated ?? false,
    };
  }

  /** Bills that stand (not cancelled) in this restaurant and period, paid or not. For the GST reports only. */
  private issued(auth: AuthContext, query: ReportQuery) {
    return Prisma.sql`i.restaurant_id = ${auth.restaurantId}::uuid AND i.status = 'ISSUED' AND i.business_date BETWEEN ${query.from}::date AND ${query.to}::date`;
  }

  /** The WHERE fragment every sales query shares: standing bills of completed orders, in this restaurant and period. */
  private completed(auth: AuthContext, query: ReportQuery) {
    return Prisma.sql`${this.issued(auth, query)} AND EXISTS (SELECT 1 FROM orders done WHERE done.id = i.order_id AND done.status = 'SETTLED')`;
  }

  /** What the GST reports say about bills they include that nobody has paid yet. Empty when there are none. */
  private async unpaidNote(auth: AuthContext, query: ReportQuery): Promise<string> {
    const [waiting] = await this.prisma.$queryRaw<Raw[]>`
      SELECT count(*)::int AS bills, sum(i.total_paise) AS total FROM invoices i
      WHERE ${this.issued(auth, query)} AND NOT EXISTS (SELECT 1 FROM orders done WHERE done.id = i.order_id AND done.status = 'SETTLED')`;
    if (n(waiting?.bills) === 0) return '';
    return ' Includes ' + n(waiting?.bills) + ' bill(s) worth ₹' + (n(waiting?.total) / 100).toFixed(2) + ' still waiting for payment: GST is due on a bill from the day it is issued, so these count here although they are not yet in the sales reports.';
  }

  private async names(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(users.map((user) => [user.id, user.name]));
  }

  private async sales(auth: AuthContext, query: ReportQuery, format: string, label: string, type: ReportColumn['type']): Promise<Built> {
    const range = Prisma.sql`BETWEEN ${query.from}::date AND ${query.to}::date`;
    const rid = Prisma.sql`${auth.restaurantId}::uuid`;
    const [bills, units, received, refunds] = await Promise.all([
      this.prisma.$queryRaw<Raw[]>`
        SELECT to_char(i.business_date, ${format}) AS period, count(*)::int AS bills, sum(i.gross_paise) AS gross, sum(i.discount_paise) AS discount,
               sum(i.taxable_paise) AS taxable, sum(i.cgst_paise) AS cgst, sum(i.sgst_paise) AS sgst, sum(i.igst_paise + i.cess_paise) AS igst,
               sum(i.round_off_paise) AS round_off, sum(i.total_paise) AS total
        FROM invoices i WHERE ${this.completed(auth, query)} GROUP BY 1`,
      this.prisma.$queryRaw<Raw[]>`
        SELECT to_char(i.business_date, ${format}) AS period, sum(ii.quantity)::int AS units
        FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE ${this.completed(auth, query)} GROUP BY 1`,
      this.prisma.$queryRaw<Raw[]>`
        SELECT to_char(p.business_date, ${format}) AS period, p.method::text AS method, sum(p.amount_paise) AS amount
        FROM payments p WHERE p.restaurant_id = ${rid} AND p.status = 'SUCCESS' AND ${standingBill('p')} AND p.business_date ${range} GROUP BY 1, 2`,
      this.prisma.$queryRaw<Raw[]>`
        SELECT to_char(r.business_date, ${format}) AS period, sum(r.amount_paise) AS amount FROM refunds r
        WHERE r.restaurant_id = ${rid} AND r.status = 'SUCCESS' AND ${standingBill('r')} AND r.business_date ${range} GROUP BY 1`,
    ]);
    const refunded = new Map(refunds.map((row) => [row.period as string, n(row.amount)]));
    const sold = new Map(units.map((row) => [row.period as string, n(row.units)]));
    const byPeriod = new Map(bills.map((row) => [row.period as string, row]));
    const collected = (period: string, method: string) => n(received.find((row) => row.period === period && row.method === method)?.amount);
    const periods = [...new Set([...byPeriod.keys(), ...refunded.keys(), ...received.map((row) => row.period as string)])].sort();
    const billedTotal = bills.reduce((total, row) => total + n(row.total), 0);
    const refundTotal = refunds.reduce((total, row) => total + n(row.amount), 0);
    return {
      summary: [
        count('Total sales (receipts)', bills.reduce((total, row) => total + n(row.bills), 0)),
        count('Total sales quantity', units.reduce((total, row) => total + n(row.units), 0)),
        amount('Total sales amount', billedTotal),
        // Payment-type split of the money received. "Other" is listed only when it was used.
        ...(['CASH', 'UPI', 'CARD', 'OTHER'] as const)
          .map((method) => ({ method, total: received.filter((row) => row.method === method).reduce((total, row) => total + n(row.amount), 0) }))
          .filter((entry) => entry.method !== 'OTHER' || entry.total > 0)
          .map((entry) => amount(METHODS[entry.method]!, entry.total)),
        amount('Net sales after refunds', billedTotal - refundTotal),
      ],
      columns: [col('period', label, type), col('bills', 'Receipts', 'number'), col('unit', 'Unit', 'number'), money('gross', 'Amount'), money('discount', 'Discount'),
        money('taxable', 'Taxable value'), money('cgst', 'CGST'), money('sgst', 'SGST'), money('igst', 'IGST + Cess'), money('roundOff', 'Round off'), money('total', 'Total amount'),
        money('cash', 'Cash'), money('upi', 'UPI'), money('card', 'Card'), money('other', 'Other'), money('refunds', 'Refunds'), money('net', 'Net sales')],
      rows: periods.map((period) => {
        const row = byPeriod.get(period) ?? {};
        const total = n(row.total);
        const refund = refunded.get(period) ?? 0;
        return {
          period, bills: n(row.bills), unit: sold.get(period) ?? 0, gross: n(row.gross), discount: n(row.discount), taxable: n(row.taxable), cgst: n(row.cgst),
          sgst: n(row.sgst), igst: n(row.igst), roundOff: n(row.round_off), total, cash: collected(period, 'CASH'), upi: collected(period, 'UPI'),
          card: collected(period, 'CARD'), other: collected(period, 'OTHER'), refunds: refund, net: total - refund,
        };
      }),
      totals: ['bills', 'unit', 'gross', 'discount', 'taxable', 'cgst', 'sgst', 'igst', 'roundOff', 'total', 'cash', 'upi', 'card', 'other', 'refunds', 'net'],
      note: 'Only completed orders are counted: an order still waiting for payment joins the day it was billed once it is paid in full. Cash, UPI, Card and Other are payments received in the period, which can include payment for a receipt issued earlier.',
    };
  }

  private async orders(auth: AuthContext, query: ReportQuery): Promise<Built> {
    const orders = await this.prisma.order.findMany({
      where: { restaurantId: auth.restaurantId, status: 'SETTLED', businessDate: { gte: asDate(query.from), lte: asDate(query.to) } },
      include: {
        table: { select: { name: true } }, createdBy: { select: { name: true } }, items: { select: { quantity: true } },
        invoices: { select: { invoiceNumber: true, status: true, payments: paidWith } },
      },
      orderBy: [{ businessDate: 'asc' }, { createdAt: 'asc' }],
      take: ROW_LIMIT + 1,
    });
    const shown = orders.slice(0, ROW_LIMIT);
    const rows = shown.map((order) => {
      const standing = order.invoices.filter((invoice) => invoice.status === 'ISSUED');
      return {
        date: order.createdAt.toISOString(), number: displayNumber(order),
        bills: order.invoices.map((i) => i.invoiceNumber + (i.status === 'CANCELLED' ? ' (cancelled)' : '')).join(', '),
        type: TYPES[order.type], table: order.table?.name ?? '', status: STATUSES[order.status],
        method: standing.length > 0 ? methodsOf(standing.flatMap((invoice) => invoice.payments)) : '',
        unit: order.items.reduce((total, item) => total + item.quantity, 0), gross: order.subtotalPaise, discount: order.discountPaise,
        tax: order.taxPaise, total: order.totalPaise, createdBy: order.createdBy.name,
      };
    });
    return {
      summary: [count('Total orders', rows.length), count('Total quantity', rows.reduce((total, row) => total + row.unit, 0)), amount('Total amount', rows.reduce((total, row) => total + row.total, 0))],
      columns: [col('date', 'Date', 'datetime'), col('number', 'Order'), col('bills', 'Receipt no.'), col('type', 'Type'), col('table', 'Table'), col('status', 'Status'),
        col('method', 'Payment method'), col('unit', 'Unit', 'number'), money('gross', 'Amount'), money('discount', 'Discount'), money('tax', 'Tax'),
        money('total', 'Total amount'), col('createdBy', 'Created by')],
      rows,
      totals: ['unit', 'gross', 'discount', 'tax', 'total'],
      truncated: orders.length > ROW_LIMIT,
      note: 'Completed orders only. Orders still running are under Sales, Orders; cancelled bills have their own report.',
    };
  }

  /** One row for every item line on every standing bill, in the order the bills were issued. */
  private async itemLines(auth: AuthContext, query: ReportQuery): Promise<Built> {
    const lines = await this.prisma.invoiceItem.findMany({
      where: { invoice: { restaurantId: auth.restaurantId, status: 'ISSUED', order: { status: 'SETTLED' }, businessDate: { gte: asDate(query.from), lte: asDate(query.to) } } },
      include: {
        invoice: { select: { invoiceNumber: true, issuedAt: true, createdById: true, payments: { where: { status: 'SUCCESS' }, select: { method: true }, orderBy: { createdAt: 'asc' } } } },
        orderItem: { select: { product: { select: { category: { select: { name: true } } } } } },
      },
      orderBy: [{ invoice: { issuedAt: 'asc' } }, { invoice: { invoiceNumber: 'asc' } }, { sortOrder: 'asc' }],
      take: ROW_LIMIT + 1,
    });
    const names = await this.names(lines.map((line) => line.invoice.createdById));
    const shown = lines.slice(0, ROW_LIMIT);
    return {
      summary: [
        count('Total sales (receipts)', new Set(shown.map((line) => line.invoiceId)).size),
        count('Total sales quantity', shown.reduce((total, line) => total + line.quantity, 0)),
        amount('Total sales amount', shown.reduce((total, line) => total + line.totalPaise, 0)),
      ],
      columns: [col('sr', 'Sr. no.', 'number'), col('date', 'Date', 'datetime'), col('receipt', 'Receipt no.'), col('item', 'Item'), col('category', 'Category'),
        col('method', 'Payment method'), col('unit', 'Unit', 'number'), money('rate', 'Rate'), money('amount', 'Amount'), money('discount', 'Discount'),
        money('tax', 'Tax'), money('total', 'Total amount'), col('createdBy', 'Created by')],
      rows: lines.slice(0, ROW_LIMIT).map((line, index) => {
        return {
          sr: index + 1, date: line.invoice.issuedAt.toISOString(), receipt: line.invoice.invoiceNumber, item: line.name,
          category: line.orderItem?.product.category.name ?? '', method: methodsOf(line.invoice.payments), unit: line.quantity,
          rate: line.unitPricePaise, amount: line.grossPaise, discount: line.discountPaise,
          tax: line.cgstPaise + line.sgstPaise + line.igstPaise + line.cessPaise, total: line.totalPaise, createdBy: names.get(line.invoice.createdById) ?? '',
        };
      }),
      totals: ['unit', 'amount', 'discount', 'tax', 'total'],
      truncated: lines.length > ROW_LIMIT,
      note: 'One row per item on each receipt of a completed order. Amount is units × rate; total amount is after discount and tax. Cancelled receipts and orders still waiting for payment are left out.',
    };
  }

  private async items(auth: AuthContext, query: ReportQuery, byCategory: boolean): Promise<Built> {
    const item = Prisma.sql`coalesce(oi.name || coalesce(' (' || oi.variant_name || ')', ''), ii.name)`;
    const category = Prisma.sql`coalesce(c.name, 'Removed from menu')`;
    const rows = await this.prisma.$queryRaw<Raw[]>`
      SELECT ${byCategory ? category : item} AS name, ${byCategory ? Prisma.sql`''` : category} AS category, sum(ii.quantity)::int AS quantity,
             sum(ii.gross_paise) AS gross, sum(ii.discount_paise) AS discount, sum(ii.taxable_paise) AS taxable,
             sum(ii.cgst_paise + ii.sgst_paise + ii.igst_paise + ii.cess_paise) AS tax, sum(ii.total_paise) AS total
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      LEFT JOIN order_items oi ON oi.id = ii.order_item_id LEFT JOIN products p ON p.id = oi.product_id LEFT JOIN categories c ON c.id = p.category_id
      WHERE ${this.completed(auth, query)} GROUP BY 1, 2 ORDER BY sum(ii.total_paise) DESC, 1`;
    return {
      columns: [col('name', byCategory ? 'Category' : 'Item'), ...(byCategory ? [] : [col('category', 'Category')]), col('quantity', 'Unit', 'number'),
        money('gross', 'Amount'), money('discount', 'Discount'), money('taxable', 'Taxable value'), money('tax', 'Tax'), money('total', 'Total amount')],
      rows: rows.map((row) => ({
        name: row.name as string, category: row.category as string, quantity: n(row.quantity), gross: n(row.gross), discount: n(row.discount),
        taxable: n(row.taxable), tax: n(row.tax), total: n(row.total),
      })),
      totals: ['quantity', 'gross', 'discount', 'taxable', 'tax', 'total'],
      summary: [
        count(byCategory ? 'Categories sold' : 'Items sold', rows.length),
        count('Total sales quantity', rows.reduce((total, row) => total + n(row.quantity), 0)),
        amount('Total sales amount', rows.reduce((total, row) => total + n(row.total), 0)),
      ],
      note: 'Sold quantities and values from completed orders. Refunds are not deducted here; see the Refunds report.',
    };
  }

  private async gst(auth: AuthContext, query: ReportQuery): Promise<Built> {
    const byRate = await this.prisma.$queryRaw<Raw[]>`
      SELECT ii.tax_rate_bps AS rate, sum(ii.taxable_paise) AS taxable, sum(ii.cgst_paise) AS cgst, sum(ii.sgst_paise) AS sgst, sum(ii.igst_paise) AS igst, sum(ii.cess_paise) AS cess
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE ${this.issued(auth, query)} GROUP BY 1 ORDER BY 1`;
    const [all] = await this.prisma.$queryRaw<Raw[]>`
      SELECT count(*)::int AS bills, sum(i.taxable_paise) AS taxable, sum(i.cgst_paise) AS cgst, sum(i.sgst_paise) AS sgst, sum(i.igst_paise) AS igst, sum(i.cess_paise) AS cess
      FROM invoices i WHERE ${this.issued(auth, query)}`;
    const [credit] = await this.prisma.$queryRaw<Raw[]>`
      SELECT count(*)::int AS notes, sum(r.taxable_paise) AS taxable, sum(r.cgst_paise) AS cgst, sum(r.sgst_paise) AS sgst, sum(r.igst_paise) AS igst, sum(r.cess_paise) AS cess
      FROM refunds r WHERE r.restaurant_id = ${auth.restaurantId}::uuid AND r.status = 'SUCCESS' AND ${standingBill('r')} AND r.business_date BETWEEN ${query.from}::date AND ${query.to}::date`;
    const cancelled = await this.prisma.invoice.count({
      where: { restaurantId: auth.restaurantId, status: 'CANCELLED', businessDate: { gte: asDate(query.from), lte: asDate(query.to) } },
    });

    const line = (description: string, source: Raw, sign = 1): Row => {
      const cgst = sign * n(source.cgst);
      const sgst = sign * n(source.sgst);
      const igst = sign * n(source.igst);
      const cess = sign * n(source.cess);
      return { description, taxable: sign * n(source.taxable), cgst, sgst, igst, cess, tax: cgst + sgst + igst + cess };
    };
    const rows = byRate.map((row) => line(n(row.rate) === 0 ? 'Nil rated or exempt (0%)' : 'GST ' + n(row.rate) / 100 + '%', row));
    // Tax on the service charge sits on the invoice, not on any item line.
    const keys = ['taxable', 'cgst', 'sgst', 'igst', 'cess'] as const;
    const service: Raw = Object.fromEntries(keys.map((key) => [key, n(all?.[key]) - byRate.reduce((sum, row) => sum + n(row[key]), 0)]));
    if (keys.some((key) => service[key] !== 0)) rows.push(line('Service charge', service));
    if (credit && n(credit.notes) > 0) rows.push(line('Less: credit notes (' + n(credit.notes) + ')', credit, -1));
    return {
      columns: [col('description', 'Rate'), money('taxable', 'Taxable value'), money('cgst', 'CGST'), money('sgst', 'SGST'), money('igst', 'IGST'), money('cess', 'Cess'), money('tax', 'Total tax')],
      rows,
      summary: [
        count('Receipts issued', n(all?.bills)),
        amount('Net taxable value', rows.reduce((total, row) => total + n(row.taxable), 0)),
        amount('Net tax', rows.reduce((total, row) => total + n(row.tax), 0)),
      ],
      totals: ['taxable', 'cgst', 'sgst', 'igst', 'cess', 'tax'],
      note: n(all?.bills) + ' bill(s) issued and ' + cancelled + ' cancelled in this period. Cancelled bills are not included in the figures.' + (await this.unpaidNote(auth, query)),
    };
  }

  private async hsn(auth: AuthContext, query: ReportQuery): Promise<Built> {
    const rows = await this.prisma.$queryRaw<Raw[]>`
      SELECT coalesce(ii.hsn_sac, '') AS hsn, ii.tax_rate_bps AS rate, sum(ii.quantity)::int AS quantity, sum(ii.taxable_paise) AS taxable,
             sum(ii.cgst_paise) AS cgst, sum(ii.sgst_paise) AS sgst, sum(ii.igst_paise) AS igst, sum(ii.cess_paise) AS cess, sum(ii.total_paise) AS total
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE ${this.issued(auth, query)} GROUP BY 1, 2 ORDER BY 1, 2`;
    return {
      columns: [col('hsn', 'HSN / SAC'), col('rate', 'GST rate', 'percent'), col('quantity', 'Unit', 'number'), money('taxable', 'Taxable value'),
        money('cgst', 'CGST'), money('sgst', 'SGST'), money('igst', 'IGST'), money('cess', 'Cess'), money('total', 'Total amount')],
      rows: rows.map((row) => ({
        hsn: (row.hsn as string) || 'Not set', rate: n(row.rate) / 100, quantity: n(row.quantity), taxable: n(row.taxable), cgst: n(row.cgst),
        sgst: n(row.sgst), igst: n(row.igst), cess: n(row.cess), total: n(row.total),
      })),
      totals: ['quantity', 'taxable', 'cgst', 'sgst', 'igst', 'cess', 'total'],
      summary: [
        count('Total sales quantity', rows.reduce((total, row) => total + n(row.quantity), 0)),
        amount('Taxable value', rows.reduce((total, row) => total + n(row.taxable), 0)),
        amount('Total sales amount', rows.reduce((total, row) => total + n(row.total), 0)),
      ],
      note: ('Every bill issued in the period, as the GST return needs.' + (await this.unpaidNote(auth, query))).trim(),
    };
  }

  /** One row for every payment received, in the order it was taken. */
  private async payments(auth: AuthContext, query: ReportQuery): Promise<Built> {
    const payments = await this.prisma.payment.findMany({
      where: { restaurantId: auth.restaurantId, status: 'SUCCESS', invoice: { status: 'ISSUED' }, businessDate: { gte: asDate(query.from), lte: asDate(query.to) } },
      include: { invoice: { select: { invoiceNumber: true } } },
      orderBy: { createdAt: 'asc' },
      take: ROW_LIMIT + 1,
    });
    const shown = payments.slice(0, ROW_LIMIT);
    const names = await this.names(shown.map((payment) => payment.receivedById));
    return {
      summary: [
        count('Payments', shown.length),
        amount('Total received', shown.reduce((total, payment) => total + payment.amountPaise, 0)),
        amount('Net after refunds', shown.reduce((total, payment) => total + payment.amountPaise - payment.refundedPaise, 0)),
      ],
      columns: [col('date', 'Date', 'datetime'), col('receipt', 'Receipt no.'), col('method', 'Payment method'), money('amount', 'Amount'), money('refunded', 'Refunded since'),
        money('net', 'Total amount'), col('reference', 'Reference'), col('createdBy', 'Created by')],
      rows: shown.map((payment) => ({
        date: (payment.paidAt ?? payment.createdAt).toISOString(), receipt: payment.invoice.invoiceNumber, method: METHODS[payment.method] ?? payment.method,
        amount: payment.amountPaise, refunded: payment.refundedPaise, net: payment.amountPaise - payment.refundedPaise, reference: payment.reference ?? '',
        createdBy: names.get(payment.receivedById) ?? '',
      })),
      totals: ['amount', 'refunded', 'net'],
      truncated: payments.length > ROW_LIMIT,
      note: '"Refunded since" is money returned against a payment at any later time. Total amount is what remains of it.',
    };
  }

  private async paymentSummary(auth: AuthContext, query: ReportQuery): Promise<Built> {
    const rows = await this.prisma.$queryRaw<Raw[]>`
      SELECT to_char(p.business_date, 'YYYY-MM-DD') AS date, p.method::text AS method, count(*)::int AS count, sum(p.amount_paise) AS amount, sum(p.refunded_paise) AS refunded
      FROM payments p WHERE p.restaurant_id = ${auth.restaurantId}::uuid AND p.status = 'SUCCESS' AND ${standingBill('p')} AND p.business_date BETWEEN ${query.from}::date AND ${query.to}::date
      GROUP BY 1, 2 ORDER BY 1, 2`;
    return {
      columns: [col('date', 'Date', 'date'), col('method', 'Payment method'), col('count', 'Payments', 'number'), money('amount', 'Amount'), money('refunded', 'Refunded since'), money('net', 'Total amount')],
      rows: rows.map((row) => ({ date: row.date as string, method: METHODS[row.method as string] ?? (row.method as string), count: n(row.count), amount: n(row.amount), refunded: n(row.refunded), net: n(row.amount) - n(row.refunded) })),
      totals: ['count', 'amount', 'refunded', 'net'],
      summary: [
        count('Payments', rows.reduce((total, row) => total + n(row.count), 0)),
        amount('Total received', rows.reduce((total, row) => total + n(row.amount), 0)),
        amount('Net after refunds', rows.reduce((total, row) => total + n(row.amount) - n(row.refunded), 0)),
      ],
      note: '"Refunded since" is money returned against these payments at any later time.',
    };
  }

  private async discounts(auth: AuthContext, query: ReportQuery): Promise<Built> {
    const rows = await this.prisma.discount.findMany({
      where: { restaurantId: auth.restaurantId, order: { status: 'SETTLED', businessDate: { gte: asDate(query.from), lte: asDate(query.to) } } },
      include: {
        order: { select: { series: true, orderNumber: true, subtotalPaise: true, totalPaise: true, invoices: { where: { status: 'ISSUED' }, select: { invoiceNumber: true, payments: paidWith } } } },
        orderItem: { select: { name: true, quantity: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: ROW_LIMIT + 1,
    });
    const shown = rows.slice(0, ROW_LIMIT);
    const names = await this.names(shown.flatMap((row) => [row.appliedById, row.approvedById]));
    return {
      summary: [count('Discounts given', shown.length), amount('Total discount', shown.reduce((total, row) => total + row.amountPaise, 0))],
      columns: [col('date', 'Date', 'datetime'), col('order', 'Order'), col('bill', 'Receipt no.'), col('method', 'Payment method'), col('on', 'Discount on'),
        col('unit', 'Unit', 'number'), col('given', 'Given as'), money('gross', 'Amount'), money('amount', 'Discount'), money('total', 'Total amount'),
        col('reason', 'Reason'), col('by', 'Created by'), col('approvedBy', 'Approved by')],
      rows: shown.map((row) => ({
        date: row.createdAt.toISOString(), order: displayNumber(row.order), bill: row.order.invoices.map((i) => i.invoiceNumber).join(', '),
        method: methodsOf(row.order.invoices.flatMap((invoice) => invoice.payments)), on: row.orderItem?.name ?? 'Whole bill', unit: row.orderItem?.quantity ?? null,
        given: row.type === 'PERCENT' ? row.value / 100 + '%' : '₹' + (row.value / 100).toFixed(2), gross: row.order.subtotalPaise, amount: row.amountPaise,
        total: row.order.totalPaise, reason: row.reason ?? '', by: names.get(row.appliedById) ?? '', approvedBy: row.approvedById ? (names.get(row.approvedById) ?? '') : '',
      })),
      totals: ['amount'],
      truncated: rows.length > ROW_LIMIT,
      note: 'Discounts on completed orders. Amount and Total amount are the whole receipt before and after discount and tax. Unit is shown for a discount on a single item.',
    };
  }

  private async refunds(auth: AuthContext, query: ReportQuery): Promise<Built> {
    const rows = await this.prisma.refund.findMany({
      where: { restaurantId: auth.restaurantId, status: 'SUCCESS', invoice: { status: 'ISSUED' }, businessDate: { gte: asDate(query.from), lte: asDate(query.to) } },
      include: { invoice: { select: { invoiceNumber: true, totalPaise: true } }, items: { select: { quantity: true } } },
      orderBy: { createdAt: 'asc' },
      take: ROW_LIMIT + 1,
    });
    const shown = rows.slice(0, ROW_LIMIT);
    const names = await this.names(shown.flatMap((row) => [row.createdById, row.approvedById]));
    return {
      summary: [count('Refunds', shown.length), amount('Total refunded', shown.reduce((total, row) => total + row.amountPaise, 0))],
      columns: [col('time', 'Date', 'datetime'), col('creditNote', 'Credit note'), col('bill', 'Receipt no.'), col('method', 'Payment method'), col('unit', 'Unit', 'number'),
        money('billTotal', 'Receipt amount'), money('amount', 'Total amount'), money('taxable', 'Taxable value'), money('tax', 'Tax reversed'), col('reason', 'Reason'),
        col('by', 'Created by'), col('approvedBy', 'Approved by')],
      rows: shown.map((row) => ({
        time: row.createdAt.toISOString(), creditNote: row.creditNoteNumber, bill: row.invoice.invoiceNumber, method: METHODS[row.method] ?? row.method,
        // Only a refund of specific items has a quantity.
        unit: row.items.length > 0 ? row.items.reduce((total, item) => total + item.quantity, 0) : null,
        billTotal: row.invoice.totalPaise, amount: row.amountPaise, taxable: row.taxablePaise,
        tax: row.cgstPaise + row.sgstPaise + row.igstPaise + row.cessPaise, reason: row.reason,
        by: names.get(row.createdById) ?? '', approvedBy: row.approvedById ? (names.get(row.approvedById) ?? '') : '',
      })),
      totals: ['amount', 'taxable', 'tax'],
      truncated: rows.length > ROW_LIMIT,
      note: 'Total amount is the money returned. Receipt amount is the full value of the receipt it was returned against.',
    };
  }

  private async cancellations(auth: AuthContext, query: ReportQuery): Promise<Built> {
    const rows = await this.prisma.invoice.findMany({
      where: { restaurantId: auth.restaurantId, status: 'CANCELLED', businessDate: { gte: asDate(query.from), lte: asDate(query.to) } },
      include: { items: { select: { quantity: true } } },
      orderBy: { issuedAt: 'asc' },
      take: ROW_LIMIT + 1,
    });
    const shown = rows.slice(0, ROW_LIMIT);
    const names = await this.names(shown.flatMap((row) => [row.createdById, row.cancelledById]));
    return {
      summary: [count('Cancelled receipts', shown.length), amount('Total amount cancelled', shown.reduce((total, row) => total + row.totalPaise, 0))],
      columns: [col('issued', 'Date', 'datetime'), col('bill', 'Receipt no.'), col('cancelled', 'Cancelled at', 'datetime'), col('unit', 'Unit', 'number'),
        money('gross', 'Amount'), money('discount', 'Discount'), money('total', 'Total amount'), col('reason', 'Reason'), col('issuedBy', 'Created by'), col('cancelledBy', 'Cancelled by')],
      rows: shown.map((row) => ({
        issued: row.issuedAt.toISOString(), bill: row.invoiceNumber, cancelled: row.cancelledAt?.toISOString() ?? null,
        unit: row.items.reduce((total, item) => total + item.quantity, 0), gross: row.grossPaise, discount: row.discountPaise, total: row.totalPaise,
        reason: row.cancelReason ?? '', issuedBy: names.get(row.createdById) ?? '', cancelledBy: row.cancelledById ? (names.get(row.cancelledById) ?? '') : '',
      })),
      totals: ['unit', 'gross', 'discount', 'total'],
      truncated: rows.length > ROW_LIMIT,
    };
  }

  private async cashiers(auth: AuthContext, query: ReportQuery): Promise<Built> {
    const range = Prisma.sql`business_date BETWEEN ${query.from}::date AND ${query.to}::date`;
    const rid = Prisma.sql`${auth.restaurantId}::uuid`;
    const [bills, units, payments, refunds, discounts, cancelled] = await Promise.all([
      this.prisma.$queryRaw<Raw[]>`SELECT i.created_by_id AS id, count(*)::int AS bills, sum(i.gross_paise) AS gross, sum(i.discount_paise) AS discount, sum(i.total_paise) AS billed FROM invoices i WHERE ${this.completed(auth, query)} GROUP BY 1`,
      this.prisma.$queryRaw<Raw[]>`
        SELECT i.created_by_id AS id, sum(ii.quantity)::int AS units FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
        WHERE ${this.completed(auth, query)} GROUP BY 1`,
      this.prisma.$queryRaw<Raw[]>`SELECT received_by_id AS id, method::text AS method, sum(amount_paise) AS amount FROM payments WHERE restaurant_id = ${rid} AND status = 'SUCCESS' AND ${standingBill('payments')} AND ${range} GROUP BY 1, 2`,
      this.prisma.$queryRaw<Raw[]>`SELECT created_by_id AS id, sum(amount_paise) AS amount FROM refunds WHERE restaurant_id = ${rid} AND status = 'SUCCESS' AND ${standingBill('refunds')} AND ${range} GROUP BY 1`,
      this.prisma.$queryRaw<Raw[]>`
        SELECT d.applied_by_id AS id, sum(d.amount_paise) AS amount FROM discounts d JOIN orders o ON o.id = d.order_id
        WHERE d.restaurant_id = ${rid} AND o.status = 'SETTLED' AND o.business_date BETWEEN ${query.from}::date AND ${query.to}::date GROUP BY 1`,
      this.prisma.$queryRaw<Raw[]>`SELECT cancelled_by_id AS id, count(*)::int AS count FROM invoices WHERE restaurant_id = ${rid} AND status = 'CANCELLED' AND ${range} AND cancelled_by_id IS NOT NULL GROUP BY 1`,
    ]);
    const byUser = new Map<string, Row>();
    const row = (id: unknown): Row => {
      const key = id as string;
      if (!byUser.has(key)) byUser.set(key, { name: '', bills: 0, unit: 0, gross: 0, discount: 0, billed: 0, cash: 0, upi: 0, card: 0, other: 0, collected: 0, discounts: 0, refunds: 0, cancelled: 0 });
      return byUser.get(key)!;
    };
    for (const r of bills) Object.assign(row(r.id), { bills: n(r.bills), gross: n(r.gross), discount: n(r.discount), billed: n(r.billed) });
    for (const r of units) row(r.id).unit = n(r.units);
    for (const r of payments) {
      const target = row(r.id);
      const key = (r.method as string).toLowerCase();
      target[key] = n(target[key]) + n(r.amount);
      target.collected = n(target.collected) + n(r.amount);
    }
    for (const r of refunds) row(r.id).refunds = n(r.amount);
    for (const r of discounts) row(r.id).discounts = n(r.amount);
    for (const r of cancelled) row(r.id).cancelled = n(r.count);
    const names = await this.names([...byUser.keys()]);
    for (const [id, target] of byUser) target.name = names.get(id) ?? 'Unknown';
    const rows = [...byUser.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return {
      summary: [
        count('Total sales (receipts)', rows.reduce((total, entry) => total + n(entry.bills), 0)),
        count('Total sales quantity', rows.reduce((total, entry) => total + n(entry.unit), 0)),
        amount('Total sales amount', rows.reduce((total, entry) => total + n(entry.billed), 0)),
      ],
      columns: [col('name', 'Created by'), col('bills', 'Receipts', 'number'), col('unit', 'Unit', 'number'), money('gross', 'Amount'), money('discount', 'Discount'),
        money('billed', 'Total amount'), money('cash', 'Cash'), money('upi', 'UPI'), money('card', 'Card'), money('other', 'Other'), money('collected', 'Collected'),
        money('discounts', 'Discounts given'), money('refunds', 'Refunds issued'), col('cancelled', 'Receipts cancelled', 'number')],
      rows,
      totals: ['bills', 'unit', 'gross', 'discount', 'billed', 'cash', 'upi', 'card', 'other', 'collected', 'discounts', 'refunds', 'cancelled'],
      note: 'Amount, Discount and Total amount are for receipts of completed orders a person issued. Collected counts payments they recorded, which can be for receipts issued by someone else. Discounts given counts discounts they entered.',
    };
  }

  /** Today at a glance for the owner. "Today" is the current business day, which respects the day cut-off. */
  async dashboard(auth: AuthContext): Promise<DashboardDto> {
    const { businessDate } = await this.context.load(auth.restaurantId);
    const today = { from: businessDate, to: businessDate };
    const weekAgo = new Date(asDate(businessDate).getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
    const rid = Prisma.sql`${auth.restaurantId}::uuid`;

    const [[sales], [refunds], payments, trend, top, orders, [unpaid], recent] = await Promise.all([
      this.prisma.$queryRaw<Raw[]>`SELECT count(*)::int AS bills, sum(i.total_paise) AS total, sum(i.discount_paise) AS discount FROM invoices i WHERE ${this.completed(auth, today)}`,
      this.prisma.$queryRaw<Raw[]>`SELECT sum(amount_paise) AS amount FROM refunds WHERE restaurant_id = ${rid} AND status = 'SUCCESS' AND ${standingBill('refunds')} AND business_date = ${businessDate}::date`,
      this.prisma.$queryRaw<Raw[]>`SELECT method::text AS method, count(*)::int AS count, sum(amount_paise) AS amount FROM payments WHERE restaurant_id = ${rid} AND status = 'SUCCESS' AND ${standingBill('payments')} AND business_date = ${businessDate}::date GROUP BY 1 ORDER BY 3 DESC`,
      this.prisma.$queryRaw<Raw[]>`SELECT to_char(i.business_date, 'YYYY-MM-DD') AS date, count(*)::int AS bills, sum(i.total_paise) AS total FROM invoices i WHERE ${this.completed(auth, { from: weekAgo, to: businessDate })} GROUP BY 1`,
      this.prisma.$queryRaw<Raw[]>`
        SELECT coalesce(oi.name, ii.name) AS name, sum(ii.quantity)::int AS quantity, sum(ii.total_paise) AS total
        FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id LEFT JOIN order_items oi ON oi.id = ii.order_item_id
        WHERE ${this.completed(auth, today)} GROUP BY 1 ORDER BY 2 DESC, 3 DESC LIMIT 5`,
      this.prisma.order.groupBy({ by: ['status'], where: { restaurantId: auth.restaurantId, businessDate: asDate(businessDate) }, _count: true }),
      this.prisma.$queryRaw<Raw[]>`SELECT count(*)::int AS bills, sum(total_paise - paid_paise) AS amount FROM invoices WHERE restaurant_id = ${rid} AND status = 'ISSUED' AND paid_paise < total_paise`,
      this.prisma.invoice.findMany({ where: { restaurantId: auth.restaurantId }, include: invoiceListInclude, orderBy: { issuedAt: 'desc' }, take: 8 }),
    ]);

    const total = n(sales?.total);
    const bills = n(sales?.bills);
    const refunded = n(refunds?.amount);
    const count = (...statuses: string[]) => orders.filter((group) => statuses.includes(group.status)).reduce((sum, group) => sum + group._count, 0);
    const byDate = new Map(trend.map((row) => [row.date as string, row]));
    const names = await this.names(recent.map((invoice) => invoice.createdById));
    return {
      businessDate,
      sales: { totalPaise: total, bills, averagePaise: bills > 0 ? Math.round(total / bills) : 0, discountPaise: n(sales?.discount), refundsPaise: refunded, netPaise: total - refunded },
      orders: { taken: count('OPEN', 'HELD', 'BILLED', 'SETTLED', 'CANCELLED'), running: count('OPEN', 'HELD', 'BILLED'), cancelled: count('CANCELLED') },
      unpaid: { bills: n(unpaid?.bills), amountPaise: n(unpaid?.amount) },
      payments: payments.map((row) => ({ method: row.method as PaymentMethod, amountPaise: n(row.amount), count: n(row.count) })),
      trend: Array.from({ length: 7 }, (_, index) => {
        const date = new Date(asDate(weekAgo).getTime() + index * 86_400_000).toISOString().slice(0, 10);
        return { date, totalPaise: n(byDate.get(date)?.total), bills: n(byDate.get(date)?.bills) };
      }),
      topItems: top.map((row) => ({ name: row.name as string, quantity: n(row.quantity), totalPaise: n(row.total) })),
      recentBills: recent.map((invoice) => toInvoiceListItem(invoice, names)),
    };
  }
}
