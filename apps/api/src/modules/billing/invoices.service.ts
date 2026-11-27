import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { allocate, type BillLineInput, computeBill, discountAmount, financialYearOf, formatDocumentNumber } from '@pos/billing-core';
import { type Prisma, PrismaClient, type SeriesType } from '@pos/database';
import { PAPER_COLUMNS, type PaperWidthKey, type PrintDocument, REALTIME_EVENTS } from '@pos/types';
import type {
  amendOrderSchema, cancelInvoiceSchema, changePaymentMethodSchema, InvoiceDto, OrderDto, InvoiceListItemDto, invoiceQuerySchema, issueInvoicesSchema, Page, PrintJobDto, printRequestSchema,
  recordPaymentsSchema, refundInputSchema,
} from '@pos/validation';
import type { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { conflict, invalid, notFound } from '../../common/errors.js';
import { inOrderOf, pageOfSorted } from '../../common/sort.js';
import { AuditService } from '../audit/audit.service.js';
import { renderCreditNote, renderReceipt } from '@pos/printing';
import { PrintQueueService } from '../printing/print-queue.service.js';
import { PrintingService } from '../printing/printing.service.js';
import { RealtimeService } from '../realtime/realtime.gateway.js';
import { ApprovalsService } from './approvals.service.js';
import { asDate, type BillingContext, BillingContextService } from './billing-context.js';
import { compactSeries, eraseBills, lockForErase, lockOrder, withOwnerOverride } from './erase.js';
import { buildSeller, invoiceInclude, invoiceListInclude, type InvoiceRow, toInvoiceDto, toInvoiceListItem } from './mappers.js';
import { OrdersService } from './orders.service.js';
import { openRegisterOf, stillOpen } from '../registers/register-link.js';

type Tx = Prisma.TransactionClient;
/**
 * What a replacement bill takes over from the bill it replaces: its identity, who it was made out to and by,
 * and the tax rates its lines were charged at. A bill dated last month keeps last month's seller details and rates.
 */
interface KeptBill {
  seriesId: string;
  number: number;
  issuedAt: Date;
  businessDate: Date;
  createdById: string;
  docType: 'TAX_INVOICE' | 'BILL_OF_SUPPLY';
  sellerSnapshot: Prisma.InputJsonValue;
  customerName: string | null;
  customerPhone: string | null;
  customerGstin: string | null;
  customerAddress: string | null;
  /** Order line id to the rates that line was billed at. Lines new to the order use today's rates. */
  rates: Map<string, { gstRateBps: number; cessRateBps: number }>;
}
const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 };
const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly context: BillingContextService,
    private readonly approvals: ApprovalsService,
    private readonly orders: OrdersService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
    private readonly printing: PrintingService,
    private readonly printQueue: PrintQueueService,
  ) {}

  private notify(auth: AuthContext, invoiceId: string, orderId: string): void {
    this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.invoiceUpdated, { invoiceId, orderId });
    this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.orderUpdated, { orderId });
    this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.tableUpdated);
  }

  // ── Reading ──

  async get(auth: AuthContext, id: string): Promise<InvoiceDto> {
    const invoice = await this.prisma.invoice.findFirst({ where: { id, restaurantId: auth.restaurantId }, include: invoiceInclude });
    // The order is read after the bill: when the owner erases the order at that very moment, the bill is found and its
    // order is not. The bill is gone with it, and the answer is the same as for any bill that no longer exists.
    if (!invoice || !invoice.order) throw notFound('Bill');
    return toInvoiceDto(invoice, await this.names(invoice));
  }

  async list(auth: AuthContext, query: z.output<typeof invoiceQuerySchema>): Promise<Page<InvoiceListItemDto>> {
    const where: Prisma.InvoiceWhereInput = {
      restaurantId: auth.restaurantId,
      status: query.status,
      paymentStatus: query.paymentStatus,
      businessDate: { gte: query.from ? asDate(query.from) : undefined, lte: query.to ? asDate(query.to) : undefined },
      createdById: auth.permissions.has('order.view_all') ? undefined : auth.userId,
      ...(query.search
        ? {
            OR: [
              { invoiceNumber: { contains: query.search, mode: 'insensitive' } },
              { customerName: { contains: query.search, mode: 'insensitive' } },
              { customerPhone: { contains: query.search } },
            ],
          }
        : {}),
    };
    const direction = query.direction;
    const total = await this.prisma.invoice.count({ where });

    // A bill records who made it by id only, so sorting by the cashier's name is done here.
    if (query.sort === 'cashier') {
      const light = await this.prisma.invoice.findMany({ where, orderBy: { issuedAt: 'desc' }, select: { id: true, createdById: true } });
      const cashiers = await this.userNames(light.map((row) => row.createdById));
      const ids = pageOfSorted(light, (row) => cashiers.get(row.createdById) ?? null, direction, query.page, query.pageSize);
      const rows = inOrderOf(ids, await this.prisma.invoice.findMany({ where: { id: { in: ids } }, include: invoiceListInclude }));
      return { items: rows.map((row) => toInvoiceListItem(row, cashiers)), total, page: query.page, pageSize: query.pageSize };
    }

    const columns: Record<string, Prisma.InvoiceOrderByWithRelationInput[]> = {
      bill: [{ invoiceNumber: direction }],
      issued: [{ issuedAt: direction }],
      order: [{ order: { businessDate: direction } }, { order: { orderNumber: direction } }],
      customer: [{ customerName: { sort: direction, nulls: 'last' } }],
      total: [{ totalPaise: direction }],
      paid: [{ paidPaise: direction }],
      status: [{ status: direction }, { paymentStatus: direction }],
    };
    const rows = await this.prisma.invoice.findMany({
      where, include: invoiceListInclude, orderBy: [...(query.sort ? columns[query.sort]! : []), { issuedAt: 'desc' }],
      skip: (query.page - 1) * query.pageSize, take: query.pageSize,
    });
    const names = await this.userNames(rows.map((row) => row.createdById));
    return { items: rows.map((row) => toInvoiceListItem(row, names)), total, page: query.page, pageSize: query.pageSize };
  }

  private async userNames(ids: string[]): Promise<Map<string, string>> {
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
    return new Map(users.map((user) => [user.id, user.name]));
  }

  private names(invoice: InvoiceRow): Promise<Map<string, string>> {
    return this.userNames([invoice.createdById, ...invoice.payments.map((p) => p.receivedById), ...invoice.refunds.map((r) => r.createdById)]);
  }

  // ── Issuing ──

  /**
   * Turns an order into one invoice, or one per part when the bill is split by item.
   * From here the order's lines are locked and each invoice is a permanent record.
   */
  async issue(auth: AuthContext, orderId: string, input: z.output<typeof issueInvoicesSchema>): Promise<InvoiceDto[]> {
    const { ids, repeated } = await this.prisma.$transaction(async (tx) => {
      const already = await this.alreadyIssued(tx, auth, orderId, input.invoiceIds);
      if (already) return { ids: already, repeated: true };
      return { ...(await this.issueInTx(tx, auth, await this.context.load(auth.restaurantId, tx), orderId, input)), repeated: false };
    }, TX_OPTIONS);

    const invoices = await Promise.all(ids.map((id) => this.get(auth, id)));
    // A repeated request changed nothing: no notices and no second audit entry.
    if (repeated) return invoices;
    for (const id of ids) this.notify(auth, id, orderId);
    for (const invoice of invoices) {
      await this.audit.record(auth, {
        action: 'invoice.issued', entityType: 'invoice', entityId: invoice.id,
        after: { number: invoice.invoiceNumber, order: invoice.orderDisplayNumber, totalPaise: invoice.totalPaise, split: ids.length > 1 },
      });
    }
    return invoices;
  }

  /**
   * The bills a repeated request already issued: the POS sends the same bill ids again when the answer to its first
   * request was lost. Returns their ids in the order asked for, or null when none of them exists yet. Ids that belong
   * to another order are refused rather than quietly answered.
   */
  private async alreadyIssued(tx: Tx, auth: AuthContext, orderId: string, invoiceIds: string[] | undefined): Promise<string[] | null> {
    if (!invoiceIds) return null;
    // Held first, as for issuing: a second request waits for the first to finish and then finds its bills.
    await lockOrder(tx, auth.restaurantId, orderId);
    const found = await tx.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, orderId: true, restaurantId: true } });
    if (found.length === 0) return null;
    if (found.some((invoice) => invoice.orderId !== orderId || invoice.restaurantId !== auth.restaurantId)) {
      throw conflict('INVOICE_ID_TAKEN', 'These bill ids belong to another order. Bill the order again.');
    }
    return invoiceIds.filter((id) => found.some((invoice) => invoice.id === id));
  }

  /**
   * The work of issuing, inside the caller's transaction. `keep` gives the first bill the identity of
   * the bill it replaces (number, date and cashier), which is how a changed order keeps its bill number.
   */
  private async issueInTx(
    tx: Tx, auth: AuthContext, ctx: BillingContext, orderId: string, input: z.output<typeof issueInvoicesSchema>, keep?: KeptBill,
  ): Promise<{ ids: string[] }> {
    await lockOrder(tx, auth.restaurantId, orderId);
    const order = await tx.order.findFirst({
      where: { id: orderId, restaurantId: auth.restaurantId },
      include: { items: { orderBy: { sortOrder: 'asc' }, include: { modifiers: true, discounts: true } }, discounts: { where: { orderItemId: null } }, customer: true },
    });
    if (!order) throw notFound('Order');
    if (order.status !== 'OPEN' && order.status !== 'HELD') throw conflict('ORDER_LOCKED', 'This order has already been billed or closed.');
    if (order.items.length === 0) throw invalid('ORDER_EMPTY', 'Add at least one item before billing.');
    // Billing never sends anything to the kitchen: only the KOT button makes kitchen tickets (decided 2026-11-24).
    // A changed bill keeps its own series; a new one is numbered by the till it belongs to (see numberingTill).
    const terminalId = keep ? (order.terminalId ?? auth.terminalId) : await this.numberingTill(tx, order.terminalId, auth.terminalId);
    if (!terminalId) throw invalid('TERMINAL_REQUIRED', 'Bills are issued from a billing terminal.');

    // One part with everything, unless the bill is split by item.
    const parts = input.parts ?? [order.items.map((item) => ({ orderItemId: item.id, quantity: item.quantity }))];
    const itemsById = new Map(order.items.map((item) => [item.id, item]));
    const assigned = new Map<string, number>();
    for (const part of parts) {
      for (const entry of part) {
        if (!itemsById.has(entry.orderItemId)) throw invalid('SPLIT_UNKNOWN_ITEM', 'The split refers to an item that is not on this order.');
        assigned.set(entry.orderItemId, (assigned.get(entry.orderItemId) ?? 0) + entry.quantity);
      }
    }
    for (const item of order.items) {
      if (assigned.get(item.id) !== item.quantity) {
        throw invalid('SPLIT_INCOMPLETE', `Every item must be on exactly one bill: check "${item.name}".`);
      }
    }

    // A fixed-amount discount is shared between the parts in proportion; a percentage applies to each as is.
    const lineDiscount = (itemId: string) => itemsById.get(itemId)!.discounts[0] ?? null;
    const lineShares = new Map<string, number[]>();
    for (const item of order.items) {
      const discount = lineDiscount(item.id);
      if (discount?.type === 'AMOUNT') {
        lineShares.set(item.id, allocate(discount.value, parts.map((part) => part.filter((e) => e.orderItemId === item.id).reduce((s, e) => s + e.quantity, 0))));
      }
    }
    const partLines: BillLineInput[][] = parts.map((part, partIndex) =>
      part.map((entry) => {
        const item = itemsById.get(entry.orderItemId)!;
        const discount = lineDiscount(item.id);
        return {
          id: item.id,
          quantity: entry.quantity,
          unitPricePaise: item.unitPricePaise,
          priceIncludesTax: item.priceIncludesTax,
          tax: keep?.rates.get(item.id) ?? (item.taxGroupId ? (ctx.taxRates.get(item.taxGroupId) ?? null) : null),
          discount: !discount ? null
            : discount.type === 'PERCENT' ? { type: 'PERCENT' as const, value: discount.value }
            : { type: 'AMOUNT' as const, value: lineShares.get(item.id)![partIndex]! },
        };
      }),
    );
    const orderDiscount = order.discounts[0] ?? null;
    const partNets = partLines.map((lines) =>
      lines.reduce((sum, line) => sum + line.quantity * line.unitPricePaise - discountAmount(line.quantity * line.unitPricePaise, line.discount), 0),
    );
    const orderShares = orderDiscount?.type === 'AMOUNT' ? allocate(Math.min(orderDiscount.value, partNets.reduce((a, b) => a + b, 0)), partNets) : null;

    const placeOfSupply = input.placeOfSupply ?? ctx.restaurant.stateCode;
    const interState = placeOfSupply !== ctx.restaurant.stateCode;
    const series = keep
      ? await tx.numberSeries.findUniqueOrThrow({ where: { id: keep.seriesId } })
      : await this.series(tx, auth.restaurantId, terminalId, 'INVOICE', ctx.businessDate);
    const seller = buildSeller(ctx.restaurant, ctx.settings);
    const created: string[] = [];
    const totals = { gross: 0, discount: 0, tax: 0, service: 0, roundOff: 0, total: 0 };

    for (const [index, lines] of partLines.entries()) {
      const bill = computeBill({
        lines,
        discount: !orderDiscount ? null
          : orderDiscount.type === 'PERCENT' ? { type: 'PERCENT', value: orderDiscount.value }
          : { type: 'AMOUNT', value: orderShares![index]! },
        taxApplicable: keep ? keep.docType === 'TAX_INVOICE' : ctx.taxApplicable,
        interState,
        serviceChargeBps: ctx.settings.serviceChargeEnabled ? ctx.settings.serviceChargeBps : 0,
        serviceChargeTax: ctx.defaultTax,
        roundOff: ctx.settings.roundOffMode,
      });
      const kept = index === 0 ? keep : undefined;
      const number = kept ? kept.number : await this.nextNumber(tx, series.id);
      // A kept number may be the one the counter was about to hand out; move the counter past it.
      if (kept) await tx.$executeRaw`UPDATE number_series SET next_number = GREATEST(next_number, ${kept.number + 1}) WHERE id = ${series.id}::uuid`;
      const invoice = await tx.invoice.create({
        data: {
          ...(input.invoiceIds?.[index] ? { id: input.invoiceIds[index] } : {}),
          restaurantId: auth.restaurantId, orderId, terminalId, seriesId: series.id, number,
          invoiceNumber: formatDocumentNumber(series.prefix, series.financialYear, number),
          docType: kept?.docType ?? (ctx.taxApplicable ? 'TAX_INVOICE' : 'BILL_OF_SUPPLY'),
          // A bill with nothing to pay (fully discounted) is settled the moment it is issued.
          paymentStatus: bill.totalPaise === 0 ? 'PAID' : 'UNPAID',
          businessDate: kept?.businessDate ?? asDate(ctx.businessDate),
          ...(kept ? { issuedAt: kept.issuedAt } : {}),
          sellerSnapshot: kept?.sellerSnapshot ?? (seller as unknown as Prisma.InputJsonValue),
          customerName: kept ? kept.customerName : (order.customer?.name ?? null), customerPhone: kept ? kept.customerPhone : (order.customer?.phone ?? null),
          customerGstin: kept ? kept.customerGstin : null, customerAddress: kept ? kept.customerAddress : (order.customer?.address ?? null),
          placeOfSupply, isInterState: interState,
          grossPaise: bill.grossPaise, discountPaise: bill.discountPaise, taxablePaise: bill.taxablePaise,
          cgstPaise: bill.cgstPaise, sgstPaise: bill.sgstPaise, igstPaise: bill.igstPaise, cessPaise: bill.cessPaise,
          serviceChargePaise: bill.serviceChargePaise, roundOffPaise: bill.roundOffPaise, totalPaise: bill.totalPaise,
          createdById: kept?.createdById ?? auth.userId,
          items: {
            create: bill.lines.map((line, sortOrder) => {
              const item = itemsById.get(line.id)!;
              const extras = item.modifiers.map((m) => m.name).join(', ');
              return {
                orderItemId: item.id,
                name: `${item.name}${item.variantName ? ` (${item.variantName})` : ''}${extras ? ` + ${extras}` : ''}`,
                hsnSac: item.hsnSac, quantity: line.quantity, unitPricePaise: line.unitPricePaise, grossPaise: line.grossPaise,
                discountPaise: line.discountPaise, taxablePaise: line.taxablePaise, taxRateBps: line.gstRateBps,
                cgstPaise: line.cgstPaise, sgstPaise: line.sgstPaise, igstPaise: line.igstPaise, cessPaise: line.cessPaise,
                totalPaise: line.totalPaise, sortOrder,
              };
            }),
          },
          taxes: { create: bill.taxSummary.map((row) => ({ type: row.type, name: row.type, rateBps: row.rateBps, taxablePaise: row.taxablePaise, amountPaise: row.amountPaise })) },
        },
      });
      created.push(invoice.id);
      totals.gross += bill.grossPaise; totals.discount += bill.discountPaise; totals.tax += bill.taxPaise;
      totals.service += bill.serviceChargePaise; totals.roundOff += bill.roundOffPaise; totals.total += bill.totalPaise;
    }

    // The order now shows what was actually billed.
    await tx.order.update({
      where: { id: orderId },
      data: {
        status: 'BILLED', heldAt: null, subtotalPaise: totals.gross, discountPaise: totals.discount, taxPaise: totals.tax,
        serviceChargePaise: totals.service, roundOffPaise: totals.roundOff, totalPaise: totals.total, version: { increment: 1 },
      },
    });
    if (order.tableId) await tx.diningTable.update({ where: { id: order.tableId }, data: { status: 'BILL_PRINTED' } });
    // A bill for nothing (everything discounted away) has nothing left to pay, so its order is complete at once.
    await this.settleOrderIfPaid(tx, orderId);
    return { ids: created };
  }

  /**
   * Changes the items of an order that is already billed, in one step: the old bill and the money against
   * it are erased, the order takes its new lines, and a bill is issued again under the same number and
   * date. With `payment`, the new total is recorded as paid in full. Either all of it happens or none.
   * The kitchen is not told: this corrects the record of an order that was already served.
   */
  async amend(auth: AuthContext, orderId: string, input: z.output<typeof amendOrderSchema>): Promise<OrderDto> {
    const notBilled = () => conflict('ORDER_NOT_BILLED', 'This order has no bill yet, so it can be changed as it is.');
    const seen = await this.prisma.order.findFirst({ where: { id: orderId, restaurantId: auth.restaurantId } });
    if (!seen) throw notFound('Order');
    if (seen.status !== 'BILLED' && seen.status !== 'SETTLED') throw notBilled();
    const approvedBy = await this.approvals.resolve(auth, 'invoice.delete', input.approval);

    const invoiceId = await this.prisma.$transaction(async (tx) => {
      const ctx = await this.context.load(auth.restaurantId, tx);
      const closing = ctx.settings.orderRenumberMode === 'AUTO';
      await lockForErase(tx, auth.restaurantId, orderId, { standingOnly: true, closeGaps: closing });
      // Checked again now that the order is held: someone may have reopened or changed it a moment ago.
      const order = await tx.order.findFirst({ where: { id: orderId, restaurantId: auth.restaurantId } });
      if (!order) throw notFound('Order');
      if (order.status !== 'BILLED' && order.status !== 'SETTLED') throw notBilled();

      // The bills being replaced are the ones still standing; a bill cancelled earlier stays as the record it is.
      const bills = await tx.invoice.findMany({
        where: { orderId, restaurantId: auth.restaurantId, status: 'ISSUED' }, orderBy: [{ issuedAt: 'asc' }, { number: 'asc' }],
        include: { items: true, payments: { where: { status: 'SUCCESS' }, orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }] } },
      });
      const old = bills[0];
      const rates: KeptBill['rates'] = new Map();
      for (const item of bills.flatMap((bill) => bill.items)) {
        if (item.orderItemId) {
          rates.set(item.orderItemId, { gstRateBps: item.taxRateBps, cessRateBps: item.taxablePaise > 0 ? Math.round((item.cessPaise * 10_000) / item.taxablePaise) : 0 });
        }
      }
      // Money actually held against the old bills: each payment less what was refunded from it.
      const received = bills.flatMap((bill) => bill.payments).map((payment) => ({ ...payment, netPaise: payment.amountPaise - payment.refundedPaise })).filter((payment) => payment.netPaise > 0)
        .sort((a, b) => (a.paidAt ?? a.createdAt).getTime() - (b.paidAt ?? b.createdAt).getTime());
      // Gaps are closed further down, once the bill is back under its number: closing them now would hand that number to the next bill.
      const { erased, starts } = await eraseBills(tx, auth.restaurantId, orderId, { standingOnly: true });

      // While it is being changed the order counts as running. If other guests have its table by now, it lets go of the table for that time.
      let tableId = order.tableId;
      if (tableId) {
        const table = await tx.diningTable.findUnique({ where: { id: tableId } });
        const taken = await tx.order.count({ where: { tableId, id: { not: orderId }, status: { in: ['OPEN', 'HELD', 'BILLED'] } } });
        if (!table || table.status === 'BLOCKED' || taken > 0) tableId = null;
      }
      await tx.order.update({ where: { id: orderId }, data: { status: 'OPEN', tableId, heldAt: null, version: { increment: 1 } } });
      await this.orders.replaceItemsInTx(tx, auth, ctx, orderId, input.items, input.discount ?? null, input.approval);

      const { ids } = await this.issueInTx(tx, auth, ctx, orderId, old ? { placeOfSupply: old.placeOfSupply } : {}, old && {
        seriesId: old.seriesId, number: old.number, issuedAt: old.issuedAt, businessDate: old.businessDate, createdById: old.createdById,
        docType: old.docType, sellerSnapshot: old.sellerSnapshot as Prisma.InputJsonValue,
        customerName: old.customerName, customerPhone: old.customerPhone, customerGstin: old.customerGstin, customerAddress: old.customerAddress, rates,
      });
      // An order that had been split into several bills leaves the other numbers free; the bills after them move up.
      const renumbered = closing ? await compactSeries(tx, starts) : [];
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: ids[0]! } });

      // Payments are dated as the ones they replace, so each day's takings stay on the day they were taken.
      const first = received[0];
      const replacements = input.payment === 'KEEP'
        ? received.map((payment) => ({ method: payment.method, amountPaise: payment.netPaise, reference: payment.reference, businessDate: payment.businessDate, receivedById: payment.receivedById, paidAt: payment.paidAt, registerSessionId: payment.registerSessionId }))
        : input.payment && invoice.totalPaise > 0
          ? [{
              method: input.payment.method, amountPaise: invoice.totalPaise, reference: input.payment.reference ?? null,
              businessDate: first?.businessDate ?? asDate(ctx.businessDate), receivedById: first?.receivedById ?? auth.userId, paidAt: first?.paidAt ?? new Date(),
              // The money stays in the cash register that took it.
              registerSessionId: first?.registerSessionId ?? null,
            }]
          : [];
      const paid = replacements.reduce((sum, payment) => sum + payment.amountPaise, 0);
      if (paid > invoice.totalPaise) {
        throw invalid('PAYMENTS_EXCEED_TOTAL', `${rupees(paid)} was received against the old bill, which is more than the new total of ${rupees(invoice.totalPaise)}. Choose how the new total was paid instead.`);
      }
      for (const payment of replacements) {
        await tx.payment.create({
          data: { restaurantId: auth.restaurantId, invoiceId: invoice.id, status: 'SUCCESS', idempotencyKey: this.key(auth, `amend:${randomUUID()}`), ...payment },
        });
      }
      if (paid > 0) {
        await tx.invoice.update({ where: { id: invoice.id }, data: { paidPaise: paid, paymentStatus: paid >= invoice.totalPaise ? 'PAID' : 'PARTIALLY_PAID' } });
        await this.settleOrderIfPaid(tx, orderId);
      }
      // Settled again, the order no longer holds a table, so it can show the one it was served at.
      const after = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      if (after.status === 'SETTLED' && order.tableId && !after.tableId) await tx.order.update({ where: { id: orderId }, data: { tableId: order.tableId } });

      // Written with the change, so a bill is never replaced without its entry in the audit log.
      await this.audit.record(auth, {
        action: 'order.amended', entityType: 'order', entityId: orderId, reason: input.reason,
        before: { number: `${order.series}-${order.orderNumber}`, status: order.status, totalPaise: order.totalPaise, bills: erased },
        after: {
          invoiceNumber: invoice.invoiceNumber, totalPaise: invoice.totalPaise, paidPaise: paid,
          payments: replacements.map((payment) => ({ method: payment.method, amountPaise: payment.amountPaise })), approvedBy,
          ...(renumbered.length > 0 ? { billsRenumbered: renumbered } : {}),
        },
      }, tx);
      return invoice.id;
    }, TX_OPTIONS);

    this.notify(auth, invoiceId, orderId);
    return this.orders.get(auth, orderId);
  }

  /** Counts a print. The first is the original; later ones are reprints and are audited. */
  async markPrinted(auth: AuthContext, id: string): Promise<InvoiceDto> {
    const invoice = await this.prisma.invoice.findFirst({ where: { id, restaurantId: auth.restaurantId } });
    if (!invoice) throw notFound('Bill');
    if (invoice.printCount > 0 && !auth.permissions.has('invoice.reprint')) {
      throw invalid('REPRINT_NOT_ALLOWED', 'You do not have permission to reprint bills.');
    }
    const updated = await this.prisma.invoice.update({ where: { id }, data: { printCount: { increment: 1 } } });
    if (updated.printCount > 1) {
      await this.audit.record(auth, { action: 'invoice.reprinted', entityType: 'invoice', entityId: id, after: { number: invoice.invoiceNumber, printCount: updated.printCount } });
    }
    return this.get(auth, id);
  }

  /** Sends the bill to the receipt printer through the print bridge, and counts the print. */
  async print(auth: AuthContext, id: string, input: z.output<typeof printRequestSchema>): Promise<PrintJobDto> {
    const invoice = await this.get(auth, id);
    if (invoice.printCount > 0 && !auth.permissions.has('invoice.reprint')) {
      throw invalid('REPRINT_NOT_ALLOWED', 'You do not have permission to reprint bills.');
    }
    const [layouts, ctx] = await Promise.all([this.printing.layouts(auth.restaurantId), this.context.load(auth.restaurantId)]);
    const job = await this.printQueue.queue(auth.restaurantId, {
      type: 'RECEIPT', role: 'RECEIPT', refType: 'invoice', refId: id, title: 'Bill ' + invoice.invoiceNumber, printerId: input.printerId,
      isReprint: invoice.printCount > 0, requestedById: auth.userId,
      render: (columns) => renderReceipt(invoice, layouts.receipt, columns, ctx.settings.timezone),
    });
    await this.markPrinted(auth, id);
    return job!;
  }

  /** The bill laid out as lines of text, for a printer connected to the asking device (WebUSB or Web Serial). */
  async printDocument(auth: AuthContext, id: string, width: PaperWidthKey): Promise<PrintDocument> {
    const invoice = await this.get(auth, id);
    if (invoice.printCount > 0 && !auth.permissions.has('invoice.reprint')) {
      throw invalid('REPRINT_NOT_ALLOWED', 'You do not have permission to reprint bills.');
    }
    const [layouts, ctx] = await Promise.all([this.printing.layouts(auth.restaurantId), this.context.load(auth.restaurantId)]);
    return renderReceipt(invoice, layouts.receipt, PAPER_COLUMNS[width], ctx.settings.timezone);
  }

  /** Sends the credit note of a refund to the receipt printer. */
  async printCreditNote(auth: AuthContext, id: string, refundId: string, input: z.output<typeof printRequestSchema>): Promise<PrintJobDto> {
    const refund = await this.prisma.refund.findFirst({ where: { id: refundId, invoiceId: id, restaurantId: auth.restaurantId } });
    if (!refund) throw notFound('Refund');
    const [invoice, ctx] = await Promise.all([this.get(auth, id), this.context.load(auth.restaurantId)]);
    const note = {
      sellerName: invoice.seller.name, gstin: invoice.seller.gstin, creditNoteNumber: refund.creditNoteNumber, invoiceNumber: invoice.invoiceNumber,
      createdAt: refund.createdAt.toISOString(), createdByName: invoice.refunds.find((entry) => entry.id === refundId)?.createdByName ?? '',
      method: refund.method, amountPaise: refund.amountPaise, taxablePaise: refund.taxablePaise,
      taxPaise: refund.cgstPaise + refund.sgstPaise + refund.igstPaise + refund.cessPaise, reason: refund.reason, customerName: invoice.customer?.name ?? null,
    };
    const job = await this.printQueue.queue(auth.restaurantId, {
      type: 'CREDIT_NOTE', role: 'RECEIPT', refType: 'refund', refId: refundId, title: 'Credit note ' + refund.creditNoteNumber, printerId: input.printerId,
      requestedById: auth.userId, render: (columns) => renderCreditNote(note, columns, ctx.settings.timezone),
    });
    return job!;
  }

  /**
   * Cancels a bill that has no money against it. The invoice and its number stay on record,
   * marked cancelled. A paid bill must be refunded instead.
   */
  async cancel(auth: AuthContext, id: string, input: z.output<typeof cancelInvoiceSchema>): Promise<InvoiceDto> {
    const invoice = await this.prisma.invoice.findFirst({ where: { id, restaurantId: auth.restaurantId }, include: { order: true } });
    if (!invoice) throw notFound('Bill');
    if (invoice.status === 'CANCELLED') throw conflict('INVOICE_CANCELLED', 'This bill is already cancelled.');
    if (invoice.paidPaise - invoice.refundedPaise > 0) {
      throw invalid('INVOICE_PAID', `This bill has ${rupees(invoice.paidPaise - invoice.refundedPaise)} paid against it. Refund the payment first.`);
    }
    // Cancelling after money changed hands is the more sensitive action.
    const approvedBy = await this.approvals.resolve(auth, invoice.paidPaise > 0 ? 'invoice.cancel_after_settlement' : 'order.cancel', input.approval);

    await this.prisma.$transaction(async (tx) => {
      // Checked again now that the bill is held: it may have been paid or cancelled a moment ago.
      const current = await this.lock(tx, auth, id);
      if (current.status === 'CANCELLED') throw conflict('INVOICE_CANCELLED', 'This bill is already cancelled.');
      if (current.paidPaise - current.refundedPaise > 0) {
        throw invalid('INVOICE_PAID', `This bill has ${rupees(current.paidPaise - current.refundedPaise)} paid against it. Refund the payment first.`);
      }
      await tx.invoice.update({
        where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: auth.userId, cancelReason: input.reason },
      });
      const remaining = await tx.invoice.count({ where: { orderId: invoice.orderId, status: 'ISSUED' } });
      if (remaining > 0) {
        await this.settleOrderIfPaid(tx, invoice.orderId);
      } else if (input.reopenOrder) {
        // Back to editing, so the order can be corrected and billed again under a new invoice number.
        await tx.order.update({ where: { id: invoice.orderId }, data: { status: 'OPEN', version: { increment: 1 } } });
        if (invoice.order.tableId) await tx.diningTable.update({ where: { id: invoice.order.tableId }, data: { status: 'OCCUPIED' } });
        await this.orders.recalculate(tx, await this.context.load(auth.restaurantId, tx), invoice.orderId);
      } else {
        await tx.order.update({
          where: { id: invoice.orderId },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: auth.userId, cancelReason: input.reason, version: { increment: 1 } },
        });
        if (invoice.order.tableId) await this.orders.freeTable(tx, invoice.order.tableId);
      }
    }, TX_OPTIONS);

    await this.audit.record(auth, {
      action: 'invoice.cancelled', entityType: 'invoice', entityId: id, reason: input.reason,
      before: { number: invoice.invoiceNumber, totalPaise: invoice.totalPaise }, after: { approvedBy, reopenOrder: input.reopenOrder },
    });
    this.notify(auth, id, invoice.orderId);
    return this.get(auth, id);
  }

  // ── Payments ──

  /**
   * Records one or more tenders against a bill in a single step, so a split payment either
   * lands completely or not at all. Each tender carries an id from the POS: sending the same
   * id again (a retry, a double tap) returns the bill as it stands and records nothing new.
   */
  async recordPayments(auth: AuthContext, id: string, input: z.output<typeof recordPaymentsSchema>): Promise<InvoiceDto> {
    if (new Set(input.payments.map((p) => p.id)).size !== input.payments.length) throw invalid('DUPLICATE_PAYMENT_ID', 'The same payment was listed twice.');
    const recorded = await this.prisma.$transaction(async (tx) => {
      const invoice = await this.lock(tx, auth, id);
      const keys = input.payments.map((p) => this.key(auth, p.id));
      const seen = new Set((await tx.payment.findMany({ where: { idempotencyKey: { in: keys } }, select: { idempotencyKey: true } })).map((p) => p.idempotencyKey));
      const fresh = input.payments.filter((p) => !seen.has(this.key(auth, p.id)));
      if (fresh.length === 0) return [];

      if (invoice.status !== 'ISSUED') throw conflict('INVOICE_CANCELLED', 'This bill is cancelled and cannot take payments.');
      const due = invoice.totalPaise - invoice.paidPaise;
      const paying = fresh.reduce((sum, p) => sum + p.amountPaise, 0);
      if (paying > due) {
        throw invalid('OVERPAYMENT', due === 0 ? 'This bill is already paid in full.' : `Only ${rupees(due)} is due on this bill.`);
      }
      const ctx = await this.context.load(auth.restaurantId, tx);
      // Everything this person takes while their cash register is open belongs to that register.
      const registerSessionId = await openRegisterOf(tx, auth.restaurantId, auth.userId);
      if (!registerSessionId && ctx.settings.registerRequired && fresh.some((payment) => payment.method === 'CASH')) {
        throw conflict('REGISTER_NOT_OPEN', 'Open your cash register before taking cash.');
      }
      for (const payment of fresh) {
        if (payment.tenderedPaise !== undefined && (payment.method !== 'CASH' || payment.tenderedPaise < payment.amountPaise)) {
          throw invalid('TENDER_INVALID', 'Cash handed over must be at least the amount being paid.');
        }
        await tx.payment.create({
          data: {
            restaurantId: auth.restaurantId, invoiceId: id, method: payment.method, status: 'SUCCESS', amountPaise: payment.amountPaise,
            tenderedPaise: payment.tenderedPaise ?? null,
            changePaise: payment.tenderedPaise === undefined ? null : payment.tenderedPaise - payment.amountPaise,
            reference: payment.reference ?? null, idempotencyKey: this.key(auth, payment.id),
            businessDate: asDate(ctx.businessDate), receivedById: auth.userId, paidAt: new Date(), registerSessionId,
          },
        });
      }
      const paid = invoice.paidPaise + paying;
      await tx.invoice.update({ where: { id }, data: { paidPaise: paid, paymentStatus: paid >= invoice.totalPaise ? 'PAID' : 'PARTIALLY_PAID' } });
      await this.settleOrderIfPaid(tx, invoice.orderId);
      return fresh;
    }, TX_OPTIONS);

    if (recorded.length > 0) {
      await this.audit.record(auth, {
        action: 'payment.recorded', entityType: 'invoice', entityId: id,
        after: { payments: recorded.map((p) => ({ method: p.method, amountPaise: p.amountPaise })) },
      });
    }
    const paid = await this.get(auth, id);
    if (recorded.length > 0) this.notify(auth, id, paid.orderId);
    return paid;
  }

  /**
   * Corrects how a payment was made, for example when cash was recorded and the guest in fact paid by UPI.
   * The amount, the bill and the day it counts towards stay as they were; reports follow the new method.
   */
  async changePaymentMethod(auth: AuthContext, id: string, paymentId: string, input: z.output<typeof changePaymentMethodSchema>): Promise<InvoiceDto> {
    const orderId = await this.prisma.$transaction(async (tx) => {
      const invoice = await this.lock(tx, auth, id);
      if (invoice.status !== 'ISSUED') throw conflict('INVOICE_CANCELLED', 'This bill is cancelled, so its payment can no longer be changed.');
      const payment = await tx.payment.findFirst({ where: { id: paymentId, invoiceId: id, restaurantId: auth.restaurantId } });
      if (!payment) throw notFound('Payment');
      if (payment.status !== 'SUCCESS' || payment.provider !== 'manual') {
        throw conflict('PAYMENT_NOT_EDITABLE', 'Only a completed payment that was recorded by hand can be changed.');
      }
      if (payment.method === input.method) throw invalid('SAME_METHOD', 'This payment is already recorded with that method.');
      await withOwnerOverride(tx, () =>
        // Cash handed over and change returned describe a cash payment only.
        tx.payment.update({ where: { id: paymentId }, data: { method: input.method, reference: input.reference ?? null, tenderedPaise: null, changePaise: null } }),
      );
      await this.audit.record(auth, {
        action: 'payment.method_changed', entityType: 'invoice', entityId: id, reason: input.reason,
        before: { invoiceNumber: invoice.invoiceNumber, amountPaise: payment.amountPaise, method: payment.method, reference: payment.reference },
        after: { method: input.method, reference: input.reference ?? null },
      }, tx);
      return invoice.orderId;
    }, TX_OPTIONS);

    this.notify(auth, id, orderId);
    return this.get(auth, id);
  }

  /**
   * Returns money against one payment and issues a credit note. The invoice itself is not edited.
   * Refund by amount, or by items, in which case the amount is worked out from the bill.
   */
  async refund(auth: AuthContext, id: string, input: z.output<typeof refundInputSchema>): Promise<InvoiceDto> {
    const approvedBy = await this.approvals.resolve(auth, 'refund.create', input.approval);
    const outcome = await this.prisma.$transaction(async (tx) => {
      const invoice = await this.lock(tx, auth, id);
      if (await tx.refund.findUnique({ where: { idempotencyKey: this.key(auth, input.id) } })) return null;
      if (invoice.status !== 'ISSUED') throw conflict('INVOICE_CANCELLED', 'This bill is cancelled.');

      const payment = await tx.payment.findFirst({ where: { id: input.paymentId, invoiceId: id, status: 'SUCCESS' } });
      if (!payment) throw invalid('PAYMENT_NOT_FOUND', 'Choose the payment to refund.');

      const items = await tx.invoiceItem.findMany({ where: { invoiceId: id }, include: { refundItems: true } });
      const lines = (input.items ?? []).map((entry) => {
        const item = items.find((candidate) => candidate.id === entry.invoiceItemId);
        if (!item) throw invalid('REFUND_UNKNOWN_ITEM', 'An item to refund is not on this bill.');
        const left = item.quantity - item.refundItems.reduce((sum, r) => sum + r.quantity, 0);
        if (entry.quantity > left) throw invalid('REFUND_QUANTITY', `Only ${left} of "${item.name}" can still be refunded.`);
        return { item, quantity: entry.quantity, amountPaise: Math.round((item.totalPaise * entry.quantity) / item.quantity) };
      });
      const amount = input.amountPaise ?? lines.reduce((sum, line) => sum + line.amountPaise, 0);
      if (amount <= 0) throw invalid('REFUND_ZERO', 'There is nothing to refund for these items.');

      const refundable = payment.amountPaise - payment.refundedPaise;
      if (amount > refundable) {
        throw invalid('REFUND_EXCEEDS_PAYMENT', `Only ${rupees(refundable)} of this ${payment.method.toLowerCase()} payment can still be refunded.`);
      }

      // The credit note carries the tax being reversed: exact for items, pro rata for a plain amount.
      const share = (value: number) => Math.round((value * amount) / Math.max(invoice.totalPaise, 1));
      const sumOf = (pick: (item: (typeof items)[number]) => number) =>
        lines.reduce((sum, line) => sum + Math.round((pick(line.item) * line.quantity) / line.item.quantity), 0);
      const tax = input.items
        ? { taxablePaise: sumOf((i) => i.taxablePaise), cgstPaise: sumOf((i) => i.cgstPaise), sgstPaise: sumOf((i) => i.sgstPaise), igstPaise: sumOf((i) => i.igstPaise), cessPaise: sumOf((i) => i.cessPaise) }
        : { taxablePaise: share(invoice.taxablePaise), cgstPaise: share(invoice.cgstPaise), sgstPaise: share(invoice.sgstPaise), igstPaise: share(invoice.igstPaise), cessPaise: share(invoice.cessPaise) };

      const ctx = await this.context.load(auth.restaurantId, tx);
      const terminalId = await this.numberingTill(tx, invoice.terminalId, auth.terminalId);
      if (!terminalId) throw invalid('TERMINAL_REQUIRED', 'Refunds are issued from a billing terminal.');
      const series = await this.series(tx, auth.restaurantId, terminalId, 'CREDIT_NOTE', ctx.businessDate);
      const number = await this.nextNumber(tx, series.id);
      const creditNoteNumber = formatDocumentNumber(series.prefix, series.financialYear, number);
      // The money leaves the register of whoever hands it back; failing that, the register that took it, if still open.
      const registerSessionId = (await openRegisterOf(tx, auth.restaurantId, auth.userId)) ?? (await stillOpen(tx, auth.restaurantId, payment.registerSessionId));
      await tx.refund.create({
        data: {
          registerSessionId,
          restaurantId: auth.restaurantId, invoiceId: id, paymentId: payment.id, seriesId: series.id, number, creditNoteNumber,
          method: payment.method, status: 'SUCCESS', amountPaise: amount, ...tax, reason: input.reason,
          idempotencyKey: this.key(auth, input.id), businessDate: asDate(ctx.businessDate), createdById: auth.userId, approvedById: approvedBy,
          items: { create: lines.map((line) => ({ invoiceItemId: line.item.id, quantity: line.quantity, amountPaise: line.amountPaise })) },
        },
      });
      await tx.payment.update({ where: { id: payment.id }, data: { refundedPaise: { increment: amount } } });
      const refunded = invoice.refundedPaise + amount;
      await tx.invoice.update({
        where: { id }, data: { refundedPaise: refunded, paymentStatus: refunded >= invoice.paidPaise ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
      });
      return { creditNoteNumber, amount };
    }, TX_OPTIONS);

    if (outcome) {
      await this.audit.record(auth, {
        action: 'refund.issued', entityType: 'invoice', entityId: id, reason: input.reason,
        after: { creditNote: outcome.creditNoteNumber, amountPaise: outcome.amount, approvedBy },
      });
    }
    const refunded = await this.get(auth, id);
    if (outcome) this.notify(auth, id, refunded.orderId);
    return refunded;
  }

  // ── Internals ──

  /** Payment and refund ids from the POS are unique per restaurant, not globally. */
  private key(auth: AuthContext, clientId: string): string {
    return `${auth.restaurantId}:${clientId}`;
  }

  /**
   * The till whose series a new bill or credit note is numbered in: the till its order or bill belongs to, unless that
   * is a device's hidden offline till. Only that device numbers its offline series, so the same order billed or
   * refunded online takes the number of the till signed in here instead.
   */
  private async numberingTill(tx: Tx, own: string | null, signedIn: string | null): Promise<string | null> {
    if (!own) return signedIn;
    const till = await tx.terminal.findUnique({ where: { id: own }, select: { kind: true } });
    return till?.kind === 'OFFLINE' ? signedIn : own;
  }

  /** Holds the invoice row until the transaction ends, so two tills cannot both pay or refund the same balance. */
  private async lock(tx: Tx, auth: AuthContext, id: string) {
    // The order first, as everything that touches an order's bills does; then the bill itself.
    const owner = await tx.invoice.findFirst({ where: { id, restaurantId: auth.restaurantId }, select: { orderId: true } });
    if (!owner) throw notFound('Bill');
    await lockOrder(tx, auth.restaurantId, owner.orderId);
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id}::uuid AND restaurant_id = ${auth.restaurantId}::uuid FOR UPDATE`;
    const invoice = await tx.invoice.findFirst({ where: { id, restaurantId: auth.restaurantId } });
    if (!invoice) throw notFound('Bill');
    return invoice;
  }

  /** An order is settled once every bill still standing against it is fully paid. */
  private async settleOrderIfPaid(tx: Tx, orderId: string): Promise<void> {
    const invoices = await tx.invoice.findMany({ where: { orderId, status: 'ISSUED' }, select: { totalPaise: true, paidPaise: true } });
    if (invoices.length === 0 || invoices.some((invoice) => invoice.paidPaise < invoice.totalPaise)) return;
    const order = await tx.order.update({ where: { id: orderId }, data: { status: 'SETTLED', version: { increment: 1 } } });
    if (order.tableId) await this.orders.freeTable(tx, order.tableId);
  }

  /** The terminal's number series for this document type and financial year, created on first use. */
  private async series(tx: Tx, restaurantId: string, terminalId: string, type: SeriesType, businessDate: string) {
    const financialYear = financialYearOf(businessDate);
    const terminal = await tx.terminal.findFirstOrThrow({ where: { id: terminalId, restaurantId } });
    // Terminal codes are letters and digits only, so "C-" can never clash with an invoice series.
    const prefix = type === 'INVOICE' ? terminal.code : `C-${terminal.code}`;
    // Two tills can raise the first bill of the year at the same moment. ON CONFLICT lets the
    // second wait for the first and reuse its row, where a plain insert would fail the transaction.
    await tx.$executeRaw`
      INSERT INTO number_series (id, restaurant_id, terminal_id, type, financial_year, prefix, next_number, created_at, updated_at)
      VALUES (gen_random_uuid(), ${restaurantId}::uuid, ${terminalId}::uuid, ${type}::"SeriesType", ${financialYear}, ${prefix}, 1, now(), now())
      ON CONFLICT (terminal_id, type, financial_year) DO NOTHING`;
    return tx.numberSeries.findUniqueOrThrow({ where: { terminalId_type_financialYear: { terminalId, type, financialYear } } });
  }

  /** Takes the next number. The row lock taken by the update makes the sequence gapless under concurrency. */
  private async nextNumber(tx: Tx, seriesId: string): Promise<number> {
    const series = await tx.numberSeries.update({ where: { id: seriesId }, data: { nextNumber: { increment: 1 } } });
    return series.nextNumber - 1;
  }
}
