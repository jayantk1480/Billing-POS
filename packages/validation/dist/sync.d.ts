import { z } from 'zod';
/** One line of an order as the device priced it, from the menu it had. */
export declare const offlineOrderItemSchema: z.ZodObject<{
    id: z.ZodUUID;
    productId: z.ZodUUID;
    variantId: z.ZodNullable<z.ZodUUID>;
    modifiers: z.ZodArray<z.ZodObject<{
        modifierId: z.ZodUUID;
        name: z.ZodString;
        pricePaise: z.ZodNumber;
    }, z.core.$strip>>;
    name: z.ZodString;
    variantName: z.ZodNullable<z.ZodString>;
    hsnSac: z.ZodNullable<z.ZodString>;
    taxGroupId: z.ZodNullable<z.ZodUUID>;
    gstRateBps: z.ZodNumber;
    cessRateBps: z.ZodNumber;
    priceIncludesTax: z.ZodBoolean;
    stationId: z.ZodNullable<z.ZodUUID>;
    unitPricePaise: z.ZodNumber;
    quantity: z.ZodNumber;
    kotQuantity: z.ZodNumber;
    notes: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    discount: z.ZodNullable<z.ZodObject<{
        type: z.ZodEnum<{
            PERCENT: "PERCENT";
            AMOUNT: "AMOUNT";
        }>;
        value: z.ZodNumber;
        reason: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** An order as it stands on the device: sent again, whole, each time it changes. Started on the device, offline. */
export declare const offlineOrderSchema: z.ZodObject<{
    id: z.ZodUUID;
    type: z.ZodEnum<{
        DINE_IN: "DINE_IN";
        TAKEAWAY: "TAKEAWAY";
        DELIVERY: "DELIVERY";
    }>;
    orderNumber: z.ZodNumber;
    businessDate: z.ZodString;
    guests: z.ZodNumber;
    notes: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    deliveryAddress: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    customer: z.ZodNullable<z.ZodObject<{
        phone: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
        name: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
        address: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    }, z.core.$strip>>;
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
        productId: z.ZodUUID;
        variantId: z.ZodNullable<z.ZodUUID>;
        modifiers: z.ZodArray<z.ZodObject<{
            modifierId: z.ZodUUID;
            name: z.ZodString;
            pricePaise: z.ZodNumber;
        }, z.core.$strip>>;
        name: z.ZodString;
        variantName: z.ZodNullable<z.ZodString>;
        hsnSac: z.ZodNullable<z.ZodString>;
        taxGroupId: z.ZodNullable<z.ZodUUID>;
        gstRateBps: z.ZodNumber;
        cessRateBps: z.ZodNumber;
        priceIncludesTax: z.ZodBoolean;
        stationId: z.ZodNullable<z.ZodUUID>;
        unitPricePaise: z.ZodNumber;
        quantity: z.ZodNumber;
        kotQuantity: z.ZodNumber;
        notes: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
        discount: z.ZodNullable<z.ZodObject<{
            type: z.ZodEnum<{
                PERCENT: "PERCENT";
                AMOUNT: "AMOUNT";
            }>;
            value: z.ZodNumber;
            reason: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    discount: z.ZodNullable<z.ZodObject<{
        type: z.ZodEnum<{
            PERCENT: "PERCENT";
            AMOUNT: "AMOUNT";
        }>;
        value: z.ZodNumber;
        reason: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** A kitchen ticket printed on the device. It goes in as done: the kitchen already worked from the paper. */
export declare const offlineKotSchema: z.ZodObject<{
    id: z.ZodUUID;
    orderId: z.ZodUUID;
    stationId: z.ZodNullable<z.ZodUUID>;
    type: z.ZodEnum<{
        NEW: "NEW";
        CANCEL: "CANCEL";
    }>;
    printedNumber: z.ZodString;
    businessDate: z.ZodString;
    notes: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    items: z.ZodArray<z.ZodObject<{
        orderItemId: z.ZodNullable<z.ZodUUID>;
        name: z.ZodString;
        quantity: z.ZodNumber;
        notes: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const sellerSnapshotSchema: z.ZodObject<{
    name: z.ZodString;
    legalName: z.ZodNullable<z.ZodString>;
    gstin: z.ZodNullable<z.ZodString>;
    fssaiNumber: z.ZodNullable<z.ZodString>;
    phone: z.ZodNullable<z.ZodString>;
    addressLines: z.ZodArray<z.ZodString>;
    stateCode: z.ZodString;
    stateName: z.ZodString;
    footer: z.ZodNullable<z.ZodString>;
    upiVpa: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/** A bill exactly as it was printed on the device: its number in the device's series, and every amount on it. */
export declare const offlineInvoiceSchema: z.ZodObject<{
    id: z.ZodUUID;
    orderId: z.ZodUUID;
    number: z.ZodNumber;
    invoiceNumber: z.ZodString;
    businessDate: z.ZodString;
    issuedAt: z.ZodISODateTime;
    docType: z.ZodEnum<{
        TAX_INVOICE: "TAX_INVOICE";
        BILL_OF_SUPPLY: "BILL_OF_SUPPLY";
    }>;
    seller: z.ZodObject<{
        name: z.ZodString;
        legalName: z.ZodNullable<z.ZodString>;
        gstin: z.ZodNullable<z.ZodString>;
        fssaiNumber: z.ZodNullable<z.ZodString>;
        phone: z.ZodNullable<z.ZodString>;
        addressLines: z.ZodArray<z.ZodString>;
        stateCode: z.ZodString;
        stateName: z.ZodString;
        footer: z.ZodNullable<z.ZodString>;
        upiVpa: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    customer: z.ZodNullable<z.ZodObject<{
        name: z.ZodNullable<z.ZodString>;
        phone: z.ZodNullable<z.ZodString>;
        address: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    serviceChargeBps: z.ZodNumber;
    printCount: z.ZodNumber;
    grossPaise: z.ZodNumber;
    discountPaise: z.ZodNumber;
    taxablePaise: z.ZodNumber;
    cgstPaise: z.ZodNumber;
    sgstPaise: z.ZodNumber;
    igstPaise: z.ZodNumber;
    cessPaise: z.ZodNumber;
    serviceChargePaise: z.ZodNumber;
    roundOffPaise: z.ZodNumber;
    totalPaise: z.ZodNumber;
    items: z.ZodArray<z.ZodObject<{
        orderItemId: z.ZodUUID;
        name: z.ZodString;
        hsnSac: z.ZodNullable<z.ZodString>;
        quantity: z.ZodNumber;
        unitPricePaise: z.ZodNumber;
        priceIncludesTax: z.ZodBoolean;
        grossPaise: z.ZodNumber;
        discountPaise: z.ZodNumber;
        taxablePaise: z.ZodNumber;
        taxRateBps: z.ZodNumber;
        cessRateBps: z.ZodNumber;
        cgstPaise: z.ZodNumber;
        sgstPaise: z.ZodNumber;
        igstPaise: z.ZodNumber;
        cessPaise: z.ZodNumber;
        totalPaise: z.ZodNumber;
    }, z.core.$strip>>;
    taxes: z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<{
            CGST: "CGST";
            SGST: "SGST";
            IGST: "IGST";
            CESS: "CESS";
        }>;
        rateBps: z.ZodNumber;
        taxablePaise: z.ZodNumber;
        amountPaise: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** Money taken on the device against a bill. The id is the same kind the POS sends online, so it is never counted twice. */
export declare const offlinePaymentSchema: z.ZodObject<{
    id: z.ZodUUID;
    invoiceId: z.ZodUUID;
    method: z.ZodEnum<{
        CASH: "CASH";
        UPI: "UPI";
        CARD: "CARD";
        OTHER: "OTHER";
    }>;
    amountPaise: z.ZodNumber;
    tenderedPaise: z.ZodNullable<z.ZodNumber>;
    reference: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    paidAt: z.ZodISODateTime;
    businessDate: z.ZodString;
    registerSessionId: z.ZodNullable<z.ZodUUID>;
}, z.core.$strip>;
export declare const syncOperationSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"order.save">;
    order: z.ZodObject<{
        id: z.ZodUUID;
        type: z.ZodEnum<{
            DINE_IN: "DINE_IN";
            TAKEAWAY: "TAKEAWAY";
            DELIVERY: "DELIVERY";
        }>;
        orderNumber: z.ZodNumber;
        businessDate: z.ZodString;
        guests: z.ZodNumber;
        notes: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
        deliveryAddress: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
        customer: z.ZodNullable<z.ZodObject<{
            phone: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
            name: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
            address: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
        }, z.core.$strip>>;
        items: z.ZodArray<z.ZodObject<{
            id: z.ZodUUID;
            productId: z.ZodUUID;
            variantId: z.ZodNullable<z.ZodUUID>;
            modifiers: z.ZodArray<z.ZodObject<{
                modifierId: z.ZodUUID;
                name: z.ZodString;
                pricePaise: z.ZodNumber;
            }, z.core.$strip>>;
            name: z.ZodString;
            variantName: z.ZodNullable<z.ZodString>;
            hsnSac: z.ZodNullable<z.ZodString>;
            taxGroupId: z.ZodNullable<z.ZodUUID>;
            gstRateBps: z.ZodNumber;
            cessRateBps: z.ZodNumber;
            priceIncludesTax: z.ZodBoolean;
            stationId: z.ZodNullable<z.ZodUUID>;
            unitPricePaise: z.ZodNumber;
            quantity: z.ZodNumber;
            kotQuantity: z.ZodNumber;
            notes: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
            discount: z.ZodNullable<z.ZodObject<{
                type: z.ZodEnum<{
                    PERCENT: "PERCENT";
                    AMOUNT: "AMOUNT";
                }>;
                value: z.ZodNumber;
                reason: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        discount: z.ZodNullable<z.ZodObject<{
            type: z.ZodEnum<{
                PERCENT: "PERCENT";
                AMOUNT: "AMOUNT";
            }>;
            value: z.ZodNumber;
            reason: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    id: z.ZodUUID;
    userId: z.ZodUUID;
    createdAt: z.ZodISODateTime;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"kot.print">;
    kot: z.ZodObject<{
        id: z.ZodUUID;
        orderId: z.ZodUUID;
        stationId: z.ZodNullable<z.ZodUUID>;
        type: z.ZodEnum<{
            NEW: "NEW";
            CANCEL: "CANCEL";
        }>;
        printedNumber: z.ZodString;
        businessDate: z.ZodString;
        notes: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
        items: z.ZodArray<z.ZodObject<{
            orderItemId: z.ZodNullable<z.ZodUUID>;
            name: z.ZodString;
            quantity: z.ZodNumber;
            notes: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    id: z.ZodUUID;
    userId: z.ZodUUID;
    createdAt: z.ZodISODateTime;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"invoice.issue">;
    invoice: z.ZodObject<{
        id: z.ZodUUID;
        orderId: z.ZodUUID;
        number: z.ZodNumber;
        invoiceNumber: z.ZodString;
        businessDate: z.ZodString;
        issuedAt: z.ZodISODateTime;
        docType: z.ZodEnum<{
            TAX_INVOICE: "TAX_INVOICE";
            BILL_OF_SUPPLY: "BILL_OF_SUPPLY";
        }>;
        seller: z.ZodObject<{
            name: z.ZodString;
            legalName: z.ZodNullable<z.ZodString>;
            gstin: z.ZodNullable<z.ZodString>;
            fssaiNumber: z.ZodNullable<z.ZodString>;
            phone: z.ZodNullable<z.ZodString>;
            addressLines: z.ZodArray<z.ZodString>;
            stateCode: z.ZodString;
            stateName: z.ZodString;
            footer: z.ZodNullable<z.ZodString>;
            upiVpa: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>;
        customer: z.ZodNullable<z.ZodObject<{
            name: z.ZodNullable<z.ZodString>;
            phone: z.ZodNullable<z.ZodString>;
            address: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>;
        serviceChargeBps: z.ZodNumber;
        printCount: z.ZodNumber;
        grossPaise: z.ZodNumber;
        discountPaise: z.ZodNumber;
        taxablePaise: z.ZodNumber;
        cgstPaise: z.ZodNumber;
        sgstPaise: z.ZodNumber;
        igstPaise: z.ZodNumber;
        cessPaise: z.ZodNumber;
        serviceChargePaise: z.ZodNumber;
        roundOffPaise: z.ZodNumber;
        totalPaise: z.ZodNumber;
        items: z.ZodArray<z.ZodObject<{
            orderItemId: z.ZodUUID;
            name: z.ZodString;
            hsnSac: z.ZodNullable<z.ZodString>;
            quantity: z.ZodNumber;
            unitPricePaise: z.ZodNumber;
            priceIncludesTax: z.ZodBoolean;
            grossPaise: z.ZodNumber;
            discountPaise: z.ZodNumber;
            taxablePaise: z.ZodNumber;
            taxRateBps: z.ZodNumber;
            cessRateBps: z.ZodNumber;
            cgstPaise: z.ZodNumber;
            sgstPaise: z.ZodNumber;
            igstPaise: z.ZodNumber;
            cessPaise: z.ZodNumber;
            totalPaise: z.ZodNumber;
        }, z.core.$strip>>;
        taxes: z.ZodArray<z.ZodObject<{
            type: z.ZodEnum<{
                CGST: "CGST";
                SGST: "SGST";
                IGST: "IGST";
                CESS: "CESS";
            }>;
            rateBps: z.ZodNumber;
            taxablePaise: z.ZodNumber;
            amountPaise: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    id: z.ZodUUID;
    userId: z.ZodUUID;
    createdAt: z.ZodISODateTime;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"payment.record">;
    payment: z.ZodObject<{
        id: z.ZodUUID;
        invoiceId: z.ZodUUID;
        method: z.ZodEnum<{
            CASH: "CASH";
            UPI: "UPI";
            CARD: "CARD";
            OTHER: "OTHER";
        }>;
        amountPaise: z.ZodNumber;
        tenderedPaise: z.ZodNullable<z.ZodNumber>;
        reference: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
        paidAt: z.ZodISODateTime;
        businessDate: z.ZodString;
        registerSessionId: z.ZodNullable<z.ZodUUID>;
    }, z.core.$strip>;
    id: z.ZodUUID;
    userId: z.ZodUUID;
    createdAt: z.ZodISODateTime;
}, z.core.$strip>], "type">;
export type SyncOperationInput = z.input<typeof syncOperationSchema>;
export type SyncOperationType = z.infer<typeof syncOperationSchema>['type'];
/**
 * A batch of operations from one device, oldest first. Only the envelope is checked here: each operation is checked on
 * its own, so one the server cannot read is set aside for the owner instead of holding back the rest.
 */
export declare const syncPushSchema: z.ZodObject<{
    deviceKey: z.ZodUUID;
    pending: z.ZodDefault<z.ZodNumber>;
    operations: z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
    }, z.core.$loose>>;
}, z.core.$strip>;
export type SyncPushInput = z.input<typeof syncPushSchema>;
/** Something about an uploaded operation the owner should look at. */
export interface SyncFlagDto {
    code: string;
    message: string;
}
/**
 * What became of one operation. APPLIED and DUPLICATE (sent before) are done with. REJECTED will never apply; it is
 * kept for the owner. DEFERRED waits for something not yet uploaded, or for the server: send it again later, and
 * nothing after it in the same batch was tried.
 */
export type SyncOutcome = 'APPLIED' | 'DUPLICATE' | 'DEFERRED' | 'REJECTED';
export interface SyncResultDto {
    id: string;
    outcome: SyncOutcome;
    code: string | null;
    message: string | null;
    flags: SyncFlagDto[];
}
/** Where the device's own series stand on the server, so a device that lost its storage carries on without clashing. */
export interface DeviceNumbersDto {
    offlineCode: string;
    financialYear: string;
    nextInvoiceNumber: number;
    /** The order number period today, as in the bootstrap's settings and epoch. */
    numberPeriod: string;
    nextOrderNumber: number;
}
export interface SyncPushResponse {
    results: SyncResultDto[];
    numbers: DeviceNumbersDto;
}
export declare const syncReviewQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    pageSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    status: z.ZodDefault<z.ZodEnum<{
        open: "open";
        checked: "checked";
        all: "all";
    }>>;
}, z.core.$strip>;
export type SyncReviewQuery = z.input<typeof syncReviewQuerySchema>;
export declare const checkSyncReviewSchema: z.ZodObject<{
    note: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
}, z.core.$strip>;
export type CheckSyncReviewInput = z.input<typeof checkSyncReviewSchema>;
/** An uploaded operation that needs a look: it was stored with flags, or could not be stored at all. */
export interface SyncReviewDto {
    id: string;
    type: string;
    status: 'APPLIED' | 'REJECTED';
    /** Why it could not be stored, for a rejected one. */
    error: string | null;
    flags: SyncFlagDto[];
    deviceCode: string;
    deviceLabel: string | null;
    userName: string | null;
    uploadedByName: string | null;
    /** When it happened on the device, and when it arrived. */
    happenedAt: string;
    uploadedAt: string;
    orderId: string | null;
    invoiceId: string | null;
    /** What it was, as people would say it: "Bill Z01/2627/000004 · ₹540.00". */
    summary: string;
    reviewedAt: string | null;
    reviewedByName: string | null;
}
//# sourceMappingURL=sync.d.ts.map