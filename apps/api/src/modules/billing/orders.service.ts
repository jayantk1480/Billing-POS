import { HttpStatus, Injectable } from '@nestjs/common';
import { type BillLineInput, computeBill, discountAmount, discountBps } from '@pos/billing-core';
import { Prisma, PrismaClient } from '@pos/database';
import { REALTIME_EVENTS } from '@pos/types';
import type {
  ApprovalInput, mergeOrderSchema, OrderDto, orderQuerySchema, OrderSummaryDto, Page, reasonSchema, RenumberResult,
  saveOrderSchema,
} from '@pos/validation';
import type { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { conflict, invalid, notFound } from '../../common/errors.js';
import { inOrderOf, pageOfSorted } from '../../common/sort.js';
import { DomainError } from '../../common/filters/api-exception.filter.js';
import { AuditService } from '../audit/audit.service.js';
import { RealtimeService } from '../realtime/realtime.gateway.js';
import { ApprovalsService } from './approvals.service.js';
import { asDate, type BillingContext, BillingContextService } from './billing-context.js';
import { saveCustomerRecord } from './customer-record.js';
import { compactSeries, eraseBills, lockForErase, lockOrder, type RenumberedSeries } from './erase.js';
import { kitchenLine, KotsService } from './kots.service.js';
import { displayNumber, orderInclude, orderSummaryInclude, toOrderDto, toOrderSummary } from './mappers.js';

type Tx = Prisma.TransactionClient;
type SaveInput = z.output<typeof saveOrderSchema>;
type ItemInput = SaveInput['items'][number];
type DiscountIn = NonNullable<SaveInput['discount']>;

const EDITABLE = ['OPEN', 'HELD'] as const;
const MAX_ORDER_PAISE = 2_000_000_000;
const RUNNING = ['OPEN', 'HELD', 'BILLED'] as const;
const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 };

const productInclude = {
  variants: { where: { deletedAt: null } },
  modifierGroups: { include: { modifierGroup: { include: { modifiers: { where: { deletedAt: null } } } } } },
} satisfies Prisma.ProductInclude;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

/** What a line is priced and taxed as, fixed when the item is added. */
interface LineSnapshot {
  name: string;
  variantName: string | null;
  variantId: string | null;
  hsnSac: string | null;
  taxGroupId: string | null;
  priceIncludesTax: boolean;
  stationId: string | null;
  unitPricePaise: number;
  modifiers: { modifierId: string; name: string; pricePaise: number }[];
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly context: BillingContextService,
    private readonly approvals: ApprovalsService,
    private readonly kots: KotsService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
  ) {}

  /** Tells every screen that this order, and the floor, may look different now. */
  private notify(auth: AuthContext, orderId: string): void {
    this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.orderUpdated, { orderId });
    this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.tableUpdated);
  }

  // ── Reading ──

  async get(auth: AuthContext, id: string): Promise<OrderDto> {
    const order = await this.prisma.order.findFirst({ where: { id, restaurantId: auth.restaurantId }, include: orderInclude });
    if (!order) throw notFound('Order');
    return toOrderDto(order);
  }

  async list(auth: AuthContext, query: z.output<typeof orderQuerySchema>): Promise<Page<OrderSummaryDto>> {
    const search = query.search?.trim();
    // "12" is an order or token number; "A1-12" is an order number as the list shows it. Longer digit strings are phone numbers.
    const digits = search && /^\d{1,9}$/.test(search) ? Number(search) : undefined;
    const display = search ? /^([A-Za-z0-9]{1,4})-(\d{1,9})$/.exec(search) : null;
    const where: Prisma.OrderWhereInput = {
      restaurantId: auth.restaurantId,
      status: query.status,
      type: query.type,
      businessDate: { gte: query.from ? asDate(query.from) : undefined, lte: query.to ? asDate(query.to) : undefined },
      // Without the permission a user sees only the orders they took.
      createdById: auth.permissions.has('order.view_all') ? undefined : auth.userId,
      ...(search
        ? {
            OR: [
              ...(digits ? [{ orderNumber: digits }, { tokenNumber: digits }] : []),
              ...(display ? [{ series: { equals: display[1]!, mode: 'insensitive' as const }, orderNumber: Number(display[2]) }] : []),
              { customer: { name: { contains: search, mode: 'insensitive' as const } } },
              { customer: { phone: { contains: search } } },
              { table: { name: { contains: search, mode: 'insensitive' as const } } },
              { invoices: { some: { invoiceNumber: { contains: search, mode: 'insensitive' as const } } } },
            ],
          }
        : {}),
    };
    const direction = query.direction;
    const newestFirst: Prisma.OrderOrderByWithRelationInput[] = [{ businessDate: 'desc' }, { createdAt: 'desc' }];
    const total = await this.prisma.order.count({ where });
    const page = { skip: (query.page - 1) * query.pageSize, take: query.pageSize };

    // The bill number and how an order was paid come from its bills, so those two columns are put in order here.
    if (query.sort === 'bill' || query.sort === 'billingType') {
      const light = await this.prisma.order.findMany({
        where, orderBy: newestFirst,
        select: { id: true, invoices: { select: { invoiceNumber: true, status: true, payments: { where: { status: 'SUCCESS' }, select: { method: true } } } } },
      });
      const ids = pageOfSorted(light, (order) => {
        if (query.sort === 'bill') return order.invoices.map((invoice) => invoice.invoiceNumber).sort()[0] ?? null;
        const methods = ['CASH', 'UPI', 'CARD', 'OTHER'].filter((method) => order.invoices.some((invoice) => invoice.status !== 'CANCELLED' && invoice.payments.some((payment) => payment.method === method)));
        return methods.join(' ') || null;
      }, direction, query.page, query.pageSize);
      const rows = await this.prisma.order.findMany({ where: { id: { in: ids } }, include: orderSummaryInclude });
      return { items: inOrderOf(ids, rows).map(toOrderSummary), total, page: query.page, pageSize: query.pageSize };
    }

    const columns: Record<string, Prisma.OrderOrderByWithRelationInput[]> = {
      order: [{ businessDate: direction }, { series: direction }, { orderNumber: direction }],
      date: [{ createdAt: direction }],
      type: [{ type: direction }],
      takenBy: [{ createdBy: { name: direction } }],
      total: [{ totalPaise: direction }],
      status: [{ status: direction }],
    };
    const rows = await this.prisma.order.findMany({
      where, include: orderSummaryInclude, orderBy: query.sort ? [...columns[query.sort]!, ...newestFirst] : newestFirst, ...page,
    });
    return { items: rows.map(toOrderSummary), total, page: query.page, pageSize: query.pageSize };
  }

  /** Orders still in progress: being taken, held, or billed and waiting for payment. */
  async running(auth: AuthContext): Promise<OrderSummaryDto[]> {
    const rows = await this.prisma.order.findMany({
      where: { restaurantId: auth.restaurantId, status: { in: [...RUNNING] } },
      include: orderSummaryInclude,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toOrderSummary);
  }

  // ── Saving ──

  /**
   * Creates the order, or replaces its details and lines. The POS builds the order locally and
   * sends the whole thing; the id is generated by the POS so a retried save cannot create a copy.
   * Prices and taxes are always taken from the menu here, never from the request.
   */
  async save(auth: AuthContext, id: string, input: SaveInput): Promise<OrderDto> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const ctx = await this.context.load(auth.restaurantId, tx);
      // Held so that a bill cannot be issued for this order halfway through the save.
      await lockOrder(tx, auth.restaurantId, id);
      const existing = await tx.order.findUnique({
        where: { id },
        include: { items: { include: { modifiers: true } }, discounts: true },
      });
      if (existing && existing.restaurantId !== auth.restaurantId) throw notFound('Order');
      if (existing && !EDITABLE.includes(existing.status as never)) {
        throw conflict('ORDER_LOCKED', 'This order has been billed or closed and can no longer be changed.');
      }
      if (existing && input.version !== undefined && input.version !== existing.version) {
        throw conflict('ORDER_CHANGED', 'This order was changed on another terminal. Reload it and try again.');
      }

      const tableId = input.type === 'DINE_IN' ? (input.tableId ?? null) : null;
      if (tableId && tableId !== existing?.tableId) await this.assertTableFree(tx, auth, tableId, id);
      const customerId = await this.saveCustomer(tx, auth, input.customer);

      const details = {
        type: input.type,
        tableId,
        customerId,
        guests: input.guests,
        notes: input.notes ?? null,
        deliveryAddress: input.type === 'DELIVERY' ? (input.deliveryAddress ?? null) : null,
      };

      if (!existing) {
        if (!auth.terminalId) {
          throw invalid('TERMINAL_REQUIRED', 'Orders are taken on a billing terminal. Choose this device\'s terminal first.');
        }
        const terminal = await tx.terminal.findFirstOrThrow({ where: { id: auth.terminalId, restaurantId: auth.restaurantId } });
        const orderNumber = await this.nextOrderNumber(tx, auth.restaurantId, terminal.code, ctx.numberPeriod);
        await tx.order.create({
          data: {
            id, restaurantId: auth.restaurantId, terminalId: terminal.id, series: terminal.code, numberPeriod: ctx.numberPeriod,
            orderNumber, tokenNumber: orderNumber, businessDate: asDate(ctx.businessDate), createdById: auth.userId, ...details,
          },
        });
      } else {
        await tx.order.update({ where: { id }, data: details });
      }

      const cancelTickets = existing ? await this.cancelSentItems(tx, auth, ctx, id, input, existing.items) : [];
      const lines = await this.saveItems(tx, auth, ctx, id, input.items, existing?.items ?? []);
      await this.saveDiscountsAndTotals(tx, auth, ctx, id, lines, input.discount ?? null, existing?.discounts ?? [], input.approval);

      if (tableId) await tx.diningTable.update({ where: { id: tableId }, data: { status: 'OCCUPIED' } });
      if (existing?.tableId && existing.tableId !== tableId) await this.freeTable(tx, existing.tableId);
      return { created: !existing, cancelTickets };
    }, TX_OPTIONS);

    await this.kots.announce(auth, outcome.cancelTickets, REALTIME_EVENTS.kotCreated);
    this.notify(auth, id);
    const order = await this.get(auth, id);
    await this.audit.record(auth, {
      action: outcome.created ? 'order.created' : 'order.updated', entityType: 'order', entityId: id,
      after: { number: order.displayNumber, type: order.type, items: order.items.length, totalPaise: order.totals.totalPaise, discountPaise: order.totals.discountPaise },
    });
    return order;
  }

  /**
   * Replaces the lines and bill discount of an order inside the caller's transaction, without telling
   * the kitchen. For correcting an order that was already served and billed: nothing is cooked or
   * cancelled because of it, so every line is marked as already dealt with.
   */
  async replaceItemsInTx(
    tx: Tx, auth: AuthContext, ctx: BillingContext, id: string, items: ItemInput[], discount: DiscountIn | null, approval: ApprovalInput | undefined,
  ): Promise<void> {
    const existing = await tx.order.findUniqueOrThrow({ where: { id }, include: { items: { include: { modifiers: true } }, discounts: true } });
    const lines = await this.saveItems(tx, auth, ctx, id, items, existing.items);
    await this.saveDiscountsAndTotals(tx, auth, ctx, id, lines, discount, existing.discounts, approval);
    await tx.$executeRaw`UPDATE order_items SET kot_quantity = quantity WHERE order_id = ${id}::uuid`;
  }

  /**
   * Items the kitchen already has cannot quietly disappear. Reducing or removing them needs a reason
   * and the right to do it, and sends the kitchen a cancellation ticket.
   */
  private async cancelSentItems(
    tx: Tx, auth: AuthContext, ctx: BillingContext, orderId: string, input: SaveInput,
    existing: Prisma.OrderItemGetPayload<{ include: { modifiers: true } }>[],
  ): Promise<string[]> {
    const wanted = new Map(input.items.map((item) => [item.id, item]));
    const reductions = existing.flatMap((item) => {
      if (item.kotQuantity === 0) return [];
      const next = wanted.get(item.id);
      const sameChoice = next && next.productId === item.productId && (next.variantId ?? null) === (item.variantId ?? null) &&
        [...next.modifierIds].sort().join() === item.modifiers.map((m) => m.modifierId).sort().join();
      if (next && !sameChoice) {
        throw invalid('ITEM_ALREADY_SENT', item.name + ' has already been sent to the kitchen. Remove it and add it again to change it.');
      }
      const keep = next ? next.quantity : 0;
      return keep < item.kotQuantity ? [{ item, quantity: item.kotQuantity - keep, keep: next ? keep : null }] : [];
    });
    if (reductions.length === 0) return [];
    if (!input.kotCancelReason) {
      throw new DomainError(
        'KOT_CANCEL_REASON_REQUIRED', 'These items were already sent to the kitchen. Give a reason for cancelling them.',
        HttpStatus.UNPROCESSABLE_ENTITY, { items: reductions.map((entry) => entry.item.name) },
      );
    }
    const approvedBy = await this.approvals.resolve(auth, 'kot.cancel_item', input.approval);
    const tickets = await this.kots.cancelInTx(tx, auth, ctx, orderId, reductions.map((entry) => kitchenLine(entry.item, entry.quantity)), input.kotCancelReason);
    for (const entry of reductions) {
      if (entry.keep !== null) await tx.orderItem.update({ where: { id: entry.item.id }, data: { kotQuantity: entry.keep } });
    }
    await this.audit.record(auth, {
      action: 'kot.items_cancelled', entityType: 'order', entityId: orderId, reason: input.kotCancelReason,
      after: { items: reductions.map((entry) => ({ name: entry.item.name, quantity: entry.quantity })), approvedBy },
    }, tx);
    return tickets;
  }

  /** Validates each line against the menu, writes the lines, and returns them ready for pricing. */
  private async saveItems(
    tx: Tx, auth: AuthContext, ctx: BillingContext, orderId: string, items: ItemInput[],
    existing: Prisma.OrderItemGetPayload<{ include: { modifiers: true } }>[],
  ): Promise<(BillLineInput & { discountInput: DiscountIn | null })[]> {
    if (new Set(items.map((item) => item.id)).size !== items.length) throw invalid('DUPLICATE_LINE', 'The same line was sent twice.');
    const before = new Map(existing.map((item) => [item.id, item]));
    const sameSelection = (item: ItemInput) => {
      const current = before.get(item.id);
      if (!current || current.productId !== item.productId || (current.variantId ?? null) !== (item.variantId ?? null)) return false;
      const have = current.modifiers.map((m) => m.modifierId).sort().join();
      return have === [...item.modifierIds].sort().join();
    };

    // Lines that are new or whose choices changed are priced from today's menu.
    // Lines that only changed quantity keep the price they were added at.
    const toPrice = items.filter((item) => !sameSelection(item));
    const products = new Map<string, ProductRow>(
      (
        await tx.product.findMany({
          where: { id: { in: [...new Set(toPrice.map((item) => item.productId))] }, restaurantId: auth.restaurantId, deletedAt: null },
          include: productInclude,
        })
      ).map((product) => [product.id, product]),
    );

    await tx.orderItem.deleteMany({ where: { orderId, id: { notIn: items.map((item) => item.id) } } });

    const lines: (BillLineInput & { discountInput: DiscountIn | null })[] = [];
    for (const [sortOrder, item] of items.entries()) {
      const current = before.get(item.id);
      let priced: Pick<LineSnapshot, 'unitPricePaise' | 'priceIncludesTax' | 'taxGroupId'>;
      if (current && sameSelection(item)) {
        await tx.orderItem.update({ where: { id: item.id }, data: { quantity: item.quantity, notes: item.notes ?? null, sortOrder } });
        priced = current;
      } else {
        const snapshot = this.snapshot(item, products.get(item.productId), ctx);
        const data = {
          productId: item.productId, variantId: snapshot.variantId, stationId: snapshot.stationId, name: snapshot.name,
          variantName: snapshot.variantName, hsnSac: snapshot.hsnSac, taxGroupId: snapshot.taxGroupId,
          priceIncludesTax: snapshot.priceIncludesTax, unitPricePaise: snapshot.unitPricePaise,
          quantity: item.quantity, notes: item.notes ?? null, sortOrder,
        };
        if (current) {
          await tx.orderItemModifier.deleteMany({ where: { orderItemId: item.id } });
          await tx.orderItem.update({ where: { id: item.id }, data: { ...data, modifiers: { create: snapshot.modifiers } } });
        } else {
          await tx.orderItem.create({ data: { id: item.id, orderId, ...data, modifiers: { create: snapshot.modifiers } } });
        }
        priced = snapshot;
      }
      lines.push({
        id: item.id,
        quantity: item.quantity,
        unitPricePaise: priced.unitPricePaise,
        priceIncludesTax: priced.priceIncludesTax,
        tax: priced.taxGroupId ? (ctx.taxRates.get(priced.taxGroupId) ?? null) : null,
        discount: item.discount ?? null,
        discountInput: item.discount ?? null,
      });
    }
    return lines;
  }

  private snapshot(item: ItemInput, product: ProductRow | undefined, ctx: BillingContext): LineSnapshot {
    if (!product || !product.isActive) throw invalid('ITEM_NOT_FOUND', 'An item on this order is no longer on the menu. Remove it and try again.');
    if (!product.isAvailable) throw invalid('ITEM_UNAVAILABLE', `${product.name} is marked unavailable.`);

    let variant: ProductRow['variants'][number] | null = null;
    if (product.variants.length > 0) {
      variant = product.variants.find((v) => v.id === item.variantId) ?? null;
      if (!variant) throw invalid('VARIANT_REQUIRED', `Choose a variant for ${product.name}.`);
      if (!variant.isAvailable) throw invalid('ITEM_UNAVAILABLE', `${product.name} (${variant.name}) is marked unavailable.`);
    } else if (item.variantId) {
      throw invalid('VARIANT_NOT_FOUND', `${product.name} has no variants.`);
    }

    const chosen = new Set(item.modifierIds);
    if (chosen.size !== item.modifierIds.length) throw invalid('DUPLICATE_MODIFIER', `An option for ${product.name} was chosen twice.`);
    const modifiers: LineSnapshot['modifiers'] = [];
    for (const { modifierGroup: group } of product.modifierGroups) {
      if (group.deletedAt || !group.isActive) continue;
      const picked = group.modifiers.filter((m) => chosen.has(m.id));
      if (picked.length < group.minSelect || picked.length > group.maxSelect) {
        const rule = group.minSelect === group.maxSelect ? `exactly ${group.minSelect}` : `${group.minSelect} to ${group.maxSelect}`;
        throw invalid('MODIFIER_SELECTION', `Choose ${rule} from "${group.name}" for ${product.name}.`);
      }
      for (const modifier of picked) {
        if (!modifier.isAvailable) throw invalid('ITEM_UNAVAILABLE', `${modifier.name} is marked unavailable.`);
        modifiers.push({ modifierId: modifier.id, name: modifier.name, pricePaise: modifier.pricePaise });
        chosen.delete(modifier.id);
      }
    }
    if (chosen.size > 0) throw invalid('MODIFIER_NOT_FOUND', `An option chosen for ${product.name} does not belong to it.`);

    return {
      name: product.name,
      variantName: variant?.name ?? null,
      variantId: variant?.id ?? null,
      hsnSac: product.hsnSac,
      taxGroupId: product.taxGroupId ?? ctx.settings.defaultTaxGroupId,
      priceIncludesTax: product.priceIncludesTax ?? ctx.settings.pricesIncludeTax,
      stationId: this.stationFor(product, ctx),
      unitPricePaise: (variant?.pricePaise ?? product.basePricePaise) + modifiers.reduce((sum, m) => sum + m.pricePaise, 0),
      modifiers,
    };
  }

  /**
   * The kitchen station an item's ticket goes to. A product with no station of its own, or whose station has been
   * switched off, goes to the first active station, so nothing the kitchen has to make is left off a ticket by accident.
   * Only a product marked as never going to the kitchen (bottled water) gets no ticket.
   */
  private stationFor(product: ProductRow, ctx: BillingContext): string | null {
    if (!product.sendToKitchen) return null;
    if (product.stationId && ctx.activeStationIds.includes(product.stationId)) return product.stationId;
    return ctx.activeStationIds[0] ?? null;
  }

  /** Checks discounts against the cashier's limit, stores them, and stores the computed totals. */
  private async saveDiscountsAndTotals(
    tx: Tx, auth: AuthContext, ctx: BillingContext, orderId: string,
    lines: (BillLineInput & { discountInput: DiscountIn | null })[], orderDiscount: DiscountIn | null,
    previous: Prisma.DiscountGetPayload<object>[], approval: ApprovalInput | undefined,
  ): Promise<void> {
    const bill = computeBill({
      lines,
      discount: orderDiscount,
      taxApplicable: ctx.taxApplicable,
      interState: false,
      serviceChargeBps: ctx.settings.serviceChargeEnabled ? ctx.settings.serviceChargeBps : 0,
      serviceChargeTax: ctx.defaultTax,
      roundOff: ctx.settings.roundOffMode,
    });
    // Amounts are stored as whole paise in 32-bit columns; an order beyond that is a typing mistake, not a sale.
    if (bill.grossPaise > MAX_ORDER_PAISE || bill.totalPaise > MAX_ORDER_PAISE) {
      throw invalid('ORDER_TOO_LARGE', 'This order comes to more than ₹2 crore. Check the quantities.');
    }

    // Each discount with the amount it is measured against, for the limit check.
    const netAfterLineDiscounts = lines.reduce((sum, line) => {
      const gross = line.quantity * line.unitPricePaise;
      return sum + gross - discountAmount(gross, line.discount);
    }, 0);
    const wanted = [
      ...lines.flatMap((line) => (line.discountInput ? [{ orderItemId: line.id as string | null, input: line.discountInput, base: line.quantity * line.unitPricePaise }] : [])),
      ...(orderDiscount ? [{ orderItemId: null, input: orderDiscount, base: netAfterLineDiscounts }] : []),
    ];

    const key = (orderItemId: string | null, type: string, value: number) => `${orderItemId ?? 'order'}:${type}:${value}`;
    const kept = new Map(previous.map((row) => [key(row.orderItemId, row.type, row.value), row]));
    // A discount already on the order was checked when it was added. A fixed amount is checked again if what it is taken
    // off has shrunk so far that it is now over the limit and nobody approved it: ₹100 off ten items is not ₹100 off one.
    const fresh = wanted.filter((d) => {
      const earlier = kept.get(key(d.orderItemId, d.input.type, d.input.value));
      return !earlier || (d.input.type === 'AMOUNT' && !earlier.approvedById && discountBps(d.base, d.input) > ctx.settings.discountCapBps);
    });

    let approvedBy: string | null = null;
    if (fresh.length > 0) {
      const overLimit = fresh.some((d) => discountBps(d.base, d.input) > ctx.settings.discountCapBps);
      approvedBy = await this.approvals.resolve(auth, overLimit ? 'discount.above_cap' : 'discount.apply', approval).catch((error: unknown) => {
        if (error instanceof DomainError && error.code === 'APPROVAL_REQUIRED' && overLimit) {
          throw new DomainError(
            'APPROVAL_REQUIRED',
            `Discounts above ${ctx.settings.discountCapBps / 100}% need a manager's approval.`,
            HttpStatus.FORBIDDEN,
            { permission: 'discount.above_cap' },
          );
        }
        throw error;
      });
    }

    await tx.discount.deleteMany({ where: { orderId } });
    if (wanted.length > 0) {
      await tx.discount.createMany({
        data: wanted.map((d) => {
          const earlier = kept.get(key(d.orderItemId, d.input.type, d.input.value));
          return {
            restaurantId: auth.restaurantId, orderId, orderItemId: d.orderItemId, type: d.input.type, value: d.input.value,
            amountPaise: discountAmount(d.base, d.input), reason: d.input.reason ?? null,
            appliedById: earlier?.appliedById ?? auth.userId, approvedById: earlier?.approvedById ?? (fresh.includes(d) ? approvedBy : null),
          };
        }),
      });
    }

    for (const line of bill.lines) {
      await tx.orderItem.update({
        where: { id: line.id },
        data: { grossPaise: line.grossPaise, discountPaise: line.discountPaise, taxablePaise: line.taxablePaise, taxPaise: line.taxPaise, totalPaise: line.totalPaise },
      });
    }
    await tx.order.update({
      where: { id: orderId },
      data: {
        subtotalPaise: bill.grossPaise, discountPaise: bill.discountPaise, taxPaise: bill.taxPaise,
        serviceChargePaise: bill.serviceChargePaise, roundOffPaise: bill.roundOffPaise, totalPaise: bill.totalPaise,
        version: { increment: 1 },
      },
    });
  }

  /** The order's customer, as a record of its own (see saveCustomerRecord). */
  private async saveCustomer(tx: Tx, auth: AuthContext, customer: SaveInput['customer']): Promise<string | null> {
    return customer ? saveCustomerRecord(tx, auth.restaurantId, customer) : null;
  }

  // ── State changes ──

  async hold(auth: AuthContext, id: string): Promise<OrderDto> {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockEditable(tx, auth, id);
      if (order._count.items === 0) throw invalid('ORDER_EMPTY', 'Add at least one item before holding the order.');
      await tx.order.update({ where: { id }, data: { status: 'HELD', heldAt: new Date(), version: { increment: 1 } } });
    }, TX_OPTIONS);
    await this.audit.record(auth, { action: 'order.held', entityType: 'order', entityId: id });
    this.notify(auth, id);
    return this.get(auth, id);
  }

  async resume(auth: AuthContext, id: string): Promise<OrderDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockEditable(tx, auth, id);
      await tx.order.update({ where: { id }, data: { status: 'OPEN', heldAt: null, version: { increment: 1 } } });
    }, TX_OPTIONS);
    this.notify(auth, id);
    return this.get(auth, id);
  }

  /** Cancels an order that has not been billed. It stays in the history with its reason. */
  async cancel(auth: AuthContext, id: string, input: z.output<typeof reasonSchema>): Promise<OrderDto> {
    // Checked before asking for a manager's PIN, and again below once the order is held.
    await this.findEditable(auth, id);
    const approvedBy = await this.approvals.resolve(auth, 'order.cancel', input.approval);
    const { order, tickets } = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockEditable(tx, auth, id);
      await tx.order.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: auth.userId, cancelReason: input.reason, version: { increment: 1 } },
      });
      if (order.tableId) await this.freeTable(tx, order.tableId);
      // Anything the kitchen was already making gets a cancellation ticket.
      const sent = await tx.orderItem.findMany({ where: { orderId: id, kotQuantity: { gt: 0 } }, include: { modifiers: true } });
      const tickets = await this.kots.cancelInTx(tx, auth, await this.context.load(auth.restaurantId, tx), id, sent.map((item) => kitchenLine(item, item.kotQuantity)), input.reason);
      return { order, tickets };
    }, TX_OPTIONS);
    await this.kots.announce(auth, tickets, REALTIME_EVENTS.kotCreated);
    this.notify(auth, id);
    await this.audit.record(auth, {
      action: 'order.cancelled', entityType: 'order', entityId: id, reason: input.reason,
      before: { number: displayNumber(order), totalPaise: order.totalPaise }, after: { approvedBy },
    });
    return this.get(auth, id);
  }

  /**
   * Deletes an order. With automatic renumbering, later orders in the same series move up so the
   * list has no gap.
   *
   * An order that was billed takes its bills, payments and refunds with it: they are erased, not
   * cancelled, and leave every list and report. That needs the `invoice.delete` permission, which only
   * the owner has by default, or the PIN of someone who holds it. The audit log keeps what was removed.
   */
  async remove(auth: AuthContext, id: string, input: z.output<typeof reasonSchema>): Promise<RenumberResult> {
    const order = await this.prisma.order.findFirst({
      where: { id, restaurantId: auth.restaurantId },
      include: { _count: { select: { invoices: true } }, items: { select: { name: true, quantity: true, totalPaise: true } } },
    });
    if (!order) throw notFound('Order');
    const billed = order._count.invoices > 0;
    const approvedBy = await this.approvals.resolve(auth, billed ? 'invoice.delete' : 'order.delete', input.approval);

    const outcome = await this.prisma.$transaction(async (tx) => {
      const ctx = await this.context.load(auth.restaurantId, tx);
      const closing = ctx.settings.orderRenumberMode === 'AUTO';
      // Locks are always taken in the same sequence, so that two changes can wait for each other but never block
      // each other for good: the order-number series, then orders, then bills, then bill-number series.
      await this.lockSeries(tx, auth.restaurantId, order.series, order.numberPeriod);
      // This order, the orders whose number will move up, and the orders whose bill number will move up.
      await lockForErase(tx, auth.restaurantId, id, {
        closeGaps: closing && billed,
        laterOrders: closing ? { series: order.series, numberPeriod: order.numberPeriod, after: order.orderNumber } : undefined,
      });
      // Checked again now that the order is held: it may have been billed or deleted a moment ago.
      const current = await tx.order.findFirst({ where: { id, restaurantId: auth.restaurantId }, include: { _count: { select: { invoices: true } } } });
      if (!current) throw notFound('Order');
      if (current._count.invoices > 0 !== billed) throw conflict('ORDER_CHANGED', 'This order was changed at the same moment. Look at it again before deleting it.');
      // With automatic renumbering the bills after this one move up too, so no bill number is missing either.
      const { erased, renumbered } = billed ? await eraseBills(tx, auth.restaurantId, id, { closeGaps: closing }) : { erased: [], renumbered: [] as RenumberedSeries[] };
      // Orders merged into this one were emptied by the merge; detach them rather than block the delete.
      await tx.order.updateMany({ where: { mergedIntoId: id }, data: { mergedIntoId: null } });
      await tx.order.delete({ where: { id } });
      if (order.tableId) await this.freeTable(tx, order.tableId);
      const changes = closing ? await this.closeGaps(tx, auth.restaurantId, order.series, order.numberPeriod) : [];
      // Written with the delete, so a bill is never erased or renumbered without its entry in the audit log.
      await this.audit.record(auth, {
        action: 'order.deleted', entityType: 'order', entityId: id, reason: input.reason,
        before: {
          number: displayNumber(current), businessDate: order.businessDate, type: order.type, status: current.status, totalPaise: current.totalPaise, items: order.items,
          ...(erased.length > 0 ? { bills: erased } : {}),
        },
        after: { approvedBy, renumbered: changes, ...(renumbered.length > 0 ? { billsRenumbered: renumbered } : {}) },
      }, tx);
      return { changes, bills: renumbered.reduce((sum, series) => sum + series.count, 0) };
    }, TX_OPTIONS);
    const { changes } = outcome;

    this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.orderDeleted, { orderId: id });
    // Its kitchen tickets went with it, so kitchen screens need to drop them.
    this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.kotUpdated, { orderId: id });
    if (changes.length > 0 || outcome.bills > 0) this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.ordersRenumbered);
    this.notify(auth, id);
    return outcome;
  }

  /**
   * Puts a billed or settled order back into editing, so it can be changed and billed again. Its bills,
   * payments and refunds are erased, as when a billed order is deleted, and the same permission applies.
   */
  async reopen(auth: AuthContext, id: string, input: z.output<typeof reasonSchema>): Promise<OrderDto> {
    const notBilled = () => conflict('ORDER_NOT_BILLED', 'Only a billed or settled order can be reopened. An order that is still open can be changed as it is.');
    const seen = await this.prisma.order.findFirst({ where: { id, restaurantId: auth.restaurantId } });
    if (!seen) throw notFound('Order');
    if (seen.status !== 'BILLED' && seen.status !== 'SETTLED') throw notBilled();
    const approvedBy = await this.approvals.resolve(auth, 'invoice.delete', input.approval);

    await this.prisma.$transaction(async (tx) => {
      const ctx = await this.context.load(auth.restaurantId, tx);
      const closing = ctx.settings.orderRenumberMode === 'AUTO';
      await lockForErase(tx, auth.restaurantId, id, { standingOnly: true, closeGaps: closing });
      // Checked again now that the order is held: someone may have reopened or changed it a moment ago.
      const order = await tx.order.findFirst({ where: { id, restaurantId: auth.restaurantId } });
      if (!order) throw notFound('Order');
      if (order.status !== 'BILLED' && order.status !== 'SETTLED') throw notBilled();
      const { erased, renumbered } = await eraseBills(tx, auth.restaurantId, id, { standingOnly: true, closeGaps: closing });
      // The table may have been given to other guests since; the order then comes back without one.
      let tableId = order.tableId;
      if (tableId) {
        const table = await tx.diningTable.findUnique({ where: { id: tableId } });
        const taken = await tx.order.count({ where: { tableId, id: { not: id }, status: { in: [...RUNNING] } } });
        if (!table || table.status === 'BLOCKED' || taken > 0) tableId = null;
        else await tx.diningTable.update({ where: { id: tableId }, data: { status: 'OCCUPIED' } });
      }
      await tx.order.update({ where: { id }, data: { status: 'OPEN', tableId, heldAt: null, version: { increment: 1 } } });
      await this.recalculate(tx, ctx, id);
      await this.audit.record(auth, {
        action: 'order.reopened', entityType: 'order', entityId: id, reason: input.reason,
        before: { number: displayNumber(order), status: order.status, totalPaise: order.totalPaise, bills: erased },
        after: { approvedBy, ...(renumbered.length > 0 ? { billsRenumbered: renumbered } : {}) },
      }, tx);
    }, TX_OPTIONS);

    this.notify(auth, id);
    return this.get(auth, id);
  }

  /**
   * The "Reset order numbers" button: closes every gap in the current period's order numbers, for all terminals.
   * For someone who may erase bills it also closes the gaps in bill and credit-note numbers.
   */
  async renumber(auth: AuthContext): Promise<RenumberResult> {
    const withBills = auth.permissions.has('invoice.delete');
    const outcome = await this.prisma.$transaction(async (tx) => {
      const ctx = await this.context.load(auth.restaurantId, tx);
      if (ctx.settings.orderRenumberMode === 'OFF') {
        throw invalid('RENUMBER_OFF', 'Order renumbering is switched off in billing settings.');
      }
      const series = await tx.order.findMany({
        where: { restaurantId: auth.restaurantId, numberPeriod: ctx.numberPeriod }, select: { series: true }, distinct: ['series'], orderBy: { series: 'asc' },
      });
      for (const { series: code } of series) await this.lockSeries(tx, auth.restaurantId, code, ctx.numberPeriod);
      // Every order that will be touched, in one statement and in id order: see lockForErase.
      const billed = withBills ? Prisma.sql`OR id IN (SELECT order_id FROM invoices WHERE restaurant_id = ${auth.restaurantId}::uuid)` : Prisma.empty;
      await tx.$queryRaw`
        SELECT id FROM orders WHERE restaurant_id = ${auth.restaurantId}::uuid AND (number_period = ${ctx.numberPeriod} ${billed}) ORDER BY id FOR UPDATE`;

      const changes: RenumberResult['changes'] = [];
      for (const { series: code } of series) changes.push(...(await this.closeGaps(tx, auth.restaurantId, code, ctx.numberPeriod)));
      const documents = withBills ? await tx.numberSeries.findMany({ where: { restaurantId: auth.restaurantId }, select: { id: true } }) : [];
      const renumbered = await compactSeries(tx, documents.map((row) => ({ seriesId: row.id, from: 1 })));
      await this.audit.record(auth, {
        action: 'order.renumbered', entityType: 'order', after: { changes, ...(renumbered.length > 0 ? { billsRenumbered: renumbered } : {}) },
      }, tx);
      return { changes, bills: renumbered.reduce((sum, entry) => sum + entry.count, 0) };
    }, TX_OPTIONS);
    if (outcome.changes.length > 0 || outcome.bills > 0) this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.ordersRenumbered);
    return outcome;
  }

  /** Starts order numbers again from 1. Earlier orders keep their numbers and stay in the history. */
  async restartNumbering(auth: AuthContext): Promise<void> {
    const settings = await this.prisma.restaurantSettings.update({
      where: { restaurantId: auth.restaurantId }, data: { orderNumberEpoch: { increment: 1 } },
    });
    await this.audit.record(auth, { action: 'order.numbering_restarted', entityType: 'settings', after: { epoch: settings.orderNumberEpoch } });
  }

  /** Moves every line of `source` onto this order. The source is kept, empty, marked as merged. */
  async merge(auth: AuthContext, id: string, input: z.output<typeof mergeOrderSchema>): Promise<OrderDto> {
    if (input.sourceOrderId === id) throw invalid('MERGE_SAME_ORDER', 'Choose a different order to merge in.');
    await Promise.all([this.findEditable(auth, id), this.findEditable(auth, input.sourceOrderId)]);
    if (!auth.permissions.has('order.transfer')) throw new DomainError('FORBIDDEN', 'You do not have permission to merge orders.', HttpStatus.FORBIDDEN);

    const { target, source } = await this.prisma.$transaction(async (tx) => {
      // Both orders are held, always in id order, so a bill on either waits for the merge (or the merge for the bill),
      // and two merges of the same pair in opposite directions run one after the other instead of emptying both.
      const locked = new Map<string, Awaited<ReturnType<OrdersService['lockEditable']>>>();
      for (const orderId of [id, input.sourceOrderId].sort()) locked.set(orderId, await this.lockEditable(tx, auth, orderId));
      const target = locked.get(id)!;
      const source = locked.get(input.sourceOrderId)!;
      const ctx = await this.context.load(auth.restaurantId, tx);
      const moved = await tx.orderItem.count({ where: { orderId: target.id } });
      const sourceItems = await tx.orderItem.findMany({ where: { orderId: source.id }, orderBy: { sortOrder: 'asc' } });
      for (const [index, item] of sourceItems.entries()) {
        await tx.orderItem.update({ where: { id: item.id }, data: { orderId: target.id, sortOrder: moved + index } });
      }
      // Line discounts travel with their lines; the source's bill-level discount does not carry over.
      await tx.discount.deleteMany({ where: { orderId: source.id, orderItemId: null } });
      await tx.discount.updateMany({ where: { orderId: source.id }, data: { orderId: target.id } });
      // Kitchen tickets follow the food to the order it is now on.
      await tx.kot.updateMany({ where: { orderId: source.id }, data: { orderId: target.id } });
      await tx.order.update({
        where: { id: source.id },
        data: {
          status: 'MERGED', mergedIntoId: target.id, subtotalPaise: 0, discountPaise: 0, taxPaise: 0, serviceChargePaise: 0,
          roundOffPaise: 0, totalPaise: 0, version: { increment: 1 },
        },
      });
      if (source.tableId) await this.freeTable(tx, source.tableId);
      await this.recalculate(tx, ctx, target.id);
      return { target, source };
    }, TX_OPTIONS);

    await this.audit.record(auth, {
      action: 'order.merged', entityType: 'order', entityId: id, after: { into: displayNumber(target), from: displayNumber(source) },
    });
    this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.kotUpdated, { orderId: id });
    this.notify(auth, id);
    this.notify(auth, source.id);
    return this.get(auth, id);
  }

  /** Moves a running dine-in order, bill and all, to another free table. */
  async transfer(auth: AuthContext, id: string, tableId: string): Promise<OrderDto> {
    const order = await this.prisma.order.findFirst({ where: { id, restaurantId: auth.restaurantId }, include: { table: true } });
    if (!order) throw notFound('Order');
    if (!RUNNING.includes(order.status as never) || order.type !== 'DINE_IN') {
      throw conflict('ORDER_NOT_AT_TABLE', 'Only a running dine-in order can be moved to another table.');
    }
    if (order.tableId === tableId) return this.get(auth, id);
    const to = await this.prisma.$transaction(async (tx) => {
      // Checked again with the order held: it may have been settled or moved a moment ago.
      await lockOrder(tx, auth.restaurantId, id);
      const current = await tx.order.findUniqueOrThrow({ where: { id } });
      if (!RUNNING.includes(current.status as never) || current.type !== 'DINE_IN') {
        throw conflict('ORDER_NOT_AT_TABLE', 'Only a running dine-in order can be moved to another table.');
      }
      await this.assertTableFree(tx, auth, tableId, id);
      await tx.order.update({ where: { id }, data: { tableId, version: { increment: 1 } } });
      const table = await tx.diningTable.update({ where: { id: tableId }, data: { status: current.status === 'BILLED' ? 'BILL_PRINTED' : 'OCCUPIED' } });
      if (current.tableId && current.tableId !== tableId) await this.freeTable(tx, current.tableId);
      return table;
    }, TX_OPTIONS);
    await this.audit.record(auth, {
      action: 'order.transferred', entityType: 'order', entityId: id, before: { table: order.table?.name ?? null }, after: { table: to.name },
    });
    // Kitchen screens show the table on each ticket.
    this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.kotUpdated, { orderId: id });
    this.notify(auth, id);
    return this.get(auth, id);
  }

  /** Recomputes and stores totals from the lines and discounts already in the database. */
  async recalculate(tx: Tx, ctx: BillingContext, orderId: string): Promise<void> {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId }, include: { items: { orderBy: { sortOrder: 'asc' }, include: { discounts: true } }, discounts: { where: { orderItemId: null } } },
    });
    const bill = computeBill({
      lines: order.items.map((item) => ({
        id: item.id, quantity: item.quantity, unitPricePaise: item.unitPricePaise, priceIncludesTax: item.priceIncludesTax,
        tax: item.taxGroupId ? (ctx.taxRates.get(item.taxGroupId) ?? null) : null,
        discount: item.discounts[0] ? { type: item.discounts[0].type, value: item.discounts[0].value } : null,
      })),
      discount: order.discounts[0] ? { type: order.discounts[0].type, value: order.discounts[0].value } : null,
      taxApplicable: ctx.taxApplicable,
      interState: false,
      serviceChargeBps: ctx.settings.serviceChargeEnabled ? ctx.settings.serviceChargeBps : 0,
      serviceChargeTax: ctx.defaultTax,
      roundOff: ctx.settings.roundOffMode,
    });
    for (const line of bill.lines) {
      await tx.orderItem.update({
        where: { id: line.id },
        data: { grossPaise: line.grossPaise, discountPaise: line.discountPaise, taxablePaise: line.taxablePaise, taxPaise: line.taxPaise, totalPaise: line.totalPaise },
      });
    }
    await tx.order.update({
      where: { id: orderId },
      data: {
        subtotalPaise: bill.grossPaise, discountPaise: bill.discountPaise, taxPaise: bill.taxPaise,
        serviceChargePaise: bill.serviceChargePaise, roundOffPaise: bill.roundOffPaise, totalPaise: bill.totalPaise, version: { increment: 1 },
      },
    });
  }

  // ── Internals ──

  private async findEditable(auth: AuthContext, id: string) {
    const order = await this.prisma.order.findFirst({ where: { id, restaurantId: auth.restaurantId }, include: { _count: { select: { items: true } } } });
    if (!order) throw notFound('Order');
    if (!EDITABLE.includes(order.status as never)) {
      throw conflict('ORDER_LOCKED', 'This order has been billed or closed and can no longer be changed.');
    }
    return order;
  }

  /**
   * Holds the order until the transaction ends, then checks it can still be changed. Billing, paying and refunding
   * take the same lock first, so a change and a bill on two terminals happen one after the other, and the second
   * sees what the first did: an order billed a moment ago is never put on hold, reopened, cancelled or merged.
   */
  private async lockEditable(tx: Tx, auth: AuthContext, id: string) {
    await lockOrder(tx, auth.restaurantId, id);
    const order = await tx.order.findFirst({ where: { id, restaurantId: auth.restaurantId }, include: { _count: { select: { items: true } } } });
    if (!order) throw notFound('Order');
    if (!EDITABLE.includes(order.status as never)) {
      throw conflict('ORDER_LOCKED', 'This order has been billed or closed and can no longer be changed.');
    }
    return order;
  }

  private async assertTableFree(tx: Tx, auth: AuthContext, tableId: string, orderId: string): Promise<void> {
    // Held until the transaction ends, so two terminals seating guests at the same table take turns, and the second
    // is told plainly that the table is taken. Always taken after the order's own lock.
    await tx.$queryRaw`SELECT id FROM dining_tables WHERE id = ${tableId}::uuid AND restaurant_id = ${auth.restaurantId}::uuid FOR UPDATE`;
    const table = await tx.diningTable.findFirst({ where: { id: tableId, restaurantId: auth.restaurantId, isActive: true } });
    if (!table) throw invalid('TABLE_NOT_FOUND', 'Choose a table.');
    if (table.status === 'BLOCKED') throw conflict('TABLE_BLOCKED', `Table ${table.name} is blocked.`);
    const taken = await tx.order.findFirst({ where: { tableId, status: { in: [...RUNNING] }, id: { not: orderId } } });
    if (taken) throw conflict('TABLE_OCCUPIED', `Table ${table.name} already has a running order.`);
  }

  /** Marks a table free unless another running order still sits at it. */
  async freeTable(tx: Tx, tableId: string): Promise<void> {
    const running = await tx.order.count({ where: { tableId, status: { in: [...RUNNING] } } });
    if (running === 0) await tx.diningTable.updateMany({ where: { id: tableId, status: { not: 'BLOCKED' } }, data: { status: 'FREE' } });
  }

  /** Serialises number allocation and renumbering for one series until the transaction ends. */
  private async lockSeries(tx: Tx, restaurantId: string, series: string, period: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`order-number:${restaurantId}:${series}:${period}`}, 0))`;
  }

  private async nextOrderNumber(tx: Tx, restaurantId: string, series: string, period: string): Promise<number> {
    await this.lockSeries(tx, restaurantId, series, period);
    const last = await tx.order.aggregate({ where: { restaurantId, series, numberPeriod: period }, _max: { orderNumber: true } });
    return (last._max.orderNumber ?? 0) + 1;
  }

  /**
   * Renumbers a series to 1, 2, 3… in its existing order. Numbers pass through negative values
   * so the unique constraint is never violated part-way. The caller holds the series lock.
   */
  private async closeGaps(tx: Tx, restaurantId: string, series: string, period: string): Promise<RenumberResult['changes']> {
    // A device's offline order numbers are given on the device, which may hold orders the server has not seen yet.
    if (await tx.terminal.count({ where: { restaurantId, code: series, kind: 'OFFLINE' } })) return [];
    const orders = await tx.order.findMany({
      where: { restaurantId, series, numberPeriod: period }, select: { id: true, orderNumber: true }, orderBy: { orderNumber: 'asc' },
    });
    const changes = orders.map((order, index) => ({ orderId: order.id, from: order.orderNumber, to: index + 1 })).filter((c) => c.from !== c.to);
    if (changes.length === 0) return [];
    const ids = changes.map((change) => change.orderId);
    await tx.order.updateMany({ where: { id: { in: ids } }, data: { orderNumber: { multiply: -1 } } });
    for (const change of changes) {
      await tx.order.update({ where: { id: change.orderId }, data: { orderNumber: change.to } });
    }
    return changes;
  }
}
