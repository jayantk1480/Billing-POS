import { Injectable, Logger } from '@nestjs/common';
import { type KotStatus as DbKotStatus, type Prisma, PrismaClient } from '@pos/database';
import { PAPER_COLUMNS, type PaperWidthKey, type PrintDocument, REALTIME_EVENTS } from '@pos/types';
import type { KotDto, KotLayout, kotQuerySchema, KotStatus, PrintJobDto, printRequestSchema } from '@pos/validation';
import type { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { conflict, forbidden, invalid, notFound } from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { renderKot } from '@pos/printing';
import { PrintQueueService } from '../printing/print-queue.service.js';
import { PrintingService } from '../printing/printing.service.js';
import { RealtimeService } from '../realtime/realtime.gateway.js';
import { asDate, type BillingContext, BillingContextService } from './billing-context.js';
import { lockOrder } from './erase.js';
import { displayNumber } from './mappers.js';

type Tx = Prisma.TransactionClient;
const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 };

const kotInclude = {
  items: true,
  station: { select: { name: true } },
  order: { select: { series: true, orderNumber: true, type: true, tokenNumber: true, table: { select: { name: true } } } },
} satisfies Prisma.KotInclude;
type KotRow = Prisma.KotGetPayload<{ include: typeof kotInclude }>;

/** An order line as the kitchen needs to see it. */
interface KitchenLine {
  orderItemId: string;
  stationId: string | null;
  name: string;
  quantity: number;
  notes: string | null;
}

type SendableItem = Prisma.OrderItemGetPayload<{ include: { modifiers: true } }>;

/** "Butter Chicken (Full)" with add-ons and the cashier's note underneath. */
export function kitchenLine(item: SendableItem, quantity: number): KitchenLine {
  const extras = [...item.modifiers.map((modifier) => modifier.name), item.notes].filter(Boolean).join(' · ');
  return {
    orderItemId: item.id,
    stationId: item.stationId,
    name: item.name + (item.variantName ? ' (' + item.variantName + ')' : ''),
    quantity,
    notes: extras || null,
  };
}

/**
 * Kitchen order tickets. Each "send to kitchen" creates one ticket per kitchen station holding only
 * what is new since the last send, so the kitchen never cooks the same thing twice.
 */
@Injectable()
export class KotsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly context: BillingContextService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
    private readonly printing: PrintingService,
    private readonly printQueue: PrintQueueService,
  ) {}

  private readonly logger = new Logger('Kots');

  // ── Sending ──

  async fire(auth: AuthContext, orderId: string): Promise<KotDto[]> {
    const ids = await this.prisma.$transaction(async (tx) => {
      // Held first, as billing does, so two sends (or a send and a bill) on different terminals take turns: the second
      // finds nothing new to send instead of sending the same food twice, and the two never deadlock on ticket numbers.
      await lockOrder(tx, auth.restaurantId, orderId);
      const order = await tx.order.findFirst({ where: { id: orderId, restaurantId: auth.restaurantId } });
      if (!order) throw notFound('Order');
      if (order.status !== 'OPEN' && order.status !== 'HELD') throw conflict('ORDER_LOCKED', 'This order has been billed or closed.');
      return this.fireInTx(tx, auth, await this.context.load(auth.restaurantId, tx), orderId);
    }, TX_OPTIONS);
    return this.announce(auth, ids, REALTIME_EVENTS.kotCreated);
  }

  /** Sends everything not yet sent. Runs inside the caller's transaction; call `announce` after it commits. */
  async fireInTx(tx: Tx, auth: AuthContext, ctx: BillingContext, orderId: string): Promise<string[]> {
    const items = await tx.orderItem.findMany({ where: { orderId, status: 'ACTIVE' }, include: { modifiers: true }, orderBy: { sortOrder: 'asc' } });
    const pending = items.filter((item) => item.quantity > item.kotQuantity);
    if (pending.length === 0) return [];
    const lines = pending.map((item) => kitchenLine(item, item.quantity - item.kotQuantity));
    // Items with no kitchen station (a bottle of water, say) need no ticket, but still count as dealt with.
    const ids = await this.createTickets(tx, auth, ctx, orderId, 'NEW', lines.filter((line) => line.stationId), null);
    for (const item of pending) await tx.orderItem.update({ where: { id: item.id }, data: { kotQuantity: item.quantity } });
    return ids;
  }

  /** Tells the kitchen to stop making something already sent. Runs inside the caller's transaction. */
  async cancelInTx(tx: Tx, auth: AuthContext, ctx: BillingContext, orderId: string, lines: KitchenLine[], reason: string): Promise<string[]> {
    const sent = lines.filter((line) => line.stationId);
    // The cancellation ticket tells the cook; this takes the quantity off the tickets themselves, newest first,
    // so they stop counting as work to do. A ticket with nothing left on it is finished.
    const touched = new Set<string>();
    for (const line of sent) {
      let remaining = line.quantity;
      const entries = await tx.kotItem.findMany({
        where: { orderItemId: line.orderItemId, kot: { orderId, type: 'NEW' } }, include: { kot: { select: { createdAt: true } } },
      });
      entries.sort((a, b) => b.kot.createdAt.getTime() - a.kot.createdAt.getTime());
      for (const entry of entries) {
        const take = Math.min(remaining, entry.quantity - entry.cancelledQuantity);
        if (take <= 0) continue;
        await tx.kotItem.update({ where: { id: entry.id }, data: { cancelledQuantity: { increment: take } } });
        touched.add(entry.kotId);
        remaining -= take;
        if (remaining === 0) break;
      }
    }
    for (const kotId of touched) {
      const items = await tx.kotItem.findMany({ where: { kotId } });
      if (items.every((item) => item.cancelledQuantity >= item.quantity)) {
        await tx.kot.updateMany({ where: { id: kotId, status: { in: ['PENDING', 'PREPARING', 'READY'] } }, data: { status: 'COMPLETED', completedAt: new Date() } });
      }
    }
    return this.createTickets(tx, auth, ctx, orderId, 'CANCEL', sent, reason);
  }

  private async createTickets(
    tx: Tx, auth: AuthContext, ctx: BillingContext, orderId: string, type: 'NEW' | 'CANCEL', lines: KitchenLine[], notes: string | null,
  ): Promise<string[]> {
    if (lines.length === 0) return [];
    const businessDate = asDate(ctx.businessDate);
    // Ticket numbers restart each business day and are handed out one at a time.
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${'kot-number:' + auth.restaurantId + ':' + ctx.businessDate}, 0))`;
    const last = await tx.kot.aggregate({ where: { restaurantId: auth.restaurantId, businessDate }, _max: { kotNumber: true } });
    let number = last._max.kotNumber ?? 0;

    const ids: string[] = [];
    for (const stationId of [...new Set(lines.map((line) => line.stationId))]) {
      number += 1;
      const kot = await tx.kot.create({
        data: {
          restaurantId: auth.restaurantId, orderId, stationId, kotNumber: number, businessDate, type, notes, createdById: auth.userId,
          items: {
            create: lines.filter((line) => line.stationId === stationId)
              .map((line) => ({ orderItemId: line.orderItemId, name: line.name, quantity: line.quantity, notes: line.notes })),
          },
        },
      });
      ids.push(kot.id);
    }
    return ids;
  }

  /** Loads the tickets and tells kitchen screens about them. Call after the transaction has committed. */
  async announce(auth: AuthContext, ids: string[], event: typeof REALTIME_EVENTS.kotCreated | typeof REALTIME_EVENTS.kotUpdated): Promise<KotDto[]> {
    if (ids.length === 0) return [];
    let kots = await this.load({ id: { in: ids } });
    if (event === REALTIME_EVENTS.kotCreated) kots = await this.printNew(auth, kots);
    for (const kot of kots) this.realtime.emit(auth.restaurantId, event, { kotId: kot.id, stationId: kot.stationId, orderId: kot.orderId });
    return kots;
  }

  /**
   * Sends new tickets to their station printers when the restaurant prints tickets automatically. A ticket that went
   * to a printer comes back counted as printed, which tells the billing screen not to print it through the browser too.
   * Printing never fails the order: a ticket that could not be queued is still on the kitchen display.
   */
  private async printNew(auth: AuthContext, kots: KotDto[]): Promise<KotDto[]> {
    try {
      const ctx = await this.context.load(auth.restaurantId);
      if (!ctx.settings.autoPrintKot) return kots;
      const layouts = await this.printing.layouts(auth.restaurantId);
      const printed: KotDto[] = [];
      for (const kot of kots) {
        const job = await this.printQueue.queue(auth.restaurantId, this.printRequest(auth, kot, layouts.kot, ctx.settings.timezone, undefined), { quiet: true });
        if (job) await this.prisma.kot.update({ where: { id: kot.id }, data: { printCount: { increment: 1 } } });
        printed.push(job ? { ...kot, printCount: kot.printCount + 1 } : kot);
      }
      return printed;
    } catch (error) {
      this.logger.warn('Could not queue kitchen tickets for printing: ' + (error instanceof Error ? error.message : String(error)));
      return kots;
    }
  }

  private printRequest(auth: AuthContext, kot: KotDto, layout: KotLayout, timeZone: string, printerId: string | undefined) {
    return {
      type: 'KOT' as const, role: 'KOT' as const, refType: 'kot', refId: kot.id, stationId: kot.stationId, printerId, isReprint: kot.printCount > 0, requestedById: auth.userId,
      title: (kot.type === 'CANCEL' ? 'Cancel ticket ' : 'Kitchen ticket ') + kot.kotNumber + (kot.stationName ? ' for ' + kot.stationName : ''),
      render: (columns: number) => renderKot(kot, layout, columns, timeZone),
    };
  }

  /** Sends a ticket to its station printer again. */
  async print(auth: AuthContext, id: string, input: z.output<typeof printRequestSchema>): Promise<PrintJobDto> {
    const [kot] = await this.load({ id, restaurantId: auth.restaurantId });
    if (!kot) throw notFound('Kitchen ticket');
    const [layouts, ctx] = await Promise.all([this.printing.layouts(auth.restaurantId), this.context.load(auth.restaurantId)]);
    const job = await this.printQueue.queue(auth.restaurantId, this.printRequest(auth, kot, layouts.kot, ctx.settings.timezone, input.printerId));
    await this.markPrinted(auth, id);
    return job!;
  }

  /** The ticket laid out as lines of text, for a printer connected to the asking device (WebUSB or Web Serial). */
  async printDocument(auth: AuthContext, id: string, width: PaperWidthKey): Promise<PrintDocument> {
    const [kot] = await this.load({ id, restaurantId: auth.restaurantId });
    if (!kot) throw notFound('Kitchen ticket');
    const [layouts, ctx] = await Promise.all([this.printing.layouts(auth.restaurantId), this.context.load(auth.restaurantId)]);
    return renderKot(kot, layouts.kot, PAPER_COLUMNS[width], ctx.settings.timezone);
  }

  // ── Kitchen display ──

  async list(auth: AuthContext, query: z.output<typeof kotQuerySchema>): Promise<KotDto[]> {
    if (!auth.permissions.has('kot.update_status') && !auth.permissions.has('kot.fire')) {
      throw forbidden('You do not have permission to see kitchen tickets.');
    }
    const { businessDate } = await this.context.load(auth.restaurantId);
    const active: DbKotStatus[] = ['PENDING', 'PREPARING', 'READY'];
    return this.load({
      restaurantId: auth.restaurantId,
      stationId: query.stationId,
      orderId: query.orderId,
      // Unfinished tickets stay on the board even after the business day rolls over.
      ...(query.scope === 'active' ? { status: { in: active } } : query.orderId ? {} : { businessDate: asDate(businessDate) }),
    });
  }

  async setStatus(auth: AuthContext, id: string, status: KotStatus): Promise<KotDto> {
    const kot = await this.prisma.kot.findFirst({ where: { id, restaurantId: auth.restaurantId } });
    if (!kot) throw notFound('Kitchen ticket');
    // A cancel ticket is only ever acknowledged; there is nothing to prepare.
    if (kot.type === 'CANCEL' && status !== 'COMPLETED') throw invalid('KOT_IS_CANCELLATION', 'A cancellation ticket can only be marked as done.');
    const now = new Date();
    await this.prisma.kot.update({
      where: { id },
      data: {
        status,
        preparingAt: status === 'PENDING' ? null : (kot.preparingAt ?? now),
        readyAt: status === 'READY' || status === 'COMPLETED' ? (kot.readyAt ?? now) : null,
        completedAt: status === 'COMPLETED' ? now : null,
      },
    });
    const [updated] = await this.announce(auth, [id], REALTIME_EVENTS.kotUpdated);
    return updated!;
  }

  /** Counts a print of the ticket; anything after the first is a reprint and is audited. */
  async markPrinted(auth: AuthContext, id: string): Promise<KotDto> {
    const kot = await this.prisma.kot.findFirst({ where: { id, restaurantId: auth.restaurantId } });
    if (!kot) throw notFound('Kitchen ticket');
    const updated = await this.prisma.kot.update({ where: { id }, data: { printCount: { increment: 1 } } });
    if (updated.printCount > 1) {
      await this.audit.record(auth, { action: 'kot.reprinted', entityType: 'kot', entityId: id, after: { kotNumber: kot.kotNumber, printCount: updated.printCount } });
    }
    return (await this.load({ id }))[0]!;
  }

  private async load(where: Prisma.KotWhereInput): Promise<KotDto[]> {
    // At most the newest 500, shown oldest first: on a very busy day the board must not drop the tickets that just came in.
    const rows = (await this.prisma.kot.findMany({ where, include: kotInclude, orderBy: [{ createdAt: 'desc' }, { kotNumber: 'desc' }], take: 500 })).reverse();
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.createdById))] } }, select: { id: true, name: true } });
    const names = new Map(users.map((user) => [user.id, user.name]));
    return rows.map((row) => this.toDto(row, names.get(row.createdById) ?? 'Unknown'));
  }

  private toDto(kot: KotRow, createdByName: string): KotDto {
    return {
      id: kot.id, kotNumber: kot.kotNumber, offlineNumber: kot.offlineNumber, type: kot.type, status: kot.status, stationId: kot.stationId, stationName: kot.station?.name ?? null,
      orderId: kot.orderId, orderDisplayNumber: displayNumber(kot.order), orderType: kot.order.type, tableName: kot.order.table?.name ?? null,
      tokenNumber: kot.order.tokenNumber, notes: kot.notes,
      items: kot.items.map((item) => ({ id: item.id, name: item.name, quantity: item.quantity, cancelledQuantity: item.cancelledQuantity, notes: item.notes })),
      printCount: kot.printCount, createdByName, createdAt: kot.createdAt.toISOString(),
      preparingAt: kot.preparingAt?.toISOString() ?? null, readyAt: kot.readyAt?.toISOString() ?? null, completedAt: kot.completedAt?.toISOString() ?? null,
    };
  }
}
