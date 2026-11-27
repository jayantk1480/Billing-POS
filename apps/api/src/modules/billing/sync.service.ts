import { Injectable, Logger } from '@nestjs/common';
import {
  type BillLineInput, businessDateOf, computeBill, discountAmount, discountBps, financialYearOf, formatDocumentNumber, formatINR, orderNumberPeriod,
} from '@pos/billing-core';
import { Prisma, PrismaClient } from '@pos/database';
import { type PermissionKey, REALTIME_EVENTS } from '@pos/types';
import {
  type checkSyncReviewSchema, type DeviceNumbersDto, type Page, type SyncFlagDto, syncOperationSchema, type SyncPushResponse, type syncPushSchema,
  type SyncResultDto, type SyncReviewDto, type syncReviewQuerySchema,
} from '@pos/validation';
import type { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { PermissionCacheService } from '../../common/auth/permission-cache.service.js';
import { conflict, notFound } from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { RealtimeService } from '../realtime/realtime.gateway.js';
import { stillOpen } from '../registers/register-link.js';
import { asDate, type BillingContext, BillingContextService } from './billing-context.js';
import { saveCustomerRecord } from './customer-record.js';
import { deviceNumbers } from './devices.service.js';
import { lockOrder } from './erase.js';
import { displayNumber } from './mappers.js';
import { OrdersService } from './orders.service.js';

type Tx = Prisma.TransactionClient;
type Operation = z.output<typeof syncOperationSchema>;
type Device = Prisma.PosDeviceGetPayload<{ include: { offlineTerminal: true } }>;

/** The operation needs something that has not arrived yet: the device sends it again later. */
class Waiting extends Error {}
/** The operation can never be applied. It is kept, with the reason, for the owner to look at. */
class Refused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** What applying an operation touched. */
interface Applied {
  entityId: string;
  orderId: string | null;
  result: Record<string, unknown>;
  audit: { action: string; entityType: string; entityId: string; after: Record<string, unknown> };
}

/** Everything an operation is applied with. */
interface Job {
  tx: Tx;
  restaurantId: string;
  device: Device;
  op: Operation;
  ctx: BillingContext;
  permissions: PermissionKey[];
  flag: (code: string, message: string) => void;
}

const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 };
const DAY_MS = 86_400_000;
/** Further ahead of the server than this, the device's clock was wrong. */
const CLOCK_TOLERANCE_MS = 5 * 60_000;
/** Work older than this when it arrives is pointed out: the device stayed offline for a long time. */
const LATE_AFTER_DAYS = 5;
const PERMISSION_FOR: Record<Operation['type'], { key: PermissionKey; doing: string }> = {
  'order.save': { key: 'order.create', doing: 'take orders' },
  'kot.print': { key: 'kot.fire', doing: 'send orders to the kitchen' },
  'invoice.issue': { key: 'invoice.create', doing: 'make bills' },
  'payment.record': { key: 'payment.record', doing: 'take payments' },
};
const METHOD_NAME: Record<string, string> = { CASH: 'cash', UPI: 'UPI', CARD: 'card', OTHER: 'other' };

/** The entity an operation is about, and the order it belongs to (unknown for a payment until its bill is found). */
function subjectOf(op: Operation): { entityId: string; orderId: string | null } {
  switch (op.type) {
    case 'order.save': return { entityId: op.order.id, orderId: op.order.id };
    case 'kot.print': return { entityId: op.kot.id, orderId: op.kot.orderId };
    case 'invoice.issue': return { entityId: op.invoice.id, orderId: op.invoice.orderId };
    case 'payment.record': return { entityId: op.payment.id, orderId: null };
  }
}

function businessDateOfOperation(op: Operation): string {
  switch (op.type) {
    case 'order.save': return op.order.businessDate;
    case 'kot.print': return op.kot.businessDate;
    case 'invoice.issue': return op.invoice.businessDate;
    case 'payment.record': return op.payment.businessDate;
  }
}

const flagsOf = (value: Prisma.JsonValue | null): SyncFlagDto[] => (Array.isArray(value) ? (value as unknown as SyncFlagDto[]) : []);

/**
 * Takes in the work devices did while the internet was down: orders, kitchen tickets, bills and payments, each
 * applied exactly once and in the order the device did them. Bills are stored as they were printed, under the
 * device's own series; the guest already holds them, so they are never refused for not adding up. Whatever looks
 * wrong (a total that does not work out, a number used twice or skipped, a discount over the limit, a clock that was
 * off, cash for a register already closed) is stored with a flag, and the back office lists it until someone checks it.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly context: BillingContextService,
    private readonly orders: OrdersService,
    private readonly permissionCache: PermissionCacheService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
  ) {}

  // ── Uploading ──

  async push(auth: AuthContext, input: z.output<typeof syncPushSchema>): Promise<SyncPushResponse> {
    const device = await this.prisma.posDevice.findUnique({
      where: { restaurantId_deviceKey: { restaurantId: auth.restaurantId, deviceKey: input.deviceKey } }, include: { offlineTerminal: true },
    });
    if (!device) throw conflict('DEVICE_NOT_REGISTERED', 'This device has not been registered with the restaurant. Open the billing screen once while online.');
    if (device.revokedAt) throw conflict('DEVICE_REVOKED', 'This device was removed from the restaurant. Ask the owner to add it again.');

    const results: SyncResultDto[] = [];
    const touched = { orders: new Set<string>(), invoices: new Map<string, string>(), kots: false };
    for (const raw of input.operations) {
      // Operations depend on those before them (a bill on its order), so after one that has to wait, the rest wait too.
      if (results.some((result) => result.outcome === 'DEFERRED')) {
        results.push({ id: raw.id, outcome: 'DEFERRED', code: 'WAITING', message: 'Waits for an earlier operation.', flags: [] });
        continue;
      }
      results.push(await this.applyOne(auth, device, raw, touched));
    }

    const waiting = results.filter((result) => result.outcome === 'DEFERRED').length;
    await this.prisma.posDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date(), lastSyncAt: new Date(), pendingCount: input.pending + waiting } });
    for (const orderId of touched.orders) this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.orderUpdated, { orderId });
    for (const [invoiceId, orderId] of touched.invoices) this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.invoiceUpdated, { invoiceId, orderId });
    if (touched.orders.size > 0) this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.tableUpdated);
    if (touched.kots) this.realtime.emit(auth.restaurantId, REALTIME_EVENTS.kotUpdated, {});
    return { results, numbers: await this.numbers(device) };
  }

  /** Where the device's own series stand now. */
  numbers(device: Device): Promise<DeviceNumbersDto> {
    return deviceNumbers(this.prisma, this.context, device);
  }

  private async applyOne(
    auth: AuthContext, device: Device, raw: { id: string } & Record<string, unknown>,
    touched: { orders: Set<string>; invoices: Map<string, string>; kots: boolean },
  ): Promise<SyncResultDto> {
    const parsed = syncOperationSchema.safeParse(raw);
    try {
      const done = await this.prisma.$transaction(async (tx) => {
        // One operation of a device at a time: two tabs uploading at once take turns, and the second finds the first's work.
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${'sync-device:' + device.id}, 0))`;
        const seen = await tx.syncOperation.findUnique({ where: { id: raw.id } });
        if (seen) {
          if (seen.restaurantId !== auth.restaurantId) throw new Refused('OPERATION_ID_TAKEN', 'This operation id is already used elsewhere.');
          return { result: { id: raw.id, outcome: 'DUPLICATE', code: seen.status === 'REJECTED' ? 'REJECTED_BEFORE' : null, message: seen.error, flags: flagsOf(seen.flags) } satisfies SyncResultDto };
        }
        if (!parsed.success) {
          const first = parsed.error.issues[0];
          throw new Refused('INVALID_OPERATION', `The device sent something the server cannot read${first ? ` (${first.path.join('.') || 'operation'}: ${first.message})` : ''}.`);
        }
        const op = parsed.data;
        const user = await tx.user.findFirst({ where: { id: op.userId, restaurantId: auth.restaurantId }, select: { id: true, name: true, roleId: true } });
        if (!user) throw new Refused('UNKNOWN_USER', 'The person who did this is not one of this restaurant\'s users.');

        const flags: SyncFlagDto[] = [];
        const job: Job = {
          tx, restaurantId: auth.restaurantId, device, op, ctx: await this.context.load(auth.restaurantId, tx),
          permissions: await this.permissionCache.rolePermissions(user.roleId), flag: (code, message) => flags.push({ code, message }),
        };
        this.checkClock(job);
        const needed = PERMISSION_FOR[op.type];
        if (!job.permissions.includes(needed.key)) job.flag('NOT_ALLOWED', `${user.name} is not allowed to ${needed.doing}, but did so on the device while it was offline.`);

        const applied = op.type === 'order.save' ? await this.applyOrder(job)
          : op.type === 'kot.print' ? await this.applyKot(job)
          : op.type === 'invoice.issue' ? await this.applyInvoice(job)
          : await this.applyPayment(job);

        await tx.syncOperation.create({
          data: {
            id: op.id, restaurantId: auth.restaurantId, terminalId: device.offlineTerminalId, deviceId: device.id, userId: op.userId, uploadedById: auth.userId,
            type: op.type, entityId: applied.entityId, orderId: applied.orderId, payload: op as unknown as Prisma.InputJsonValue, status: 'APPLIED',
            result: applied.result as Prisma.InputJsonValue, flags: flags.length > 0 ? (flags as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            clientCreatedAt: new Date(op.createdAt),
          },
        });
        await this.audit.record(
          { restaurantId: auth.restaurantId, userId: op.userId, terminalId: device.offlineTerminalId, ip: auth.ip },
          { ...applied.audit, after: { ...applied.audit.after, offline: true, device: device.offlineTerminal.code, uploadedBy: auth.userId, flags: flags.map((f) => f.code) } },
          tx,
        );
        return { result: { id: op.id, outcome: 'APPLIED', code: null, message: null, flags } satisfies SyncResultDto, applied };
      }, TX_OPTIONS);

      if ('applied' in done && done.applied) {
        if (done.applied.orderId) touched.orders.add(done.applied.orderId);
        if (parsed.success && parsed.data.type === 'invoice.issue') touched.invoices.set(parsed.data.invoice.id, parsed.data.invoice.orderId);
        if (parsed.success && parsed.data.type === 'payment.record' && done.applied.orderId) touched.invoices.set(parsed.data.payment.invoiceId, done.applied.orderId);
        if (parsed.success && parsed.data.type === 'kot.print') touched.kots = true;
      }
      return done.result;
    } catch (error) {
      if (error instanceof Waiting) return { id: raw.id, outcome: 'DEFERRED', code: 'WAITING', message: error.message, flags: [] };
      if (error instanceof Refused) return this.refuse(auth, device, raw, parsed.success ? parsed.data : null, error);
      // Anything else is the server's trouble, not the operation's: the device sends it again later.
      this.logger.error(`Operation ${raw.id} from device ${device.id} could not be applied: ${error instanceof Error ? error.stack : String(error)}`);
      return { id: raw.id, outcome: 'DEFERRED', code: 'SERVER_ERROR', message: 'The server could not take this just now. It will be sent again.', flags: [] };
    }
  }

  /** Keeps an operation that can never be applied, with the reason, for the owner. Nothing it asked for was written. */
  private async refuse(auth: AuthContext, device: Device, raw: { id: string } & Record<string, unknown>, op: Operation | null, error: Refused): Promise<SyncResultDto> {
    const result: SyncResultDto = { id: raw.id, outcome: 'REJECTED', code: error.code, message: error.message, flags: [] };
    // Another restaurant's operation: nothing of it is stored here.
    if (error.code === 'OPERATION_ID_TAKEN') return result;
    const subject = op ? subjectOf(op) : null;
    const at = typeof raw.createdAt === 'string' ? new Date(raw.createdAt) : new Date(Number.NaN);
    try {
      await this.prisma.syncOperation.create({
        data: {
          id: raw.id, restaurantId: auth.restaurantId, terminalId: device.offlineTerminalId, deviceId: device.id,
          userId: op?.userId ?? null, uploadedById: auth.userId, type: op?.type ?? String(raw.type ?? 'unknown').slice(0, 40),
          entityId: subject?.entityId ?? null, orderId: subject?.orderId ?? null, payload: raw as Prisma.InputJsonValue,
          status: 'REJECTED', error: error.message, clientCreatedAt: Number.isNaN(at.getTime()) ? new Date() : at,
        },
      });
    } catch (stored) {
      // The same operation refused at the same moment by a second upload: it is stored once.
      if (!(stored instanceof Prisma.PrismaClientKnownRequestError && stored.code === 'P2002')) throw stored;
    }
    await this.audit.record(auth, {
      action: 'sync.rejected', entityType: 'sync_operation', entityId: raw.id, reason: error.message, after: { code: error.code, device: device.offlineTerminal.code },
    });
    return result;
  }

  /** Waits for what an operation needs, unless that was itself refused: then this one can never apply either. */
  private async waitFor(tx: Tx, restaurantId: string, entityId: string, what: string): Promise<never> {
    const refused = await tx.syncOperation.findFirst({ where: { restaurantId, entityId, status: 'REJECTED' }, select: { id: true } });
    if (refused) throw new Refused('DEPENDS_ON_REJECTED', `${what[0]!.toUpperCase()}${what.slice(1)} it belongs to could not be stored, so neither can this.`);
    throw new Waiting(`Waits for ${what} to arrive.`);
  }

  /** A device clock that was wrong shows in the dates on its bills. */
  private checkClock({ op, ctx, flag }: Job): void {
    const at = Date.parse(op.createdAt);
    const now = Date.now();
    if (at - now > CLOCK_TOLERANCE_MS) flag('CLOCK_AHEAD', `The device's clock was ${Math.round((at - now) / 60_000)} minutes ahead of the server's.`);
    if (now - at > LATE_AFTER_DAYS * DAY_MS) flag('LATE_UPLOAD', `Made ${Math.floor((now - at) / DAY_MS)} days before it reached the server.`);
    const dated = businessDateOfOperation(op);
    const expected = businessDateOf(new Date(at), ctx.settings.timezone, ctx.settings.dayCutoffMinutes);
    if (dated !== expected) flag('BUSINESS_DATE', `Dated ${dated}, but made on ${expected} by the device's clock.`);
  }

  // ── Orders ──

  /** An order started on the device, as it now stands. Its lines keep the prices and taxes the device charged. */
  private async applyOrder(job: Job): Promise<Applied> {
    const { tx, restaurantId, device, op, ctx, flag } = job;
    if (op.type !== 'order.save') throw new Error('not an order');
    const o = op.order;
    const code = device.offlineTerminal.code;
    await lockOrder(tx, restaurantId, o.id);
    const existing = await tx.order.findUnique({ where: { id: o.id } });
    if (existing && existing.restaurantId !== restaurantId) throw new Refused('ORDER_ID_TAKEN', 'An order with this id already exists elsewhere.');
    if (existing && existing.terminalId !== device.offlineTerminalId) {
      throw new Refused('ORDER_NOT_OFFLINE', `Order ${displayNumber(existing)} was not started on this device offline, so it can only be changed online.`);
    }
    if (existing && existing.status !== 'OPEN' && existing.status !== 'HELD') {
      throw new Refused('ORDER_CLOSED', `Order ${displayNumber(existing)} was already billed or closed when this change arrived.`);
    }
    if (existing) {
      const last = await tx.syncOperation.findFirst({ where: { restaurantId, entityId: o.id, status: 'APPLIED' }, orderBy: { appliedAt: 'desc' }, select: { appliedAt: true } });
      if (last && existing.updatedAt.getTime() > last.appliedAt.getTime() + 1000) {
        flag('CHANGED_ONLINE', `Order ${displayNumber(existing)} was changed on another till after it was uploaded; this device's version replaced those changes.`);
      }
    }

    await this.checkMenu(job);
    this.checkDiscounts(job);

    const stationIds = new Set((await tx.kitchenStation.findMany({ where: { restaurantId }, select: { id: true } })).map((station) => station.id));
    const customerId = o.customer ? await saveCustomerRecord(tx, restaurantId, o.customer) : null;
    const details = {
      type: o.type, customerId, guests: o.guests, notes: o.notes ?? null, deliveryAddress: o.type === 'DELIVERY' ? (o.deliveryAddress ?? null) : null,
    };

    let orderNumber = existing?.orderNumber ?? o.orderNumber;
    if (!existing) {
      const period = orderNumberPeriod(ctx.settings.orderNumberReset, o.businessDate, financialYearOf(o.businessDate));
      const numberPeriod = ctx.settings.orderNumberEpoch > 0 ? `${period}#${ctx.settings.orderNumberEpoch}` : period;
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`order-number:${restaurantId}:${code}:${numberPeriod}`}, 0))`;
      if (await tx.order.count({ where: { restaurantId, series: code, numberPeriod, orderNumber } })) {
        const last = await tx.order.aggregate({ where: { restaurantId, series: code, numberPeriod }, _max: { orderNumber: true } });
        orderNumber = (last._max.orderNumber ?? 0) + 1;
        flag('ORDER_NUMBER_TAKEN', `Printed as order ${code}-${o.orderNumber}, a number already used, so it is order ${code}-${orderNumber} here.`);
      }
      await tx.order.create({
        data: {
          id: o.id, restaurantId, terminalId: device.offlineTerminalId, series: code, numberPeriod, orderNumber, tokenNumber: orderNumber,
          businessDate: asDate(o.businessDate), createdById: op.userId, createdAt: new Date(op.createdAt), ...details,
        },
      });
    } else {
      await tx.order.update({ where: { id: o.id }, data: details });
    }

    // The lines, replaced as a whole.
    const lineIds = o.items.map((item) => item.id);
    if (await tx.orderItem.count({ where: { id: { in: lineIds }, orderId: { not: o.id } } })) {
      throw new Refused('LINE_ID_TAKEN', 'A line of this order has the id of a line on another order.');
    }
    await tx.orderItem.deleteMany({ where: { orderId: o.id, id: { notIn: lineIds } } });
    for (const [sortOrder, item] of o.items.entries()) {
      const taxGroupId = item.taxGroupId && ctx.taxRates.has(item.taxGroupId) ? item.taxGroupId : null;
      const data = {
        productId: item.productId, variantId: item.variantId, stationId: item.stationId && stationIds.has(item.stationId) ? item.stationId : null,
        name: item.name, variantName: item.variantName, hsnSac: item.hsnSac, taxGroupId, priceIncludesTax: item.priceIncludesTax,
        quantity: item.quantity, kotQuantity: Math.min(item.kotQuantity, item.quantity), unitPricePaise: item.unitPricePaise, notes: item.notes ?? null, sortOrder,
      };
      await tx.orderItemModifier.deleteMany({ where: { orderItemId: item.id } });
      const modifiers = { create: item.modifiers.map((m) => ({ modifierId: m.modifierId, name: m.name, pricePaise: m.pricePaise })) };
      await tx.orderItem.upsert({ where: { id: item.id }, create: { id: item.id, orderId: o.id, ...data, modifiers }, update: { ...data, modifiers } });
    }

    // Totals worked out from the lines with the rates the device charged, as the device showed them.
    const lines = o.items.map((item): BillLineInput => ({
      id: item.id, quantity: item.quantity, unitPricePaise: item.unitPricePaise, priceIncludesTax: item.priceIncludesTax,
      tax: { gstRateBps: item.gstRateBps, cessRateBps: item.cessRateBps }, discount: item.discount,
    }));
    const bill = computeBill({
      lines, discount: o.discount, taxApplicable: ctx.taxApplicable, interState: false,
      serviceChargeBps: ctx.settings.serviceChargeEnabled ? ctx.settings.serviceChargeBps : 0, serviceChargeTax: ctx.defaultTax, roundOff: ctx.settings.roundOffMode,
    });
    for (const line of bill.lines) {
      await tx.orderItem.update({
        where: { id: line.id },
        data: { grossPaise: line.grossPaise, discountPaise: line.discountPaise, taxablePaise: line.taxablePaise, taxPaise: line.taxPaise, totalPaise: line.totalPaise },
      });
    }
    const net = lines.reduce((sum, line) => sum + line.quantity * line.unitPricePaise - discountAmount(line.quantity * line.unitPricePaise, line.discount), 0);
    await tx.discount.deleteMany({ where: { orderId: o.id } });
    const discounts = [
      ...o.items.flatMap((item) => (item.discount ? [{ orderItemId: item.id as string | null, input: item.discount, base: item.quantity * item.unitPricePaise }] : [])),
      ...(o.discount ? [{ orderItemId: null, input: o.discount, base: net }] : []),
    ];
    if (discounts.length > 0) {
      await tx.discount.createMany({
        data: discounts.map((d) => ({
          restaurantId, orderId: o.id, orderItemId: d.orderItemId, type: d.input.type, value: d.input.value, amountPaise: discountAmount(d.base, d.input),
          reason: d.input.reason ?? null, appliedById: op.userId, approvedById: null,
        })),
      });
    }
    await tx.order.update({
      where: { id: o.id },
      data: {
        subtotalPaise: bill.grossPaise, discountPaise: bill.discountPaise, taxPaise: bill.taxPaise, serviceChargePaise: bill.serviceChargePaise,
        roundOffPaise: bill.roundOffPaise, totalPaise: bill.totalPaise, version: { increment: 1 },
      },
    });
    const number = `${code}-${orderNumber}`;
    return {
      entityId: o.id, orderId: o.id, result: { orderId: o.id, displayNumber: number },
      audit: { action: existing ? 'order.updated' : 'order.created', entityType: 'order', entityId: o.id, after: { number, type: o.type, items: o.items.length, totalPaise: bill.totalPaise } },
    };
  }

  /** Every item, variant and option must be this restaurant's. A price unlike the menu's now is pointed out. */
  private async checkMenu({ tx, restaurantId, op, flag }: Job): Promise<void> {
    if (op.type !== 'order.save') return;
    const items = op.order.items;
    const products = new Map((await tx.product.findMany({
      where: { id: { in: [...new Set(items.map((item) => item.productId))] }, restaurantId }, include: { variants: true },
    })).map((product) => [product.id, product]));
    const modifiers = new Map((await tx.modifier.findMany({
      where: { id: { in: [...new Set(items.flatMap((item) => item.modifiers.map((m) => m.modifierId)))] }, group: { restaurantId } },
    })).map((modifier) => [modifier.id, modifier]));
    const differences: string[] = [];
    for (const item of items) {
      const product = products.get(item.productId);
      if (!product) throw new Refused('UNKNOWN_ITEM', `"${item.name}" is not on this restaurant's menu.`);
      const variant = item.variantId ? product.variants.find((candidate) => candidate.id === item.variantId) : null;
      if (item.variantId && !variant) throw new Refused('UNKNOWN_ITEM', `The ${item.variantName ?? 'size'} of "${item.name}" is not on this restaurant's menu.`);
      for (const choice of item.modifiers) {
        if (!modifiers.has(choice.modifierId)) throw new Refused('UNKNOWN_ITEM', `The option "${choice.name}" on "${item.name}" is not on this restaurant's menu.`);
      }
      const menuPrice = (variant?.pricePaise ?? product.basePricePaise) + item.modifiers.reduce((sum, choice) => sum + modifiers.get(choice.modifierId)!.pricePaise, 0);
      if (menuPrice !== item.unitPricePaise) differences.push(`${item.name} at ${formatINR(item.unitPricePaise)} (the menu says ${formatINR(menuPrice)})`);
    }
    if (differences.length > 0) flag('PRICE_DIFFERS', `Charged at prices that differ from the menu now: ${differences.join('; ')}.`);
  }

  /** Offline there is no manager to approve a discount over the limit: it is given, and pointed out. */
  private checkDiscounts({ op, ctx, permissions, flag }: Job): void {
    if (op.type !== 'order.save') return;
    const o = op.order;
    const net = o.items.reduce((sum, item) => sum + item.quantity * item.unitPricePaise - discountAmount(item.quantity * item.unitPricePaise, item.discount), 0);
    const given = [
      ...o.items.flatMap((item) => (item.discount ? [{ base: item.quantity * item.unitPricePaise, input: item.discount, on: item.name }] : [])),
      ...(o.discount ? [{ base: net, input: o.discount, on: 'the bill' }] : []),
    ];
    if (given.length === 0) return;
    const cap = ctx.settings.discountCapBps;
    const over = given.filter((d) => discountBps(d.base, d.input) > cap);
    if (over.length > 0) {
      flag('DISCOUNT_ABOVE_LIMIT', `A discount above the ${cap / 100}% limit was given without a manager's approval: ${over.map((d) => `${(discountBps(d.base, d.input) / 100).toFixed(1)}% on ${d.on}`).join(', ')}.`);
    }
    if (!permissions.includes('discount.apply')) flag('DISCOUNT_NOT_ALLOWED', 'A discount was given by someone not allowed to give discounts.');
  }

  // ── Kitchen tickets ──

  /** A ticket printed on the device. The kitchen worked from the paper, so it goes in as done and is not printed again. */
  private async applyKot(job: Job): Promise<Applied> {
    const { tx, restaurantId, op } = job;
    if (op.type !== 'kot.print') throw new Error('not a ticket');
    const k = op.kot;
    const order = await tx.order.findFirst({ where: { id: k.orderId, restaurantId }, include: { items: { select: { id: true } } } });
    if (!order) return this.waitFor(tx, restaurantId, k.orderId, 'the order');
    const existing = await tx.kot.findUnique({ where: { id: k.id } });
    if (existing) {
      if (existing.restaurantId !== restaurantId || existing.orderId !== k.orderId) throw new Refused('KOT_ID_TAKEN', 'A kitchen ticket with this id already exists elsewhere.');
      return this.kotApplied(k.id, k.orderId, existing.kotNumber, k.printedNumber);
    }
    const stationId = k.stationId && (await tx.kitchenStation.count({ where: { id: k.stationId, restaurantId } })) ? k.stationId : null;
    // The restaurant's ticket numbers restart each business day and are handed out one at a time, as online.
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${'kot-number:' + restaurantId + ':' + k.businessDate}, 0))`;
    const last = await tx.kot.aggregate({ where: { restaurantId, businessDate: asDate(k.businessDate) }, _max: { kotNumber: true } });
    const kotNumber = (last._max.kotNumber ?? 0) + 1;
    const lineIds = new Set(order.items.map((item) => item.id));
    await tx.kot.create({
      data: {
        id: k.id, restaurantId, orderId: k.orderId, stationId, kotNumber, businessDate: asDate(k.businessDate), type: k.type, status: 'COMPLETED',
        printCount: 1, notes: k.notes ?? null, createdById: op.userId, createdAt: new Date(op.createdAt), completedAt: new Date(), offlineNumber: k.printedNumber,
        items: {
          create: k.items.map((line) => ({
            orderItemId: line.orderItemId && lineIds.has(line.orderItemId) ? line.orderItemId : null, name: line.name, quantity: line.quantity, notes: line.notes ?? null,
          })),
        },
      },
    });
    return this.kotApplied(k.id, k.orderId, kotNumber, k.printedNumber);
  }

  private kotApplied(id: string, orderId: string, kotNumber: number, printedNumber: string): Applied {
    return {
      entityId: id, orderId, result: { kotId: id, kotNumber, printedNumber },
      audit: { action: 'kot.created', entityType: 'kot', entityId: id, after: { kotNumber, printedNumber } },
    };
  }

  // ── Bills ──

  /** A bill as it was printed: kept with every amount on it, under the number printed, in the device's own series. */
  private async applyInvoice(job: Job): Promise<Applied> {
    const { tx, restaurantId, device, op, ctx, flag } = job;
    if (op.type !== 'invoice.issue') throw new Error('not a bill');
    const b = op.invoice;
    await lockOrder(tx, restaurantId, b.orderId);
    const order = await tx.order.findFirst({ where: { id: b.orderId, restaurantId }, include: { items: true, invoices: { where: { status: 'ISSUED' } } } });
    if (!order) return this.waitFor(tx, restaurantId, b.orderId, 'the order');
    const existing = await tx.invoice.findUnique({ where: { id: b.id } });
    if (existing) {
      if (existing.restaurantId !== restaurantId || existing.orderId !== b.orderId) throw new Refused('INVOICE_ID_TAKEN', 'A bill with this id already exists elsewhere.');
      return this.invoiceApplied(existing.id, b.orderId, existing.invoiceNumber, b.invoiceNumber, existing.totalPaise);
    }

    const shown = displayNumber(order);
    if (order.status === 'CANCELLED' || order.status === 'MERGED') {
      flag('ORDER_CANCELLED', `Order ${shown} was cancelled online, but this bill had already been printed on the device.`);
    } else if (order.invoices.some((invoice) => invoice.terminalId !== device.offlineTerminalId)) {
      flag('BILLED_TWICE', `Order ${shown} was also billed online; the guest has this bill as well, printed on the device.`);
    }

    // The device's own series for the bill's financial year.
    const financialYear = financialYearOf(b.businessDate);
    await tx.$executeRaw`
      INSERT INTO number_series (id, restaurant_id, terminal_id, type, financial_year, prefix, next_number, created_at, updated_at)
      VALUES (gen_random_uuid(), ${restaurantId}::uuid, ${device.offlineTerminalId}::uuid, 'INVOICE'::"SeriesType", ${financialYear}, ${device.offlineTerminal.code}, 1, now(), now())
      ON CONFLICT (terminal_id, type, financial_year) DO NOTHING`;
    const [seriesRow] = await tx.$queryRaw<{ id: string; prefix: string; next_number: number }[]>`
      SELECT id, prefix, next_number FROM number_series
      WHERE terminal_id = ${device.offlineTerminalId}::uuid AND type = 'INVOICE'::"SeriesType" AND financial_year = ${financialYear} FOR UPDATE`;
    const series = seriesRow!;
    const format = (n: number) => formatDocumentNumber(series.prefix, financialYear, n);
    const taken = async (n: number) => (await tx.invoice.count({ where: { OR: [{ seriesId: series.id, number: n }, { restaurantId, invoiceNumber: format(n) }] } })) > 0;

    let number = b.number;
    if (await taken(number)) {
      number = Math.max(series.next_number, 1);
      while (await taken(number)) number += 1;
      flag('DUPLICATE_NUMBER', `Bill number ${b.invoiceNumber} was already used by another bill, so this one is stored as ${format(number)}. The guest's copy says ${b.invoiceNumber}.`);
    } else if (number > series.next_number) {
      const missing = number - series.next_number;
      flag('NUMBER_GAP', missing === 1
        ? `Bill ${format(series.next_number)} never arrived before this one, ${format(number)}.`
        : `Bills ${format(series.next_number)} to ${format(number - 1)} (${missing}) never arrived before this one, ${format(number)}.`);
    } else if (b.invoiceNumber !== format(number)) {
      flag('NUMBER_PRINTED_DIFFERENTLY', `Printed as ${b.invoiceNumber}; stored as ${format(number)}.`);
    }
    await tx.$executeRaw`UPDATE number_series SET next_number = GREATEST(next_number, ${number + 1}), updated_at = now() WHERE id = ${series.id}::uuid`;

    this.checkBill(job, order.items);

    const lineIds = new Set(order.items.map((item) => item.id));
    if (b.items.some((item) => !lineIds.has(item.orderItemId))) {
      flag('LINES_DIFFER', `Some lines on this bill are not on order ${shown} as it reached the server.`);
    }
    const invoiceNumber = format(number);
    await tx.invoice.create({
      data: {
        id: b.id, restaurantId, orderId: b.orderId, terminalId: device.offlineTerminalId, seriesId: series.id, number, invoiceNumber,
        docType: b.docType, paymentStatus: b.totalPaise === 0 ? 'PAID' : 'UNPAID', businessDate: asDate(b.businessDate), issuedAt: new Date(b.issuedAt),
        sellerSnapshot: b.seller as unknown as Prisma.InputJsonValue,
        customerName: b.customer?.name ?? null, customerPhone: b.customer?.phone ?? null, customerAddress: b.customer?.address ?? null,
        placeOfSupply: ctx.restaurant.stateCode, isInterState: b.igstPaise > 0,
        grossPaise: b.grossPaise, discountPaise: b.discountPaise, taxablePaise: b.taxablePaise, cgstPaise: b.cgstPaise, sgstPaise: b.sgstPaise,
        igstPaise: b.igstPaise, cessPaise: b.cessPaise, serviceChargePaise: b.serviceChargePaise, roundOffPaise: b.roundOffPaise, totalPaise: b.totalPaise,
        printCount: b.printCount, createdById: op.userId,
        items: {
          create: b.items.map((item, sortOrder) => ({
            orderItemId: lineIds.has(item.orderItemId) ? item.orderItemId : null, name: item.name, hsnSac: item.hsnSac, quantity: item.quantity,
            unitPricePaise: item.unitPricePaise, grossPaise: item.grossPaise, discountPaise: item.discountPaise, taxablePaise: item.taxablePaise,
            taxRateBps: item.taxRateBps, cgstPaise: item.cgstPaise, sgstPaise: item.sgstPaise, igstPaise: item.igstPaise, cessPaise: item.cessPaise,
            totalPaise: item.totalPaise, sortOrder,
          })),
        },
        taxes: { create: b.taxes.map((row) => ({ type: row.type, name: row.type, rateBps: row.rateBps, taxablePaise: row.taxablePaise, amountPaise: row.amountPaise })) },
      },
    });

    // The order shows what was billed: the sum of its bills, as online.
    if (order.status === 'OPEN' || order.status === 'HELD') {
      const sums = await tx.invoice.aggregate({
        where: { orderId: b.orderId, status: 'ISSUED' },
        _sum: { grossPaise: true, discountPaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, cessPaise: true, serviceChargePaise: true, roundOffPaise: true, totalPaise: true },
      });
      const sum = sums._sum;
      await tx.order.update({
        where: { id: b.orderId },
        data: {
          status: 'BILLED', heldAt: null, subtotalPaise: sum.grossPaise ?? 0, discountPaise: sum.discountPaise ?? 0,
          taxPaise: (sum.cgstPaise ?? 0) + (sum.sgstPaise ?? 0) + (sum.igstPaise ?? 0) + (sum.cessPaise ?? 0),
          serviceChargePaise: sum.serviceChargePaise ?? 0, roundOffPaise: sum.roundOffPaise ?? 0, totalPaise: sum.totalPaise ?? 0, version: { increment: 1 },
        },
      });
    }
    await this.settleIfPaid(tx, b.orderId);
    return this.invoiceApplied(b.id, b.orderId, invoiceNumber, b.invoiceNumber, b.totalPaise);
  }

  private invoiceApplied(id: string, orderId: string, invoiceNumber: string, printedNumber: string, totalPaise: number): Applied {
    return {
      entityId: id, orderId, result: { invoiceId: id, invoiceNumber, printedNumber, totalPaise },
      audit: { action: 'invoice.issued', entityType: 'invoice', entityId: id, after: { number: invoiceNumber, printedNumber, totalPaise } },
    };
  }

  /**
   * Works the bill out again from its own lines (quantities, prices, discounts and the rates charged) and points out
   * any amount that does not match what was printed, and any rate unlike the one the item's tax group has now.
   */
  private checkBill({ op, ctx, flag }: Job, orderItems: { id: string; taxGroupId: string | null; name: string }[]): void {
    if (op.type !== 'invoice.issue') return;
    const b = op.invoice;
    const again = computeBill({
      lines: b.items.map((item, index) => ({
        id: String(index), quantity: item.quantity, unitPricePaise: item.unitPricePaise, priceIncludesTax: item.priceIncludesTax,
        tax: { gstRateBps: item.taxRateBps, cessRateBps: item.cessRateBps }, discount: item.discountPaise > 0 ? { type: 'AMOUNT', value: item.discountPaise } : null,
      })),
      taxApplicable: b.docType === 'TAX_INVOICE', interState: b.igstPaise > 0, serviceChargeBps: b.serviceChargeBps,
      serviceChargeTax: ctx.defaultTax, roundOff: ctx.settings.roundOffMode,
    });
    const fields = [
      ['total', b.totalPaise, again.totalPaise], ['items', b.grossPaise, again.grossPaise], ['discount', b.discountPaise, again.discountPaise],
      ['taxable value', b.taxablePaise, again.taxablePaise], ['CGST', b.cgstPaise, again.cgstPaise], ['SGST', b.sgstPaise, again.sgstPaise],
      ['IGST', b.igstPaise, again.igstPaise], ['cess', b.cessPaise, again.cessPaise], ['service charge', b.serviceChargePaise, again.serviceChargePaise],
      ['round-off', b.roundOffPaise, again.roundOffPaise],
    ] as const;
    const wrong = fields.filter(([, printed, worked]) => printed !== worked);
    if (wrong.length > 0) {
      flag('TOTALS_DIFFER', `The printed amounts do not work out from the bill's lines: ${wrong.map(([name, printed, worked]) => `${name} ${formatINR(printed)} printed, ${formatINR(worked)} worked out`).join('; ')}.`);
    }
    const byLine = new Map(orderItems.map((item) => [item.id, item]));
    const rates = b.items.flatMap((item) => {
      const group = byLine.get(item.orderItemId)?.taxGroupId;
      const now = group ? ctx.taxRates.get(group) : undefined;
      return now && b.docType === 'TAX_INVOICE' && now.gstRateBps !== item.taxRateBps ? [`${item.name} at ${item.taxRateBps / 100}% (now ${now.gstRateBps / 100}%)`] : [];
    });
    if (rates.length > 0) flag('TAX_RATE_DIFFERS', `Taxed at rates that differ from the menu's tax groups now: ${rates.join('; ')}.`);
  }

  // ── Payments ──

  /** Money taken on the device. It is never refused: if it looks wrong (more than was due, a bill cancelled since), it is pointed out. */
  private async applyPayment(job: Job): Promise<Applied> {
    const { tx, restaurantId, op, ctx, flag } = job;
    if (op.type !== 'payment.record') throw new Error('not a payment');
    const p = op.payment;
    const owner = await tx.invoice.findFirst({ where: { id: p.invoiceId, restaurantId }, select: { orderId: true } });
    if (!owner) return this.waitFor(tx, restaurantId, p.invoiceId, 'the bill');
    // As everything that touches a bill's money: the order first, then the bill.
    await lockOrder(tx, restaurantId, owner.orderId);
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${p.invoiceId}::uuid FOR UPDATE`;
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: p.invoiceId } });

    const key = `${restaurantId}:${p.id}`;
    const already = await tx.payment.findUnique({ where: { idempotencyKey: key } });
    if (already) {
      if (already.invoiceId !== p.invoiceId) throw new Refused('PAYMENT_ID_TAKEN', 'A payment with this id was recorded against another bill.');
      return this.paymentApplied(p.id, invoice.orderId, already.id, p, invoice.invoiceNumber);
    }

    const amount = formatINR(p.amountPaise);
    const method = METHOD_NAME[p.method] ?? p.method;
    if (invoice.status !== 'ISSUED') flag('BILL_CANCELLED', `Bill ${invoice.invoiceNumber} was cancelled online, but ${amount} ${method} was taken for it on the device.`);
    const due = invoice.totalPaise - invoice.paidPaise;
    if (p.amountPaise > due) {
      flag('OVERPAID', due <= 0
        ? `Bill ${invoice.invoiceNumber} was already paid in full when ${amount} ${method} taken on the device arrived.`
        : `${amount} ${method} was taken for bill ${invoice.invoiceNumber}, which had only ${formatINR(due)} still due.`);
    }

    let registerSessionId: string | null = null;
    if (p.registerSessionId) {
      const register = await tx.cashRegisterSession.findFirst({ where: { id: p.registerSessionId, restaurantId }, select: { id: true, status: true } });
      if (register?.status === 'OPEN') registerSessionId = await stillOpen(tx, restaurantId, register.id);
      if (!registerSessionId && p.method === 'CASH') {
        flag('REGISTER_CLOSED', `${amount} cash for bill ${invoice.invoiceNumber} arrived after the cash register it was taken into was closed, so it is not counted in any register.`);
      }
    } else if (p.method === 'CASH' && ctx.settings.registerRequired) {
      flag('NO_REGISTER', `${amount} cash for bill ${invoice.invoiceNumber} was taken on the device with no cash register open.`);
    }

    const tendered = p.method === 'CASH' && p.tenderedPaise !== null && p.tenderedPaise >= p.amountPaise ? p.tenderedPaise : null;
    const payment = await tx.payment.create({
      data: {
        restaurantId, invoiceId: p.invoiceId, method: p.method, status: 'SUCCESS', amountPaise: p.amountPaise, tenderedPaise: tendered,
        changePaise: tendered === null ? null : tendered - p.amountPaise, reference: p.reference ?? null, idempotencyKey: key,
        businessDate: asDate(p.businessDate), receivedById: op.userId, paidAt: new Date(p.paidAt), registerSessionId,
      },
    });
    const paid = invoice.paidPaise + p.amountPaise;
    await tx.invoice.update({ where: { id: p.invoiceId }, data: { paidPaise: paid, paymentStatus: paid >= invoice.totalPaise ? 'PAID' : 'PARTIALLY_PAID' } });
    await this.settleIfPaid(tx, invoice.orderId);
    return this.paymentApplied(p.id, invoice.orderId, payment.id, p, invoice.invoiceNumber);
  }

  private paymentApplied(id: string, orderId: string, paymentId: string, p: { method: string; amountPaise: number; invoiceId: string }, invoiceNumber: string): Applied {
    return {
      entityId: id, orderId, result: { paymentId, invoiceId: p.invoiceId, invoiceNumber, method: p.method, amountPaise: p.amountPaise },
      audit: { action: 'payment.recorded', entityType: 'invoice', entityId: p.invoiceId, after: { payments: [{ method: p.method, amountPaise: p.amountPaise }] } },
    };
  }

  /** A billed order is complete once every bill standing against it is paid. An order cancelled online stays cancelled. */
  private async settleIfPaid(tx: Tx, orderId: string): Promise<void> {
    const invoices = await tx.invoice.findMany({ where: { orderId, status: 'ISSUED' }, select: { totalPaise: true, paidPaise: true } });
    if (invoices.length === 0 || invoices.some((invoice) => invoice.paidPaise < invoice.totalPaise)) return;
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    if (order.status !== 'BILLED') return;
    const settled = await tx.order.update({ where: { id: orderId }, data: { status: 'SETTLED', version: { increment: 1 } } });
    if (settled.tableId) await this.orders.freeTable(tx, settled.tableId);
  }

  // ── Reviewing ──

  /** Uploaded work that needs a look: stored with flags, or refused. Newest first. */
  async reviews(auth: AuthContext, query: z.output<typeof syncReviewQuerySchema>): Promise<Page<SyncReviewDto>> {
    const where: Prisma.SyncOperationWhereInput = {
      restaurantId: auth.restaurantId,
      OR: [{ status: 'REJECTED' }, { flags: { not: Prisma.DbNull } }],
      reviewedAt: query.status === 'open' ? null : query.status === 'checked' ? { not: null } : undefined,
    };
    const [total, rows] = await Promise.all([
      this.prisma.syncOperation.count({ where }),
      this.prisma.syncOperation.findMany({
        where, orderBy: { appliedAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize,
        include: { terminal: { select: { code: true } }, device: { select: { label: true } } },
      }),
    ]);
    return { items: await this.toReviews(rows), total, page: query.page, pageSize: query.pageSize };
  }

  /** Marks an uploaded operation as checked, with an optional note in the audit log. */
  async check(auth: AuthContext, id: string, input: z.output<typeof checkSyncReviewSchema>): Promise<SyncReviewDto> {
    const row = await this.prisma.syncOperation.findFirst({ where: { id, restaurantId: auth.restaurantId } });
    if (!row || (row.status !== 'REJECTED' && row.flags === null)) throw notFound('Upload to check');
    if (!row.reviewedAt) {
      await this.prisma.syncOperation.update({ where: { id }, data: { reviewedAt: new Date(), reviewedById: auth.userId } });
      await this.audit.record(auth, { action: 'sync.checked', entityType: 'sync_operation', entityId: id, reason: input.note ?? null, after: { type: row.type, flags: flagsOf(row.flags).map((f) => f.code) } });
    }
    const updated = await this.prisma.syncOperation.findUniqueOrThrow({ where: { id }, include: { terminal: { select: { code: true } }, device: { select: { label: true } } } });
    return (await this.toReviews([updated]))[0]!;
  }

  private async toReviews(
    rows: Prisma.SyncOperationGetPayload<{ include: { terminal: { select: { code: true } }; device: { select: { label: true } } } }>[],
  ): Promise<SyncReviewDto[]> {
    const userIds = [...new Set(rows.flatMap((row) => [row.userId, row.uploadedById, row.reviewedById]).filter((id): id is string => Boolean(id)))];
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((user) => [user.id, user.name]));
    const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null);
    return rows.map((row) => {
      const payload = (row.payload ?? {}) as Record<string, Record<string, unknown> | undefined>;
      const result = (row.result ?? {}) as Record<string, unknown>;
      const invoiceId = row.type === 'invoice.issue' ? row.entityId : row.type === 'payment.record' ? String(payload.payment?.invoiceId ?? '') || null : null;
      return {
        id: row.id, type: row.type, status: row.status, error: row.error, flags: flagsOf(row.flags),
        deviceCode: row.terminal.code, deviceLabel: row.device?.label ?? null, userName: nameOf(row.userId), uploadedByName: nameOf(row.uploadedById),
        happenedAt: row.clientCreatedAt.toISOString(), uploadedAt: row.appliedAt.toISOString(), orderId: row.status === 'APPLIED' ? row.orderId : null,
        invoiceId: row.status === 'APPLIED' ? invoiceId : null, summary: this.summary(row.type, payload, result, row.terminal.code),
        reviewedAt: row.reviewedAt?.toISOString() ?? null, reviewedByName: nameOf(row.reviewedById),
      };
    });
  }

  /** What an operation was, as people would say it. */
  private summary(type: string, payload: Record<string, Record<string, unknown> | undefined>, result: Record<string, unknown>, code: string): string {
    const money = (value: unknown) => (typeof value === 'number' ? formatINR(value) : '');
    if (type === 'order.save') return `Order ${String(result.displayNumber ?? `${code}-${String(payload.order?.orderNumber ?? '?')}`)}`;
    if (type === 'kot.print') return `Kitchen ticket ${String(payload.kot?.printedNumber ?? '')}`.trim();
    if (type === 'invoice.issue') return `Bill ${String(result.invoiceNumber ?? payload.invoice?.invoiceNumber ?? '')} · ${money(payload.invoice?.totalPaise)}`;
    if (type === 'payment.record') {
      const method = METHOD_NAME[String(payload.payment?.method)] ?? 'payment';
      return `${money(payload.payment?.amountPaise)} ${method}${result.invoiceNumber ? ` for bill ${String(result.invoiceNumber)}` : ''}`.trim();
    }
    return 'Something the server could not read';
  }
}
