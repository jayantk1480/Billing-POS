import type { Bill } from '@pos/billing-core';
import { discountFromOrder, discountInput, type LineChoice, type LineDiscount, lineFromProduct, lineInputs, linesBill, linesFromOrder, type OrderLine, sameChoice } from '@pos/ui';
import type { OrderDto, OrderType, PosBootstrap, SaveOrderInput } from '@pos/validation';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type CartDiscount = LineDiscount;
export type CartLine = OrderLine;
export { lineFromProduct };

export interface CartCustomer {
  name: string;
  phone: string;
  address: string;
}

export interface Cart {
  orderId: string;
  /** True once the order exists on the server. */
  saved: boolean;
  version: number | null;
  displayNumber: string | null;
  type: OrderType;
  tableId: string | null;
  guests: number;
  notes: string;
  customer: CartCustomer | null;
  lines: CartLine[];
  discount: CartDiscount | null;
  /** True when there are changes the server has not seen. */
  dirty: boolean;
  /**
   * Ids for this order's bills, chosen here so that billing can be asked for again after an answer was lost: the
   * server returns the bills already issued under them. One per part of a split bill, so ten are kept.
   */
  billIds: string[];
  /**
   * Set when the order was started on this device without the internet: its number in the device's own series and
   * its business date. Such an order is finished on the device (sent to the kitchen and billed there), and uploaded.
   */
  offlineOrder: { number: number; businessDate: string } | null;
  /** True once the order has been sent to the server, even without an answer: it may exist there. */
  sentToServer: boolean;
}

const newBillIds = () => Array.from({ length: 10 }, () => crypto.randomUUID());

interface CartActions {
  reset: (type?: OrderType) => void;
  setType: (type: OrderType) => void;
  setTable: (tableId: string | null) => void;
  addLine: (line: LineChoice, quantity?: number) => void;
  setQuantity: (id: string, quantity: number) => void;
  updateLine: (id: string, patch: Partial<Pick<CartLine, 'notes' | 'discount'>>) => void;
  setDiscount: (discount: CartDiscount | null) => void;
  setCustomer: (customer: CartCustomer | null) => void;
  /** Replaces the cart with an order as the server holds it. */
  load: (order: OrderDto) => void;
  /** Marks the order as about to be sent to the server. */
  markSentToServer: () => void;
  /**
   * Starts the order on this device, offline, under the number given. An order that was sent to the server without an
   * answer may exist there under its ids, so it takes new ones first: the offline order is then a separate one.
   */
  startOffline: (number: number, businessDate: string, displayNumber: string) => void;
  /** The kitchen has been sent everything on these lines. */
  markSentToKitchen: (lineIds: string[]) => void;
}

const empty = (type: OrderType = 'TAKEAWAY'): Cart => ({
  orderId: crypto.randomUUID(), saved: false, version: null, displayNumber: null, type, tableId: null, guests: 1, notes: '',
  customer: null, lines: [], discount: null, dirty: false, billIds: newBillIds(), offlineOrder: null, sentToServer: false,
});

/**
 * The order being built at this terminal. It lives in the browser first, so every tap is instant,
 * and is kept across a page refresh. The server prices it again when it is saved.
 */
export const useCart = create<Cart & CartActions>()(
  persist(
    (set) => ({
      ...empty(),
      reset: (type) => set(empty(type)),
      setType: (type) => set((cart) => ({ type, tableId: type === 'DINE_IN' ? cart.tableId : null, dirty: true })),
      setTable: (tableId) => set({ tableId, dirty: true }),
      addLine: (line, quantity = 1) =>
        set((cart) => {
          // Tapping the same item again raises its quantity, unless that line has its own note or discount.
          const match = cart.lines.find((existing) => sameChoice(existing, line) && !existing.notes && !existing.discount);
          const lines = match
            ? cart.lines.map((existing) => (existing === match ? { ...existing, quantity: existing.quantity + quantity } : existing))
            : [...cart.lines, { ...line, id: crypto.randomUUID(), quantity, kotQuantity: 0, notes: '', discount: null }];
          return { lines, dirty: true };
        }),
      setQuantity: (id, quantity) =>
        set((cart) => ({
          lines: quantity <= 0 ? cart.lines.filter((line) => line.id !== id) : cart.lines.map((line) => (line.id === id ? { ...line, quantity: Math.min(quantity, 999) } : line)),
          dirty: true,
        })),
      updateLine: (id, patch) => set((cart) => ({ lines: cart.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)), dirty: true })),
      setDiscount: (discount) => set({ discount, dirty: true }),
      setCustomer: (customer) => set({ customer, dirty: true }),
      load: (order) =>
        set((cart) => ({
          // The same order keeps its bill ids, so a bill asked for before the reload is found again.
          billIds: cart.orderId === order.id && cart.billIds?.length === 10 ? cart.billIds : newBillIds(),
          offlineOrder: null, sentToServer: true,
          orderId: order.id, saved: true, version: order.version, displayNumber: order.displayNumber, type: order.type,
          tableId: order.tableId, guests: order.guests, notes: order.notes ?? '', dirty: false,
          customer: order.customer
            ? { name: order.customer.name ?? '', phone: order.customer.phone ?? '', address: order.customer.address ?? '' }
            : null,
          discount: discountFromOrder(order),
          lines: linesFromOrder(order),
        })),
      markSentToServer: () => set({ sentToServer: true }),
      startOffline: (number, businessDate, displayNumber) =>
        set((cart) => ({
          ...(cart.sentToServer && !cart.saved
            ? { orderId: crypto.randomUUID(), billIds: newBillIds(), lines: cart.lines.map((line) => ({ ...line, id: crypto.randomUUID() })) }
            : {}),
          offlineOrder: { number, businessDate }, displayNumber, sentToServer: false,
        })),
      markSentToKitchen: (lineIds) =>
        set((cart) => ({ lines: cart.lines.map((line) => (lineIds.includes(line.id) ? { ...line, kotQuantity: line.quantity } : line)) })),
    }),
    {
      name: 'pos-cart', version: 4,
      // Carts kept by an earlier version have no bill ids yet (before 3), and none was started offline (before 4).
      migrate: (stored, version) => ({
        ...(stored as Cart), ...(version < 3 ? { billIds: newBillIds() } : {}), offlineOrder: null, sentToServer: Boolean((stored as Cart).saved),
      }),
    },
  ),
);

/** Totals for the screen, using the same arithmetic the server uses when the order is saved. */
export const cartBill = (cart: Pick<Cart, 'lines' | 'discount'>, boot: PosBootstrap): Bill => linesBill(cart.lines, cart.discount, boot);

/** The request body that saves this cart. */
export function toSaveInput(cart: Cart): SaveOrderInput {
  return {
    type: cart.type,
    tableId: cart.type === 'DINE_IN' ? cart.tableId : null,
    guests: cart.guests,
    notes: cart.notes || null,
    // The mobile number is the customer; without one there is no customer on the order.
    customer: cart.customer?.phone ? { phone: cart.customer.phone, name: cart.customer.name || null, address: cart.customer.address || null } : null,
    deliveryAddress: cart.type === 'DELIVERY' ? cart.customer?.address || null : null,
    items: lineInputs(cart.lines),
    discount: discountInput(cart.discount),
    version: cart.version ?? undefined,
  };
}
