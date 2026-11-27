import { z } from 'zod';
import { type PaymentMethod } from './orders.js';
/** Notes and coins counted when a register is closed, in rupees, largest first. */
export declare const CASH_DENOMINATIONS: readonly [500, 200, 100, 50, 20, 10, 5, 2, 1];
export declare const openRegisterSchema: z.ZodObject<{
    openingCashPaise: z.ZodNumber;
}, z.core.$strip>;
export type OpenRegisterInput = z.input<typeof openRegisterSchema>;
export declare const cashMovementSchema: z.ZodObject<{
    type: z.ZodEnum<{
        CASH_IN: "CASH_IN";
        CASH_OUT: "CASH_OUT";
    }>;
    amountPaise: z.ZodNumber;
    reason: z.ZodString;
    approval: z.ZodOptional<z.ZodObject<{
        userId: z.ZodUUID;
        pin: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type CashMovementInput = z.input<typeof cashMovementSchema>;
export declare const closeRegisterSchema: z.ZodObject<{
    countedCashPaise: z.ZodNumber;
    denominations: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    notes: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
}, z.core.$strip>;
export type CloseRegisterInput = z.input<typeof closeRegisterSchema>;
export declare const registerQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    pageSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    from: z.ZodOptional<z.ZodString>;
    to: z.ZodOptional<z.ZodString>;
    userId: z.ZodOptional<z.ZodUUID>;
    status: z.ZodOptional<z.ZodEnum<{
        OPEN: "OPEN";
        CLOSED: "CLOSED";
    }>>;
    sort: z.ZodDefault<z.ZodEnum<{
        status: "status";
        expected: "expected";
        cashier: "cashier";
        opened: "opened";
        closed: "closed";
        terminal: "terminal";
        opening: "opening";
        counted: "counted";
        variance: "variance";
    }>>;
    direction: z.ZodDefault<z.ZodDefault<z.ZodEnum<{
        asc: "asc";
        desc: "desc";
    }>>>;
}, z.core.$strip>;
export type RegisterQuery = z.input<typeof registerQuerySchema>;
export interface RegisterSessionDto {
    id: string;
    status: 'OPEN' | 'CLOSED';
    businessDate: string;
    terminal: {
        id: string;
        code: string;
        name: string;
    } | null;
    user: {
        id: string;
        name: string;
    };
    openedAt: string;
    closedAt: string | null;
    closedByName: string | null;
    openingCashPaise: number;
    cashInPaise: number;
    cashOutPaise: number;
    /** Cash taken against bills while this register was open. */
    cashSalesPaise: number;
    /** Cash handed back as refunds from this register. */
    cashRefundsPaise: number;
    /** What should be in the drawer. For a closed register, as it stood when it was closed. */
    expectedCashPaise: number;
    countedCashPaise: number | null;
    /** Counted less expected: negative means cash is short. */
    variancePaise: number | null;
    denominations: Record<string, number> | null;
    closingNotes: string | null;
}
export interface RegisterDetailDto extends RegisterSessionDto {
    /** Everything taken while the register was open, by method. Only cash is in the drawer. */
    takings: {
        method: PaymentMethod;
        count: number;
        receivedPaise: number;
        refundedPaise: number;
    }[];
    movements: {
        id: string;
        type: 'CASH_IN' | 'CASH_OUT';
        amountPaise: number;
        reason: string | null;
        createdByName: string;
        createdAt: string;
    }[];
}
export declare const reconciliationQuerySchema: z.ZodObject<{
    from: z.ZodString;
    to: z.ZodString;
}, z.core.$strip>;
export type ReconciliationQuery = z.input<typeof reconciliationQuerySchema>;
export declare const saveReconciliationSchema: z.ZodObject<{
    businessDate: z.ZodString;
    method: z.ZodEnum<{
        CASH: "CASH";
        UPI: "UPI";
        CARD: "CARD";
        OTHER: "OTHER";
    }>;
    settledPaise: z.ZodNumber;
    note: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
}, z.core.$strip>;
export type SaveReconciliationInput = z.input<typeof saveReconciliationSchema>;
export interface ReconciliationRowDto {
    businessDate: string;
    method: PaymentMethod;
    count: number;
    receivedPaise: number;
    refundedPaise: number;
    /** Received less refunded: what the system says should have arrived. */
    netPaise: number;
    settledPaise: number | null;
    /** Settled less net, once a settled amount has been entered. */
    differencePaise: number | null;
    note: string | null;
    reconciledByName: string | null;
    reconciledAt: string | null;
    /** True when payments were added, refunded or changed after the settled amount was entered. */
    changedSince: boolean;
}
export interface ReconciliationDto {
    rows: ReconciliationRowDto[];
    /** Cash for the whole period, against the cash registers. */
    cash: {
        inRegistersPaise: number;
        outsideRegistersPaise: number;
        registerVariancePaise: number;
        registersClosed: number;
        registersOpen: number;
    };
}
export declare const paymentQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    pageSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    from: z.ZodString;
    to: z.ZodString;
    method: z.ZodOptional<z.ZodEnum<{
        CASH: "CASH";
        UPI: "UPI";
        CARD: "CARD";
        OTHER: "OTHER";
    }>>;
    registerSessionId: z.ZodOptional<z.ZodUUID>;
}, z.core.$strip>;
export type PaymentQuery = z.input<typeof paymentQuerySchema>;
export interface PaymentListItemDto {
    id: string;
    invoiceId: string;
    invoiceNumber: string;
    businessDate: string;
    method: PaymentMethod;
    amountPaise: number;
    refundedPaise: number;
    reference: string | null;
    receivedByName: string;
    paidAt: string | null;
    inRegister: boolean;
}
//# sourceMappingURL=registers.d.ts.map