'use client';

import { amountInWords, businessDateOf, discountAmount, discountBps, financialYearOf, formatDocumentNumber, orderNumberPeriod } from '@pos/billing-core';
import { buildSeller } from '@pos/printing';
import type { PermissionKey } from '@pos/types';
import { discountInput } from '@pos/ui';
import type { AuthUser, InvoiceDto, KotDto, PaymentDto, PaymentMethod, PosBootstrap, ProductDto, SyncOperationInput } from '@pos/validation';
import { type Cart, cartBill, type CartLine, useCart } from './cart';
import { CLOCK_TOLERANCE_MS, useConnection } from './connection';
import { useDevice } from './device';
import { takeNumbers } from './offline-numbers';
import { madeOffline, offlineDb } from './offline-store';
import { enqueue } from './outbox';

/** Something that cannot be done without the internet, or not safely on this device: the message says what to do. */
export class OfflineRefusal extends Error {}

/** Whether a bill or ticket was made on this device offline and has not reached the server yet. */
export const isMadeOffline = (id: string) => madeOffline.has(id);

const REGISTER_KEY = (userId: string) => `pos.register.${userId}`;

/** The cash register this person had open when the server last said so, for taking cash while offline. */
export function rememberRegister(userId: string, register: { id: string } | null): void {
  try {
    if (register) window.localStorage.setItem(REGISTER_KEY(userId), register.id);
    else window.localStorage.removeItem(REGISTER_KEY(userId));
  } catch {
    // Not kept: cash offline then needs no register only where the restaurant does not require one.
  }
}
const knownRegister = (userId: string): string | null => {
  try {
    return window.localStorage.getItem(REGISTER_KEY(userId));
  } catch {
    return null;
  }
};

/** Whether this device can bill offline at all, and if not, why. */
function readiness(user: AuthUser, needs: PermissionKey[]): { code: string } {
  const device = useDevice.getState().device;
  if (!device) throw new OfflineRefusal('This device is not set up for billing offline yet. That happens the first time it opens with the internet.');
  if (!offlineDb()) throw new OfflineRefusal('This browser cannot keep bills on the device (a private window?), so it cannot bill offline.');
  const clock = useConnection.getState().clock;
  if (!clock) throw new OfflineRefusal('The device\'s clock has not been checked against the server yet. Connect once to bill offline.');
  if (Math.abs(clock.offsetMs) > CLOCK_TOLERANCE_MS) {
    throw new OfflineRefusal(`This device's clock is ${Math.round(Math.abs(clock.offsetMs) / 60_000)} minutes off. Set the right time in its settings to bill offline.`);
  }
  if (needs.some((permission) => !user.permissions.includes(permission))) throw new OfflineRefusal('You are not allowed to do this.');
  return { code: device.offlineCode };
}

/** Why this order cannot be taken further offline, if it cannot. */
function checkOrder(cart: Cart, user: AuthUser, boot: PosBootstrap): void {
  if (cart.saved) throw new OfflineRefusal('This order was started online. It can be finished once the connection is back; a new order can be billed offline.');
  if (cart.type === 'DINE_IN') throw new OfflineRefusal('Tables need the internet. Take it as takeaway or delivery to bill offline.');
  if (cart.lines.length === 0) throw new OfflineRefusal('Add at least one item first.');
  const net = cart.lines.reduce((sum, line) => sum + line.quantity * line.unitPricePaise - discountAmount(line.quantity * line.unitPricePaise, line.discount), 0);
  const given = [
    ...cart.lines.flatMap((line) => (line.discount ? [{ base: line.quantity * line.unitPricePaise, discount: line.discount }] : [])),
    ...(cart.discount ? [{ base: net, discount: cart.discount }] : []),
  ];
  if (given.length > 0 && !user.permissions.includes('discount.apply')) throw new OfflineRefusal('You are not allowed to give discounts.');
  // There is no manager to approve a larger discount without the internet.
  if (given.some((d) => discountBps(d.base, d.discount) > boot.settings.discountCapBps) && !user.permissions.includes('discount.above_cap')) {
    throw new OfflineRefusal(`Discounts above ${boot.settings.discountCapBps / 100}% need a manager's approval, which needs the internet.`);
  }
}

const today = (boot: PosBootstrap) => businessDateOf(new Date(), boot.settings.timezone, boot.settings.dayCutoffMinutes);
const operation = <T extends object>(user: AuthUser, type: string, body: T) => ({ id: crypto.randomUUID(), type, userId: user.id, createdAt: new Date().toISOString(), ...body });

/** The kitchen station an item goes to, as the server decides it: its own if active, else the first; none if it never goes. */
function stationFor(product: ProductDto | undefined, boot: PosBootstrap): string | null {
  if (product && !product.sendToKitchen) return null;
  if (product?.stationId && boot.stations.some((station) => station.id === product.stationId)) return product.stationId;
  return boot.stations[0]?.id ?? null;
}

/** "Butter Chicken (Full) + Raita", as the server names a bill line. */
const billLineName = (line: CartLine) => `${line.name}${line.variantName ? ` (${line.variantName})` : ''}${line.modifierNames.length > 0 ? ` + ${line.modifierNames.join(', ')}` : ''}`;

/** Gives the cart's order a number in the device's series, the first time it is taken further offline. */
async function startOrder(cart: Cart, boot: PosBootstrap, user: AuthUser, code: string): Promise<Cart> {
  if (cart.offlineOrder) return cart;
  const businessDate = today(boot);
  const period = orderNumberPeriod(boot.settings.orderNumberReset, businessDate, financialYearOf(businessDate));
  const numberPeriod = boot.settings.orderNumberEpoch > 0 ? `${period}#${boot.settings.orderNumberEpoch}` : period;
  const number = await takeNumbers(user.restaurantId, 'order', numberPeriod);
  useCart.getState().startOffline(number, businessDate, `${code}-${number}`);
  return useCart.getState();
}

/** The order as it stands, as an upload. Each line keeps the price, tax rate and station the device used. */
function orderOperation(cart: Cart, boot: PosBootstrap, user: AuthUser): SyncOperationInput {
  const products = new Map(boot.products.map((product) => [product.id, product]));
  const rates = new Map(boot.taxGroups.map((group) => [group.id, group]));
  const options = new Map(boot.modifierGroups.flatMap((group) => group.modifiers).map((modifier) => [modifier.id, modifier]));
  const customer = cart.customer?.phone ? { phone: cart.customer.phone, name: cart.customer.name || null, address: cart.customer.address || null } : null;
  return operation(user, 'order.save', {
    order: {
      id: cart.orderId, type: cart.type, orderNumber: cart.offlineOrder!.number, businessDate: cart.offlineOrder!.businessDate,
      guests: cart.guests, notes: cart.notes || null, deliveryAddress: cart.type === 'DELIVERY' ? (customer?.address ?? null) : null, customer,
      discount: discountInput(cart.discount),
      items: cart.lines.map((line) => {
        const product = products.get(line.productId);
        const rate = line.taxGroupId ? rates.get(line.taxGroupId) : undefined;
        return {
          id: line.id, productId: line.productId, variantId: line.variantId,
          modifiers: line.modifierIds.map((id, index) => ({ modifierId: id, name: options.get(id)?.name ?? line.modifierNames[index] ?? 'Option', pricePaise: options.get(id)?.pricePaise ?? 0 })),
          name: line.name, variantName: line.variantName, hsnSac: product?.hsnSac ?? null, taxGroupId: line.taxGroupId,
          gstRateBps: rate?.gstRateBps ?? 0, cessRateBps: rate?.cessRateBps ?? 0, priceIncludesTax: line.priceIncludesTax,
          stationId: stationFor(product, boot), unitPricePaise: line.unitPricePaise, quantity: line.quantity, kotQuantity: line.kotQuantity,
          notes: line.notes || null, discount: discountInput(line.discount),
        };
      }),
    },
  }) as SyncOperationInput;
}

/**
 * The KOT button offline: whatever the kitchen has not been sent goes on one ticket per station, numbered in the
 * device's series (Z01-K3), and is kept for upload. Returns the tickets to print. Without the internet there is no
 * kitchen display, so the tickets are always printed.
 */
export async function sendToKitchenOffline(boot: PosBootstrap, user: AuthUser): Promise<KotDto[]> {
  const { code } = readiness(user, ['order.create', 'kot.fire']);
  checkOrder(useCart.getState(), user, boot);
  const cart = await startOrder(useCart.getState(), boot, user, code);
  const products = new Map(boot.products.map((product) => [product.id, product]));
  const pending = cart.lines.filter((line) => line.quantity > line.kotQuantity);
  const byStation = new Map<string, CartLine[]>();
  for (const line of pending) {
    const station = stationFor(products.get(line.productId), boot);
    if (station) byStation.set(station, [...(byStation.get(station) ?? []), line]);
  }

  const businessDate = cart.offlineOrder!.businessDate;
  const first = byStation.size > 0 ? await takeNumbers(user.restaurantId, 'kot', businessDate, byStation.size) : 0;
  const now = new Date().toISOString();
  const kots: KotDto[] = [...byStation.entries()].map(([stationId, lines], index) => {
    const number = first + index;
    return {
      id: crypto.randomUUID(), kotNumber: number, offlineNumber: `${code}-K${number}`, type: 'NEW', status: 'PENDING', stationId,
      stationName: boot.stations.find((station) => station.id === stationId)?.name ?? null, orderId: cart.orderId, orderDisplayNumber: cart.displayNumber!,
      orderType: cart.type, tableName: null, tokenNumber: cart.offlineOrder!.number, notes: null,
      items: lines.map((line) => ({
        id: line.id, name: line.name + (line.variantName ? ` (${line.variantName})` : ''), quantity: line.quantity - line.kotQuantity, cancelledQuantity: 0,
        notes: [...line.modifierNames, line.notes].filter(Boolean).join(' · ') || null,
      })),
      printCount: 0, createdByName: user.name, createdAt: now, preparingAt: null, readyAt: null, completedAt: null,
    };
  });

  // Items with no kitchen station need no ticket, but count as dealt with, as online.
  useCart.getState().markSentToKitchen(pending.map((line) => line.id));
  const sent = useCart.getState();
  await enqueue(user.restaurantId, [
    orderOperation(sent, boot, user),
    ...kots.map((kot) => operation(user, 'kot.print', {
      kot: {
        id: kot.id, orderId: kot.orderId, stationId: kot.stationId, type: 'NEW', printedNumber: kot.offlineNumber!, businessDate, notes: null,
        items: kot.items.map((item) => ({ orderItemId: item.id, name: item.name, quantity: item.quantity, notes: item.notes })),
      },
    }) as SyncOperationInput),
  ]);
  for (const kot of kots) madeOffline.add(kot.id);
  useCart.setState({ dirty: false });
  return kots;
}

/**
 * Bill & pay offline: the bill is worked out here, with the same arithmetic as the server, numbered in the device's
 * series (Z01/2627/000004), kept on the device for printing again, and kept for upload with the order as it stands.
 * Returns the bill, to take payment for and print.
 */
export async function billOffline(boot: PosBootstrap, user: AuthUser, autoPrint: boolean): Promise<InvoiceDto> {
  const { code } = readiness(user, ['order.create', 'invoice.create']);
  checkOrder(useCart.getState(), user, boot);
  const cart = await startOrder(useCart.getState(), boot, user, code);
  const order = cart.offlineOrder!;
  const bill = cartBill(cart, boot);
  const financialYear = financialYearOf(order.businessDate);
  const number = await takeNumbers(user.restaurantId, 'invoice', financialYear);
  const invoiceNumber = formatDocumentNumber(code, financialYear, number);
  const rates = new Map(boot.taxGroups.map((group) => [group.id, group]));
  const products = new Map(boot.products.map((product) => [product.id, product]));
  const lines = new Map(cart.lines.map((line) => [line.id, line]));
  const seller = buildSeller(boot.restaurant, boot.settings);
  const taxed = boot.settings.gstRegistration === 'REGULAR';
  const customer = cart.customer?.phone ? { name: cart.customer.name || null, phone: cart.customer.phone, address: cart.customer.address || null } : null;
  const issuedAt = new Date().toISOString();
  const invoiceId = cart.billIds[0]!;
  const printCount = autoPrint ? 1 : 0;

  const items = bill.lines.map((amounts) => {
    const line = lines.get(amounts.id)!;
    return {
      orderItemId: line.id, name: billLineName(line), hsnSac: products.get(line.productId)?.hsnSac ?? null, quantity: amounts.quantity,
      unitPricePaise: amounts.unitPricePaise, priceIncludesTax: line.priceIncludesTax, grossPaise: amounts.grossPaise, discountPaise: amounts.discountPaise,
      taxablePaise: amounts.taxablePaise, taxRateBps: amounts.gstRateBps, cessRateBps: line.taxGroupId ? (rates.get(line.taxGroupId)?.cessRateBps ?? 0) : 0,
      cgstPaise: amounts.cgstPaise, sgstPaise: amounts.sgstPaise, igstPaise: amounts.igstPaise, cessPaise: amounts.cessPaise, totalPaise: amounts.totalPaise,
    };
  });
  const invoice: InvoiceDto = {
    id: invoiceId, invoiceNumber, status: 'ISSUED', paymentStatus: bill.totalPaise === 0 ? 'PAID' : 'UNPAID', totalPaise: bill.totalPaise, paidPaise: 0, refundedPaise: 0,
    orderId: cart.orderId, orderDisplayNumber: `${code}-${order.number}`, orderType: cart.type, tableName: null, tokenNumber: order.number,
    docType: taxed ? 'TAX_INVOICE' : 'BILL_OF_SUPPLY', businessDate: order.businessDate, issuedAt, seller,
    customer: customer ? { ...customer, gstin: null } : null, placeOfSupply: boot.restaurant.stateCode, placeOfSupplyName: boot.restaurant.stateName, isInterState: false,
    grossPaise: bill.grossPaise, discountPaise: bill.discountPaise, taxablePaise: bill.taxablePaise, cgstPaise: bill.cgstPaise, sgstPaise: bill.sgstPaise,
    igstPaise: bill.igstPaise, cessPaise: bill.cessPaise, taxAddedPaise: bill.taxAddedPaise, serviceChargePaise: bill.serviceChargePaise, roundOffPaise: bill.roundOffPaise,
    amountInWords: amountInWords(bill.totalPaise), printCount: 0, cashierName: user.name, cancelReason: null,
    items: items.map((item) => ({ ...item, id: item.orderItemId, refundedQuantity: 0 })),
    taxes: bill.taxSummary, payments: [], refunds: [],
  };

  await enqueue(user.restaurantId, [
    orderOperation(cart, boot, user),
    operation(user, 'invoice.issue', {
      invoice: {
        id: invoiceId, orderId: cart.orderId, number, invoiceNumber, businessDate: order.businessDate, issuedAt, docType: invoice.docType, seller, customer,
        serviceChargeBps: boot.settings.serviceChargeEnabled ? boot.settings.serviceChargeBps : 0, printCount,
        grossPaise: bill.grossPaise, discountPaise: bill.discountPaise, taxablePaise: bill.taxablePaise, cgstPaise: bill.cgstPaise, sgstPaise: bill.sgstPaise,
        igstPaise: bill.igstPaise, cessPaise: bill.cessPaise, serviceChargePaise: bill.serviceChargePaise, roundOffPaise: bill.roundOffPaise, totalPaise: bill.totalPaise,
        items, taxes: bill.taxSummary,
      },
    }) as SyncOperationInput,
  ], { invoiceId, restaurantId: user.restaurantId, businessDate: order.businessDate, invoice, createdAt: issuedAt });
  madeOffline.add(invoiceId);
  return invoice;
}

/** Money taken offline against a bill made offline: kept for upload, and on the bill kept on the device. */
export async function payOffline(
  boot: PosBootstrap, user: AuthUser, invoice: InvoiceDto,
  payments: { id: string; method: PaymentMethod; amountPaise: number; tenderedPaise?: number; reference: string | null }[],
): Promise<InvoiceDto> {
  readiness(user, ['payment.record']);
  const register = knownRegister(user.id);
  if (!register && boot.settings.registerRequired && payments.some((payment) => payment.method === 'CASH')) {
    throw new OfflineRefusal('Cash needs your cash register open, and opening it needs the internet. Take UPI or card, or pay later.');
  }
  const due = invoice.totalPaise - invoice.paidPaise;
  const paying = payments.reduce((sum, payment) => sum + payment.amountPaise, 0);
  if (paying > due) throw new OfflineRefusal('That is more than is due on this bill.');
  const paidAt = new Date().toISOString();
  const businessDate = today(boot);
  const recorded: PaymentDto[] = payments.map((payment) => ({
    id: payment.id, method: payment.method, status: 'SUCCESS', amountPaise: payment.amountPaise, tenderedPaise: payment.tenderedPaise ?? null,
    changePaise: payment.tenderedPaise === undefined ? null : payment.tenderedPaise - payment.amountPaise, refundedPaise: 0,
    reference: payment.reference, receivedByName: user.name, paidAt,
  }));
  const paid = invoice.paidPaise + paying;
  const updated: InvoiceDto = { ...invoice, paidPaise: paid, paymentStatus: paid >= invoice.totalPaise ? 'PAID' : 'PARTIALLY_PAID', payments: [...invoice.payments, ...recorded] };
  await enqueue(
    user.restaurantId,
    payments.map((payment) => operation(user, 'payment.record', {
      payment: {
        id: payment.id, invoiceId: invoice.id, method: payment.method, amountPaise: payment.amountPaise, tenderedPaise: payment.tenderedPaise ?? null,
        reference: payment.reference, paidAt, businessDate, registerSessionId: register,
      },
    }) as SyncOperationInput),
    { invoiceId: invoice.id, restaurantId: user.restaurantId, businessDate: invoice.businessDate, invoice: updated, createdAt: invoice.issuedAt },
  );
  return updated;
}

/** Notes that a bill made offline was printed, on the copy kept on the device: the next printout says "Duplicate". */
export async function markPrintedOffline(invoice: InvoiceDto): Promise<InvoiceDto> {
  const printed = { ...invoice, printCount: invoice.printCount + 1 };
  const db = offlineDb();
  const sale = await db?.sales.get(invoice.id);
  if (db && sale) await db.sales.put({ ...sale, invoice: { ...sale.invoice, printCount: printed.printCount } });
  return printed;
}

/** The bills this device made offline for a business date, newest first, as kept on the device. */
export async function offlineSales(restaurantId: string, businessDate: string): Promise<InvoiceDto[]> {
  const db = offlineDb();
  if (!db) return [];
  const sales = await db.sales.where('businessDate').equals(businessDate).toArray().catch(() => []);
  // A bill still waiting to be uploaded is paid and printed on the device.
  const waiting = new Set((await db.outbox.toArray().catch(() => [])).flatMap((entry) => (entry.operation.type === 'invoice.issue' ? [entry.operation.invoice.id] : [])));
  for (const sale of sales) if (waiting.has(sale.invoiceId)) madeOffline.add(sale.invoiceId);
  return sales.filter((sale) => sale.restaurantId === restaurantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((sale) => sale.invoice);
}
