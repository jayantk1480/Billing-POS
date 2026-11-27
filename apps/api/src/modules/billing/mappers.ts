import { amountInWords } from '@pos/billing-core';
import type { Prisma } from '@pos/database';
import { GST_STATES } from '@pos/types';
import type {
  CustomerDto, DiscountDto, InvoiceDto, InvoiceListItemDto, InvoiceSummaryDto, OrderDto, OrderSummaryDto, SellerDto,
} from '@pos/validation';
import { fromDate } from './billing-context.js';

/** The methods of the payments that went through on a bill. */
const paidWith = { payments: { where: { status: 'SUCCESS' }, select: { method: true } } } satisfies Prisma.InvoiceInclude;
const METHOD_ORDER = ['CASH', 'UPI', 'CARD', 'OTHER'] as const;

export const orderInclude = {
  items: { orderBy: { sortOrder: 'asc' }, include: { modifiers: true, discounts: true } },
  discounts: { where: { orderItemId: null } },
  table: { select: { name: true } },
  customer: true,
  createdBy: { select: { name: true } },
  invoices: { orderBy: { createdAt: 'asc' }, include: paidWith },
} satisfies Prisma.OrderInclude;
export type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export const orderSummaryInclude = {
  table: { select: { name: true } },
  customer: { select: { name: true, phone: true } },
  createdBy: { select: { name: true } },
  invoices: { orderBy: { createdAt: 'asc' }, include: paidWith },
  _count: { select: { items: true } },
} satisfies Prisma.OrderInclude;
export type OrderSummaryRow = Prisma.OrderGetPayload<{ include: typeof orderSummaryInclude }>;

export const invoiceInclude = {
  items: { orderBy: { sortOrder: 'asc' }, include: { refundItems: true } },
  taxes: true,
  payments: { orderBy: { createdAt: 'asc' } },
  refunds: { orderBy: { createdAt: 'asc' } },
  order: { select: { series: true, orderNumber: true, type: true, tokenNumber: true, table: { select: { name: true } } } },
} satisfies Prisma.InvoiceInclude;
export type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>;

type DiscountRow = Prisma.DiscountGetPayload<object>;
const toDiscountDto = (row: DiscountRow | undefined): DiscountDto | null =>
  row ? { type: row.type, value: row.value, reason: row.reason, amountPaise: row.amountPaise } : null;

// An order's customer carries no GSTIN; the field is there for bills issued before GSTINs were taken off customers.
const toCustomerDto = (c: { name: string | null; phone: string | null; address: string | null } | null): CustomerDto | null =>
  c ? { name: c.name, phone: c.phone, gstin: null, address: c.address } : null;

export const displayNumber = (order: { series: string; orderNumber: number }) => `${order.series}-${order.orderNumber}`;

type InvoiceSummaryRow = Pick<Prisma.InvoiceGetPayload<object>, 'id' | 'invoiceNumber' | 'status' | 'paymentStatus' | 'totalPaise' | 'paidPaise' | 'refundedPaise'>;
export const toInvoiceSummary = (i: InvoiceSummaryRow): InvoiceSummaryDto => ({
  id: i.id, invoiceNumber: i.invoiceNumber, status: i.status, paymentStatus: i.paymentStatus,
  totalPaise: i.totalPaise, paidPaise: i.paidPaise, refundedPaise: i.refundedPaise,
});

function orderBase(order: OrderRow | OrderSummaryRow) {
  return {
    id: order.id,
    displayNumber: displayNumber(order),
    series: order.series,
    orderNumber: order.orderNumber,
    tokenNumber: order.tokenNumber,
    businessDate: fromDate(order.businessDate),
    type: order.type,
    status: order.status,
    tableId: order.tableId,
    tableName: order.table?.name ?? null,
    guests: order.guests,
    notes: order.notes,
    deliveryAddress: order.deliveryAddress,
    totals: {
      grossPaise: order.subtotalPaise,
      discountPaise: order.discountPaise,
      taxPaise: order.taxPaise,
      serviceChargePaise: order.serviceChargePaise,
      roundOffPaise: order.roundOffPaise,
      totalPaise: order.totalPaise,
    },
    invoices: order.invoices.map(toInvoiceSummary),
    // A cancelled bill's payment was refunded, so it no longer says how the order was paid.
    paymentMethods: METHOD_ORDER.filter((method) => order.invoices.some((invoice) => invoice.status !== 'CANCELLED' && invoice.payments.some((payment) => payment.method === method))),
    createdByName: order.createdBy.name,
    cancelReason: order.cancelReason,
    version: order.version,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

export function toOrderDto(order: OrderRow): OrderDto {
  return {
    ...orderBase(order),
    customer: toCustomerDto(order.customer),
    discount: toDiscountDto(order.discounts[0]),
    items: order.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      variantId: item.variantId,
      name: item.name,
      variantName: item.variantName,
      modifiers: item.modifiers.map((m) => ({ id: m.modifierId, name: m.name, pricePaise: m.pricePaise })),
      quantity: item.quantity,
      kotQuantity: item.kotQuantity,
      unitPricePaise: item.unitPricePaise,
      notes: item.notes,
      taxGroupId: item.taxGroupId,
      priceIncludesTax: item.priceIncludesTax,
      discount: toDiscountDto(item.discounts[0]),
      grossPaise: item.grossPaise,
      discountPaise: item.discountPaise,
      taxablePaise: item.taxablePaise,
      taxPaise: item.taxPaise,
      totalPaise: item.totalPaise,
    })),
  };
}

export const toOrderSummary = (order: OrderSummaryRow): OrderSummaryDto => ({
  ...orderBase(order),
  itemCount: order._count.items,
  customerName: order.customer?.name ?? null,
  customerPhone: order.customer?.phone ?? null,
});

/** Who the bill is from: shared with the POS, which makes the same block for bills printed offline. */
export { buildSeller } from '@pos/printing';

export function toInvoiceDto(invoice: InvoiceRow, names: Map<string, string>): InvoiceDto {
  const name = (id: string) => names.get(id) ?? 'Unknown';
  return {
    ...toInvoiceSummary(invoice),
    orderId: invoice.orderId,
    orderDisplayNumber: displayNumber(invoice.order),
    orderType: invoice.order.type,
    tableName: invoice.order.table?.name ?? null,
    tokenNumber: invoice.order.tokenNumber,
    docType: invoice.docType,
    businessDate: fromDate(invoice.businessDate),
    issuedAt: invoice.issuedAt.toISOString(),
    seller: invoice.sellerSnapshot as unknown as SellerDto,
    customer: invoice.customerName || invoice.customerPhone
      ? { name: invoice.customerName, phone: invoice.customerPhone, gstin: invoice.customerGstin, address: invoice.customerAddress }
      : null,
    placeOfSupply: invoice.placeOfSupply,
    placeOfSupplyName: GST_STATES[invoice.placeOfSupply] ?? invoice.placeOfSupply,
    isInterState: invoice.isInterState,
    grossPaise: invoice.grossPaise,
    discountPaise: invoice.discountPaise,
    taxablePaise: invoice.taxablePaise,
    cgstPaise: invoice.cgstPaise,
    sgstPaise: invoice.sgstPaise,
    igstPaise: invoice.igstPaise,
    cessPaise: invoice.cessPaise,
    // total = gross − discount + service charge + tax added + round off
    taxAddedPaise: invoice.totalPaise - invoice.grossPaise + invoice.discountPaise - invoice.serviceChargePaise - invoice.roundOffPaise,
    serviceChargePaise: invoice.serviceChargePaise,
    roundOffPaise: invoice.roundOffPaise,
    amountInWords: amountInWords(invoice.totalPaise),
    printCount: invoice.printCount,
    cashierName: name(invoice.createdById),
    cancelReason: invoice.cancelReason,
    items: invoice.items.map((item) => ({
      id: item.id, name: item.name, hsnSac: item.hsnSac, quantity: item.quantity, unitPricePaise: item.unitPricePaise,
      grossPaise: item.grossPaise, discountPaise: item.discountPaise, taxablePaise: item.taxablePaise, taxRateBps: item.taxRateBps,
      cgstPaise: item.cgstPaise, sgstPaise: item.sgstPaise, igstPaise: item.igstPaise, cessPaise: item.cessPaise, totalPaise: item.totalPaise,
      refundedQuantity: item.refundItems.reduce((sum, refund) => sum + refund.quantity, 0),
    })),
    taxes: invoice.taxes
      .map((tax) => ({ type: tax.type, rateBps: tax.rateBps, taxablePaise: tax.taxablePaise, amountPaise: tax.amountPaise }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.rateBps - b.rateBps),
    payments: invoice.payments.map((p) => ({
      id: p.id, method: p.method, status: p.status, amountPaise: p.amountPaise, tenderedPaise: p.tenderedPaise, changePaise: p.changePaise,
      refundedPaise: p.refundedPaise, reference: p.reference, receivedByName: name(p.receivedById), paidAt: p.paidAt?.toISOString() ?? null,
    })),
    refunds: invoice.refunds.map((r) => ({
      id: r.id, creditNoteNumber: r.creditNoteNumber, paymentId: r.paymentId, method: r.method, amountPaise: r.amountPaise,
      reason: r.reason, createdByName: name(r.createdById), createdAt: r.createdAt.toISOString(),
    })),
  };
}

export const invoiceListInclude = {
  order: { select: { series: true, orderNumber: true, type: true } },
} satisfies Prisma.InvoiceInclude;
export type InvoiceListRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceListInclude }>;

export const toInvoiceListItem = (invoice: InvoiceListRow, names: Map<string, string>): InvoiceListItemDto => ({
  ...toInvoiceSummary(invoice),
  orderId: invoice.orderId,
  orderDisplayNumber: displayNumber(invoice.order),
  orderType: invoice.order.type,
  businessDate: fromDate(invoice.businessDate),
  issuedAt: invoice.issuedAt.toISOString(),
  customerName: invoice.customerName,
  customerPhone: invoice.customerPhone,
  cashierName: names.get(invoice.createdById) ?? 'Unknown',
});
