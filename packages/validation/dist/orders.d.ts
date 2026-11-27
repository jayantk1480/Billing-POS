import { z } from 'zod';
export declare const orderTypeSchema: z.ZodEnum<{
    DINE_IN: "DINE_IN";
    TAKEAWAY: "TAKEAWAY";
    DELIVERY: "DELIVERY";
}>;
export type OrderType = z.infer<typeof orderTypeSchema>;
export declare const orderStatusSchema: z.ZodEnum<{
    OPEN: "OPEN";
    HELD: "HELD";
    BILLED: "BILLED";
    SETTLED: "SETTLED";
    CANCELLED: "CANCELLED";
    MERGED: "MERGED";
}>;
export type OrderStatus = z.infer<typeof orderStatusSchema>;
export declare const paymentMethodSchema: z.ZodEnum<{
    CASH: "CASH";
    UPI: "UPI";
    CARD: "CARD";
    OTHER: "OTHER";
}>;
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
export declare const discountInputSchema: z.ZodObject<{
    type: z.ZodEnum<{
        PERCENT: "PERCENT";
        AMOUNT: "AMOUNT";
    }>;
    value: z.ZodNumber;
    reason: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
}, z.core.$strip>;
export type DiscountInput = z.input<typeof discountInputSchema>;
/** A manager's sign-off for an action the signed-in user is not allowed to do alone. */
export declare const approvalSchema: z.ZodObject<{
    userId: z.ZodUUID;
    pin: z.ZodString;
}, z.core.$strip>;
export type ApprovalInput = z.infer<typeof approvalSchema>;
/** The mobile number is what identifies a customer: one number, one customer. The name is for the bill. */
export declare const customerInputSchema: z.ZodObject<{
    phone: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    name: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    address: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
}, z.core.$strip>;
export type CustomerInput = z.input<typeof customerInputSchema>;
export declare const orderItemInputSchema: z.ZodObject<{
    id: z.ZodUUID;
    productId: z.ZodUUID;
    variantId: z.ZodOptional<z.ZodNullable<z.ZodUUID>>;
    modifierIds: z.ZodDefault<z.ZodArray<z.ZodUUID>>;
    quantity: z.ZodNumber;
    notes: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    discount: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        type: z.ZodEnum<{
            PERCENT: "PERCENT";
            AMOUNT: "AMOUNT";
        }>;
        value: z.ZodNumber;
        reason: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type OrderItemInput = z.input<typeof orderItemInputSchema>;
export declare const saveOrderSchema: z.ZodObject<{
    type: z.ZodEnum<{
        DINE_IN: "DINE_IN";
        TAKEAWAY: "TAKEAWAY";
        DELIVERY: "DELIVERY";
    }>;
    tableId: z.ZodOptional<z.ZodNullable<z.ZodUUID>>;
    guests: z.ZodDefault<z.ZodNumber>;
    notes: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    deliveryAddress: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    customer: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        phone: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
        name: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
        address: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    }, z.core.$strip>>>;
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
        productId: z.ZodUUID;
        variantId: z.ZodOptional<z.ZodNullable<z.ZodUUID>>;
        modifierIds: z.ZodDefault<z.ZodArray<z.ZodUUID>>;
        quantity: z.ZodNumber;
        notes: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
        discount: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            type: z.ZodEnum<{
                PERCENT: "PERCENT";
                AMOUNT: "AMOUNT";
            }>;
            value: z.ZodNumber;
            reason: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
    discount: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        type: z.ZodEnum<{
            PERCENT: "PERCENT";
            AMOUNT: "AMOUNT";
        }>;
        value: z.ZodNumber;
        reason: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    }, z.core.$strip>>>;
    approval: z.ZodOptional<z.ZodObject<{
        userId: z.ZodUUID;
        pin: z.ZodString;
    }, z.core.$strip>>;
    kotCancelReason: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    version: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type SaveOrderInput = z.input<typeof saveOrderSchema>;
export declare const reasonSchema: z.ZodObject<{
    reason: z.ZodString;
    approval: z.ZodOptional<z.ZodObject<{
        userId: z.ZodUUID;
        pin: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ReasonInput = z.input<typeof reasonSchema>;
/** A change to an order that already has a bill: the new lines, and how the new total was paid. */
export declare const amendOrderSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
        productId: z.ZodUUID;
        variantId: z.ZodOptional<z.ZodNullable<z.ZodUUID>>;
        modifierIds: z.ZodDefault<z.ZodArray<z.ZodUUID>>;
        quantity: z.ZodNumber;
        notes: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
        discount: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            type: z.ZodEnum<{
                PERCENT: "PERCENT";
                AMOUNT: "AMOUNT";
            }>;
            value: z.ZodNumber;
            reason: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
    discount: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        type: z.ZodEnum<{
            PERCENT: "PERCENT";
            AMOUNT: "AMOUNT";
        }>;
        value: z.ZodNumber;
        reason: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    }, z.core.$strip>>>;
    payment: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodLiteral<"KEEP">, z.ZodObject<{
        method: z.ZodEnum<{
            CASH: "CASH";
            UPI: "UPI";
            CARD: "CARD";
            OTHER: "OTHER";
        }>;
        reference: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    }, z.core.$strip>]>>>;
    reason: z.ZodString;
    approval: z.ZodOptional<z.ZodObject<{
        userId: z.ZodUUID;
        pin: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type AmendOrderInput = z.input<typeof amendOrderSchema>;
export declare const mergeOrderSchema: z.ZodObject<{
    sourceOrderId: z.ZodUUID;
}, z.core.$strip>;
export declare const issueInvoicesSchema: z.ZodObject<{
    parts: z.ZodOptional<z.ZodArray<z.ZodArray<z.ZodObject<{
        orderItemId: z.ZodUUID;
        quantity: z.ZodNumber;
    }, z.core.$strip>>>>;
    placeOfSupply: z.ZodOptional<z.ZodString>;
    invoiceIds: z.ZodOptional<z.ZodArray<z.ZodUUID>>;
}, z.core.$strip>;
export type IssueInvoicesInput = z.input<typeof issueInvoicesSchema>;
export declare const paymentInputSchema: z.ZodObject<{
    id: z.ZodUUID;
    method: z.ZodEnum<{
        CASH: "CASH";
        UPI: "UPI";
        CARD: "CARD";
        OTHER: "OTHER";
    }>;
    amountPaise: z.ZodNumber;
    tenderedPaise: z.ZodOptional<z.ZodNumber>;
    reference: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
}, z.core.$strip>;
export type PaymentInput = z.input<typeof paymentInputSchema>;
export declare const recordPaymentsSchema: z.ZodObject<{
    payments: z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
        method: z.ZodEnum<{
            CASH: "CASH";
            UPI: "UPI";
            CARD: "CARD";
            OTHER: "OTHER";
        }>;
        amountPaise: z.ZodNumber;
        tenderedPaise: z.ZodOptional<z.ZodNumber>;
        reference: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type RecordPaymentsInput = z.input<typeof recordPaymentsSchema>;
export declare const refundInputSchema: z.ZodObject<{
    id: z.ZodUUID;
    paymentId: z.ZodUUID;
    amountPaise: z.ZodOptional<z.ZodNumber>;
    items: z.ZodOptional<z.ZodArray<z.ZodObject<{
        invoiceItemId: z.ZodUUID;
        quantity: z.ZodNumber;
    }, z.core.$strip>>>;
    reason: z.ZodString;
    approval: z.ZodOptional<z.ZodObject<{
        userId: z.ZodUUID;
        pin: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type RefundInput = z.input<typeof refundInputSchema>;
export declare const cancelInvoiceSchema: z.ZodObject<{
    reason: z.ZodString;
    reopenOrder: z.ZodDefault<z.ZodBoolean>;
    approval: z.ZodOptional<z.ZodObject<{
        userId: z.ZodUUID;
        pin: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type CancelInvoiceInput = z.input<typeof cancelInvoiceSchema>;
/** Correcting how a payment already recorded was made. The amount is not part of it. */
export declare const changePaymentMethodSchema: z.ZodObject<{
    method: z.ZodEnum<{
        CASH: "CASH";
        UPI: "UPI";
        CARD: "CARD";
        OTHER: "OTHER";
    }>;
    reference: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    reason: z.ZodString;
}, z.core.$strip>;
export type ChangePaymentMethodInput = z.input<typeof changePaymentMethodSchema>;
export declare const orderQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    pageSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    status: z.ZodOptional<z.ZodEnum<{
        OPEN: "OPEN";
        HELD: "HELD";
        BILLED: "BILLED";
        SETTLED: "SETTLED";
        CANCELLED: "CANCELLED";
        MERGED: "MERGED";
    }>>;
    type: z.ZodOptional<z.ZodEnum<{
        DINE_IN: "DINE_IN";
        TAKEAWAY: "TAKEAWAY";
        DELIVERY: "DELIVERY";
    }>>;
    from: z.ZodOptional<z.ZodString>;
    to: z.ZodOptional<z.ZodString>;
    search: z.ZodOptional<z.ZodString>;
    sort: z.ZodOptional<z.ZodEnum<{
        type: "type";
        date: "date";
        status: "status";
        order: "order";
        takenBy: "takenBy";
        bill: "bill";
        billingType: "billingType";
        total: "total";
    }>>;
    direction: z.ZodDefault<z.ZodEnum<{
        asc: "asc";
        desc: "desc";
    }>>;
}, z.core.$strip>;
export type OrderQuery = z.input<typeof orderQuerySchema>;
export declare const invoiceQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    pageSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    status: z.ZodOptional<z.ZodEnum<{
        CANCELLED: "CANCELLED";
        ISSUED: "ISSUED";
    }>>;
    paymentStatus: z.ZodOptional<z.ZodEnum<{
        UNPAID: "UNPAID";
        PARTIALLY_PAID: "PARTIALLY_PAID";
        PAID: "PAID";
        PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED";
        REFUNDED: "REFUNDED";
    }>>;
    from: z.ZodOptional<z.ZodString>;
    to: z.ZodOptional<z.ZodString>;
    search: z.ZodOptional<z.ZodString>;
    sort: z.ZodOptional<z.ZodEnum<{
        status: "status";
        customer: "customer";
        order: "order";
        bill: "bill";
        total: "total";
        issued: "issued";
        cashier: "cashier";
        paid: "paid";
    }>>;
    direction: z.ZodDefault<z.ZodEnum<{
        asc: "asc";
        desc: "desc";
    }>>;
}, z.core.$strip>;
export type InvoiceQuery = z.input<typeof invoiceQuerySchema>;
export interface DiscountDto {
    type: 'PERCENT' | 'AMOUNT';
    value: number;
    reason: string | null;
    amountPaise: number;
}
/**
 * The customer as an order or bill carries them. A bill issued before mobile numbers were required may have no number,
 * and one issued before GSTINs were taken off customers may carry one; new bills never do.
 */
export interface CustomerDto {
    name: string | null;
    phone: string | null;
    gstin: string | null;
    address: string | null;
}
export interface OrderItemDto {
    id: string;
    productId: string;
    variantId: string | null;
    name: string;
    variantName: string | null;
    modifiers: {
        id: string;
        name: string;
        pricePaise: number;
    }[];
    quantity: number;
    /** How many of these the kitchen has already been told about. */
    kotQuantity: number;
    unitPricePaise: number;
    notes: string | null;
    /** Needed by the POS to re-price the order locally while it is being edited. */
    taxGroupId: string | null;
    priceIncludesTax: boolean;
    discount: DiscountDto | null;
    grossPaise: number;
    discountPaise: number;
    taxablePaise: number;
    taxPaise: number;
    totalPaise: number;
}
export interface BillTotals {
    grossPaise: number;
    discountPaise: number;
    taxPaise: number;
    serviceChargePaise: number;
    roundOffPaise: number;
    totalPaise: number;
}
export interface InvoiceSummaryDto {
    id: string;
    invoiceNumber: string;
    status: 'ISSUED' | 'CANCELLED';
    paymentStatus: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
    totalPaise: number;
    paidPaise: number;
    refundedPaise: number;
}
export interface OrderDto {
    id: string;
    /** Display number such as "A1-12". Renumbered when an earlier unbilled order is deleted. */
    displayNumber: string;
    series: string;
    orderNumber: number;
    /** The number given to the customer when the order was taken. Never changes. */
    tokenNumber: number | null;
    businessDate: string;
    type: OrderType;
    status: OrderStatus;
    tableId: string | null;
    tableName: string | null;
    guests: number;
    notes: string | null;
    deliveryAddress: string | null;
    customer: CustomerDto | null;
    items: OrderItemDto[];
    discount: DiscountDto | null;
    totals: BillTotals;
    invoices: InvoiceSummaryDto[];
    /** How the order was paid: the methods of the payments on its bills, in a fixed order. Empty until money is taken. */
    paymentMethods: PaymentMethod[];
    createdByName: string;
    cancelReason: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
}
/** One row of an order list: everything except the lines. */
export type OrderSummaryDto = Omit<OrderDto, 'items' | 'discount' | 'customer'> & {
    itemCount: number;
    customerName: string | null;
    customerPhone: string | null;
};
export interface InvoiceItemDto {
    id: string;
    name: string;
    hsnSac: string | null;
    quantity: number;
    unitPricePaise: number;
    grossPaise: number;
    discountPaise: number;
    taxablePaise: number;
    taxRateBps: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    cessPaise: number;
    totalPaise: number;
    /** Quantity already returned through refunds. */
    refundedQuantity: number;
}
export interface PaymentDto {
    id: string;
    method: PaymentMethod;
    status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
    amountPaise: number;
    tenderedPaise: number | null;
    changePaise: number | null;
    refundedPaise: number;
    reference: string | null;
    receivedByName: string;
    paidAt: string | null;
}
export interface RefundDto {
    id: string;
    creditNoteNumber: string;
    paymentId: string | null;
    method: PaymentMethod;
    amountPaise: number;
    reason: string;
    createdByName: string;
    createdAt: string;
}
export interface SellerDto {
    name: string;
    legalName: string | null;
    gstin: string | null;
    fssaiNumber: string | null;
    phone: string | null;
    addressLines: string[];
    stateCode: string;
    stateName: string;
    footer: string | null;
    upiVpa: string | null;
}
export interface InvoiceDto extends InvoiceSummaryDto {
    orderId: string;
    orderDisplayNumber: string;
    orderType: OrderType;
    tableName: string | null;
    tokenNumber: number | null;
    docType: 'TAX_INVOICE' | 'BILL_OF_SUPPLY';
    businessDate: string;
    issuedAt: string;
    seller: SellerDto;
    customer: CustomerDto | null;
    placeOfSupply: string;
    placeOfSupplyName: string;
    isInterState: boolean;
    grossPaise: number;
    discountPaise: number;
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    cessPaise: number;
    /** Tax added on top of listed prices; zero when every price already included tax. */
    taxAddedPaise: number;
    serviceChargePaise: number;
    roundOffPaise: number;
    amountInWords: string;
    printCount: number;
    cashierName: string;
    cancelReason: string | null;
    items: InvoiceItemDto[];
    taxes: {
        type: 'CGST' | 'SGST' | 'IGST' | 'CESS';
        rateBps: number;
        taxablePaise: number;
        amountPaise: number;
    }[];
    payments: PaymentDto[];
    refunds: RefundDto[];
}
export type InvoiceListItemDto = InvoiceSummaryDto & {
    orderId: string;
    orderDisplayNumber: string;
    orderType: OrderType;
    businessDate: string;
    issuedAt: string;
    customerName: string | null;
    customerPhone: string | null;
    cashierName: string;
};
export interface TableDto {
    id: string;
    name: string;
    areaId: string;
    areaName: string;
    seats: number;
    status: 'FREE' | 'OCCUPIED' | 'BILL_PRINTED' | 'BLOCKED';
    shape: 'SQUARE' | 'ROUND' | 'RECTANGLE';
    /** Position and size on the floor plan, in layout units. */
    posX: number;
    posY: number;
    width: number;
    height: number;
    /** The running order at this table, if any. */
    orderId: string | null;
    orderDisplayNumber: string | null;
    orderTotalPaise: number | null;
}
export interface RenumberResult {
    /** Orders whose display number changed. */
    changes: {
        orderId: string;
        from: number;
        to: number;
    }[];
    /** How many bills and credit notes moved up to close a gap in their numbers. */
    bills: number;
}
//# sourceMappingURL=orders.d.ts.map