import { z } from 'zod';
import { bpsSchema, isoDateSchema, nullableText, pageQuerySchema, paiseSchema, uuidSchema } from './common.js';
import { customerInputSchema, discountInputSchema, orderTypeSchema, paymentMethodSchema } from './orders.js';
/*
 * Uploading the work a device did while the internet was down. The device keeps each order, kitchen ticket, bill and
 * payment it makes offline as an operation in an outbox, and sends them in the order they happened. The server
 * applies each exactly once (by the operation's id) and stores bills as they were printed: a bill the guest already
 * holds is never refused. Anything that does not add up is stored anyway and flagged for the owner to check.
 */
/** A moment as the device's clock gave it, with its offset: "2026-11-25T13:05:00.000+05:30". */
const instantSchema = z.iso.datetime({ offset: true });
/** Paise that may be negative: the round-off. */
const signedPaiseSchema = z.number().int().min(-2_000_000_000).max(2_000_000_000);
const nameSchema = (max) => z.string().trim().min(1).max(max);
const optionalSchema = (max) => z.string().trim().max(max).nullable();
/** One line of an order as the device priced it, from the menu it had. */
export const offlineOrderItemSchema = z.object({
    id: uuidSchema,
    productId: uuidSchema,
    variantId: uuidSchema.nullable(),
    modifiers: z.array(z.object({ modifierId: uuidSchema, name: nameSchema(120), pricePaise: paiseSchema })).max(20),
    name: nameSchema(200),
    variantName: optionalSchema(120),
    hsnSac: optionalSchema(8),
    taxGroupId: uuidSchema.nullable(),
    /** The rates the device priced the line with. */
    gstRateBps: bpsSchema,
    cessRateBps: bpsSchema,
    priceIncludesTax: z.boolean(),
    stationId: uuidSchema.nullable(),
    /** One unit with its modifiers. */
    unitPricePaise: paiseSchema,
    quantity: z.number().int().min(1).max(999),
    /** How many of them the kitchen has been sent. */
    kotQuantity: z.number().int().min(0).max(999),
    notes: nullableText(200),
    discount: discountInputSchema.nullable(),
});
/** An order as it stands on the device: sent again, whole, each time it changes. Started on the device, offline. */
export const offlineOrderSchema = z.object({
    id: uuidSchema,
    type: orderTypeSchema,
    /** Its number in the device's own series (the token), for the period its business date falls in. */
    orderNumber: z.number().int().min(1).max(999_999),
    businessDate: isoDateSchema,
    guests: z.number().int().min(1).max(99),
    notes: nullableText(300),
    deliveryAddress: nullableText(300),
    customer: customerInputSchema.nullable(),
    items: z.array(offlineOrderItemSchema).max(200),
    discount: discountInputSchema.nullable(),
});
/** A kitchen ticket printed on the device. It goes in as done: the kitchen already worked from the paper. */
export const offlineKotSchema = z.object({
    id: uuidSchema,
    orderId: uuidSchema,
    stationId: uuidSchema.nullable(),
    type: z.enum(['NEW', 'CANCEL']),
    /** The number printed on the ticket. */
    printedNumber: nameSchema(20),
    businessDate: isoDateSchema,
    notes: nullableText(200),
    items: z.array(z.object({ orderItemId: uuidSchema.nullable(), name: nameSchema(300), quantity: z.number().int().min(1).max(999), notes: nullableText(200) })).min(1).max(200),
});
export const sellerSnapshotSchema = z.object({
    name: nameSchema(200),
    legalName: optionalSchema(200),
    gstin: optionalSchema(15),
    fssaiNumber: optionalSchema(20),
    phone: optionalSchema(20),
    addressLines: z.array(z.string().trim().max(300)).max(5),
    stateCode: z.string().trim().length(2),
    stateName: nameSchema(60),
    footer: optionalSchema(500),
    upiVpa: optionalSchema(100),
});
/** A bill exactly as it was printed on the device: its number in the device's series, and every amount on it. */
export const offlineInvoiceSchema = z.object({
    id: uuidSchema,
    orderId: uuidSchema,
    number: z.number().int().min(1).max(999_999),
    /** As printed: the device's code, the financial year and the number, "Z01/2627/000004". */
    invoiceNumber: nameSchema(16),
    businessDate: isoDateSchema,
    issuedAt: instantSchema,
    docType: z.enum(['TAX_INVOICE', 'BILL_OF_SUPPLY']),
    seller: sellerSnapshotSchema,
    customer: z.object({ name: optionalSchema(80), phone: optionalSchema(20), address: optionalSchema(300) }).nullable(),
    /** The service charge rate the device applied, for checking the bill. */
    serviceChargeBps: bpsSchema,
    printCount: z.number().int().min(0).max(1000),
    grossPaise: paiseSchema,
    discountPaise: paiseSchema,
    taxablePaise: paiseSchema,
    cgstPaise: paiseSchema,
    sgstPaise: paiseSchema,
    igstPaise: paiseSchema,
    cessPaise: paiseSchema,
    serviceChargePaise: paiseSchema,
    roundOffPaise: signedPaiseSchema,
    totalPaise: paiseSchema,
    items: z.array(z.object({
        orderItemId: uuidSchema,
        name: nameSchema(300),
        hsnSac: optionalSchema(8),
        quantity: z.number().int().min(1).max(999),
        unitPricePaise: paiseSchema,
        priceIncludesTax: z.boolean(),
        grossPaise: paiseSchema,
        /** The line's own discount and its share of the bill discount. */
        discountPaise: paiseSchema,
        taxablePaise: paiseSchema,
        taxRateBps: bpsSchema,
        cessRateBps: bpsSchema,
        cgstPaise: paiseSchema,
        sgstPaise: paiseSchema,
        igstPaise: paiseSchema,
        cessPaise: paiseSchema,
        totalPaise: paiseSchema,
    })).min(1).max(200),
    taxes: z.array(z.object({ type: z.enum(['CGST', 'SGST', 'IGST', 'CESS']), rateBps: bpsSchema, taxablePaise: paiseSchema, amountPaise: paiseSchema })).max(50),
});
/** Money taken on the device against a bill. The id is the same kind the POS sends online, so it is never counted twice. */
export const offlinePaymentSchema = z.object({
    id: uuidSchema,
    invoiceId: uuidSchema,
    method: paymentMethodSchema,
    amountPaise: paiseSchema.min(1),
    tenderedPaise: paiseSchema.nullable(),
    reference: nullableText(60),
    paidAt: instantSchema,
    businessDate: isoDateSchema,
    /** The cash register that was open on the device, if any. */
    registerSessionId: uuidSchema.nullable(),
});
const operationBase = {
    /** Chosen by the device: sending it again never applies it twice. */
    id: uuidSchema,
    /** Who did it: the person signed in on the device at the time. */
    userId: uuidSchema,
    /** When, by the device's clock. */
    createdAt: instantSchema,
};
export const syncOperationSchema = z.discriminatedUnion('type', [
    z.object({ ...operationBase, type: z.literal('order.save'), order: offlineOrderSchema }),
    z.object({ ...operationBase, type: z.literal('kot.print'), kot: offlineKotSchema }),
    z.object({ ...operationBase, type: z.literal('invoice.issue'), invoice: offlineInvoiceSchema }),
    z.object({ ...operationBase, type: z.literal('payment.record'), payment: offlinePaymentSchema }),
]);
/**
 * A batch of operations from one device, oldest first. Only the envelope is checked here: each operation is checked on
 * its own, so one the server cannot read is set aside for the owner instead of holding back the rest.
 */
export const syncPushSchema = z.object({
    deviceKey: uuidSchema,
    /** How many operations the device still holds after this batch. */
    pending: z.number().int().min(0).max(1_000_000).default(0),
    operations: z.array(z.looseObject({ id: uuidSchema })).min(1).max(25),
});
export const syncReviewQuerySchema = pageQuerySchema.extend({
    /** "open": still to be checked; "checked": marked checked; "all". */
    status: z.enum(['open', 'checked', 'all']).default('open'),
});
export const checkSyncReviewSchema = z.object({ note: nullableText(300) });
//# sourceMappingURL=sync.js.map