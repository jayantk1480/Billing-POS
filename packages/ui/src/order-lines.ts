import { type Bill, computeBill } from '@pos/billing-core';
import type { OrderDto, OrderItemInput, PosBootstrap, ProductDto } from '@pos/validation';

/**
 * An order's lines as a screen edits them, and the arithmetic that goes with them.
 * Shared by the billing screen's cart and the back office's order editor, so both show the
 * totals the server will arrive at when the order is saved.
 */

export interface LineDiscount {
  type: 'PERCENT' | 'AMOUNT';
  /** Basis points for PERCENT, paise for AMOUNT. */
  value: number;
  reason: string;
}

export interface OrderLine {
  id: string;
  productId: string;
  variantId: string | null;
  modifierIds: string[];
  name: string;
  variantName: string | null;
  modifierNames: string[];
  unitPricePaise: number;
  quantity: number;
  /** How many of these the kitchen has already been sent. */
  kotQuantity: number;
  notes: string;
  discount: LineDiscount | null;
  taxGroupId: string | null;
  priceIncludesTax: boolean;
}

/** What a product contributes to a line, before it has an id and a quantity. */
export type LineChoice = Omit<OrderLine, 'id' | 'quantity' | 'kotQuantity' | 'notes' | 'discount'>;

/** A line from a menu product and the customer's choices. */
export function lineFromProduct(product: ProductDto, boot: PosBootstrap, variantId: string | null, modifierIds: string[]): LineChoice {
  const variant = product.variants.find((v) => v.id === variantId) ?? null;
  const modifiers = boot.modifierGroups.flatMap((group) => group.modifiers).filter((m) => modifierIds.includes(m.id));
  return {
    productId: product.id,
    variantId: variant?.id ?? null,
    modifierIds: modifiers.map((m) => m.id),
    name: product.name,
    variantName: variant?.name ?? null,
    modifierNames: modifiers.map((m) => m.name),
    unitPricePaise: (variant?.pricePaise ?? product.basePricePaise) + modifiers.reduce((sum, m) => sum + m.pricePaise, 0),
    taxGroupId: product.taxGroupId ?? boot.settings.defaultTaxGroupId,
    priceIncludesTax: product.priceIncludesTax ?? boot.settings.pricesIncludeTax,
  };
}

/** Whether two lines are the same item with the same choices. */
export const sameChoice = (a: LineChoice, b: LineChoice) =>
  a.productId === b.productId && a.variantId === b.variantId && a.modifierIds.slice().sort().join() === b.modifierIds.slice().sort().join();

const toLineDiscount = (discount: { type: 'PERCENT' | 'AMOUNT'; value: number; reason: string | null } | null): LineDiscount | null =>
  discount ? { type: discount.type, value: discount.value, reason: discount.reason ?? '' } : null;

/** The lines of an order as the server holds it. */
export function linesFromOrder(order: OrderDto): OrderLine[] {
  return order.items.map((item) => ({
    id: item.id, productId: item.productId, variantId: item.variantId, modifierIds: item.modifiers.map((m) => m.id),
    name: item.name, variantName: item.variantName, modifierNames: item.modifiers.map((m) => m.name),
    unitPricePaise: item.unitPricePaise, quantity: item.quantity, kotQuantity: item.kotQuantity, notes: item.notes ?? '',
    discount: toLineDiscount(item.discount), taxGroupId: item.taxGroupId, priceIncludesTax: item.priceIncludesTax,
  }));
}

/** The bill-level discount of an order as the server holds it. */
export const discountFromOrder = (order: OrderDto): LineDiscount | null => toLineDiscount(order.discount);

/** Totals for the screen, using the same arithmetic the server uses when the order is saved. */
export function linesBill(lines: OrderLine[], discount: LineDiscount | null, boot: PosBootstrap): Bill {
  const rates = new Map(boot.taxGroups.map((group) => [group.id, { gstRateBps: group.gstRateBps, cessRateBps: group.cessRateBps }]));
  const { settings } = boot;
  return computeBill({
    lines: lines.map((line) => ({
      id: line.id, quantity: line.quantity, unitPricePaise: line.unitPricePaise, priceIncludesTax: line.priceIncludesTax,
      tax: line.taxGroupId ? (rates.get(line.taxGroupId) ?? null) : null,
      discount: line.discount,
    })),
    discount,
    taxApplicable: settings.gstRegistration === 'REGULAR',
    interState: false,
    serviceChargeBps: settings.serviceChargeEnabled ? settings.serviceChargeBps : 0,
    serviceChargeTax: settings.defaultTaxGroupId ? (rates.get(settings.defaultTaxGroupId) ?? null) : null,
    roundOff: settings.roundOffMode,
  });
}

/** A discount in the shape a save request carries. */
export const discountInput = (discount: LineDiscount | null) => (discount ? { type: discount.type, value: discount.value, reason: discount.reason || null } : null);

/** The lines in the shape a save request carries. */
export const lineInputs = (lines: OrderLine[]): OrderItemInput[] =>
  lines.map((line) => ({
    id: line.id, productId: line.productId, variantId: line.variantId, modifierIds: line.modifierIds, quantity: line.quantity,
    notes: line.notes || null, discount: discountInput(line.discount),
  }));
