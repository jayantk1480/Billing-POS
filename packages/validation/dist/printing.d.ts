import { z } from 'zod';
export declare const printerRoleSchema: z.ZodEnum<{
    RECEIPT: "RECEIPT";
    KOT: "KOT";
}>;
/** BROWSER is a printer reached through the browser's print dialog at the counter, with no bridge. */
export declare const printerConnectionSchema: z.ZodEnum<{
    NETWORK: "NETWORK";
    USB: "USB";
    BLUETOOTH: "BLUETOOTH";
    BROWSER: "BROWSER";
}>;
export declare const paperWidthSchema: z.ZodEnum<{
    MM58: "MM58";
    MM80: "MM80";
}>;
export declare const printerSchema: z.ZodObject<{
    name: z.ZodString;
    role: z.ZodEnum<{
        RECEIPT: "RECEIPT";
        KOT: "KOT";
    }>;
    connection: z.ZodEnum<{
        NETWORK: "NETWORK";
        USB: "USB";
        BLUETOOTH: "BLUETOOTH";
        BROWSER: "BROWSER";
    }>;
    paperWidth: z.ZodDefault<z.ZodEnum<{
        MM58: "MM58";
        MM80: "MM80";
    }>>;
    host: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodPipe<z.ZodLiteral<"">, z.ZodTransform<null, "">>, z.ZodNull]>>;
    port: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    devicePath: z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
    isDefault: z.ZodDefault<z.ZodBoolean>;
    isActive: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type PrinterInput = z.input<typeof printerSchema>;
export declare const updatePrinterSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    role: z.ZodOptional<z.ZodEnum<{
        RECEIPT: "RECEIPT";
        KOT: "KOT";
    }>>;
    connection: z.ZodOptional<z.ZodEnum<{
        NETWORK: "NETWORK";
        USB: "USB";
        BLUETOOTH: "BLUETOOTH";
        BROWSER: "BROWSER";
    }>>;
    paperWidth: z.ZodOptional<z.ZodDefault<z.ZodEnum<{
        MM58: "MM58";
        MM80: "MM80";
    }>>>;
    host: z.ZodOptional<z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodPipe<z.ZodLiteral<"">, z.ZodTransform<null, "">>, z.ZodNull]>>>;
    port: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;
    devicePath: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>>;
    isDefault: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    isActive: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
}, z.core.$strip>;
export type UpdatePrinterInput = z.input<typeof updatePrinterSchema>;
export interface PrinterDto {
    id: string;
    name: string;
    role: z.infer<typeof printerRoleSchema>;
    connection: z.infer<typeof printerConnectionSchema>;
    paperWidth: z.infer<typeof paperWidthSchema>;
    host: string | null;
    port: number | null;
    devicePath: string | null;
    isDefault: boolean;
    isActive: boolean;
    /** "ok" or "error", from the last job sent to it. */
    lastStatus: string | null;
    lastError: string | null;
    lastSeenAt: string | null;
    /** Kitchen stations whose tickets print here. */
    stations: string[];
}
export declare const receiptLayoutSchema: z.ZodObject<{
    headerNote: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    showCustomer: z.ZodDefault<z.ZodBoolean>;
    showHsn: z.ZodDefault<z.ZodBoolean>;
    showTaxBreakup: z.ZodDefault<z.ZodBoolean>;
    showAmountInWords: z.ZodDefault<z.ZodBoolean>;
    showUpiQr: z.ZodDefault<z.ZodBoolean>;
    openDrawer: z.ZodDefault<z.ZodBoolean>;
    copies: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type ReceiptLayout = z.infer<typeof receiptLayoutSchema>;
export declare const kotLayoutSchema: z.ZodObject<{
    largeItems: z.ZodDefault<z.ZodBoolean>;
    showOrderedBy: z.ZodDefault<z.ZodBoolean>;
    copies: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type KotLayout = z.infer<typeof kotLayoutSchema>;
export declare const printLayoutsSchema: z.ZodObject<{
    receipt: z.ZodObject<{
        headerNote: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        showCustomer: z.ZodDefault<z.ZodBoolean>;
        showHsn: z.ZodDefault<z.ZodBoolean>;
        showTaxBreakup: z.ZodDefault<z.ZodBoolean>;
        showAmountInWords: z.ZodDefault<z.ZodBoolean>;
        showUpiQr: z.ZodDefault<z.ZodBoolean>;
        openDrawer: z.ZodDefault<z.ZodBoolean>;
        copies: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>;
    kot: z.ZodObject<{
        largeItems: z.ZodDefault<z.ZodBoolean>;
        showOrderedBy: z.ZodDefault<z.ZodBoolean>;
        copies: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const updatePrintLayoutsSchema: z.ZodObject<{
    receipt: z.ZodOptional<z.ZodObject<{
        headerNote: z.ZodOptional<z.ZodDefault<z.ZodNullable<z.ZodString>>>;
        showCustomer: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
        showHsn: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
        showTaxBreakup: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
        showAmountInWords: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
        showUpiQr: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
        openDrawer: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
        copies: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    }, z.core.$strip>>;
    kot: z.ZodOptional<z.ZodObject<{
        largeItems: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
        showOrderedBy: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
        copies: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type UpdatePrintLayoutsInput = z.input<typeof updatePrintLayoutsSchema>;
export interface PrintLayoutsDto {
    receipt: ReceiptLayout;
    kot: KotLayout;
}
export declare const createBridgeSchema: z.ZodObject<{
    name: z.ZodString;
}, z.core.$strip>;
export type CreateBridgeInput = z.input<typeof createBridgeSchema>;
export interface BridgeDto {
    id: string;
    name: string;
    version: string | null;
    lastSeenAt: string | null;
    /** Heard from in the last half minute. */
    online: boolean;
}
/** The token is shown once, when the bridge is added. Only its hash is stored. */
export interface BridgeCreatedDto extends BridgeDto {
    token: string;
}
export declare const printJobTypeSchema: z.ZodEnum<{
    RECEIPT: "RECEIPT";
    KOT: "KOT";
    CREDIT_NOTE: "CREDIT_NOTE";
    REGISTER_REPORT: "REGISTER_REPORT";
    TEST: "TEST";
}>;
export declare const printJobStatusSchema: z.ZodEnum<{
    FAILED: "FAILED";
    QUEUED: "QUEUED";
    PRINTING: "PRINTING";
    DONE: "DONE";
}>;
/** Sends something to a thermal printer: the usual one for it, or the one named. */
export declare const printRequestSchema: z.ZodObject<{
    printerId: z.ZodOptional<z.ZodUUID>;
}, z.core.$strip>;
export type PrintRequestInput = z.input<typeof printRequestSchema>;
/** Asks for a printout laid out for a printer connected to the device itself (WebUSB or Web Serial). */
export declare const printDocumentQuerySchema: z.ZodObject<{
    width: z.ZodDefault<z.ZodEnum<{
        MM58: "MM58";
        MM80: "MM80";
    }>>;
}, z.core.$strip>;
export type PrintDocumentQuery = z.input<typeof printDocumentQuerySchema>;
export declare const printJobQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    pageSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    status: z.ZodOptional<z.ZodEnum<{
        FAILED: "FAILED";
        QUEUED: "QUEUED";
        PRINTING: "PRINTING";
        DONE: "DONE";
    }>>;
    mine: z.ZodPipe<z.ZodDefault<z.ZodEnum<{
        true: "true";
        false: "false";
    }>>, z.ZodTransform<boolean, "true" | "false">>;
}, z.core.$strip>;
export type PrintJobQuery = z.input<typeof printJobQuerySchema>;
export interface PrintJobDto {
    id: string;
    type: z.infer<typeof printJobTypeSchema>;
    status: z.infer<typeof printJobStatusSchema>;
    title: string;
    printerId: string | null;
    printerName: string | null;
    refId: string | null;
    isReprint: boolean;
    attempts: number;
    lastError: string | null;
    requestedByName: string | null;
    createdAt: string;
    printedAt: string | null;
}
/** What a screen needs to decide between the bridge and the browser's print dialog. */
export interface PrintingStatusDto {
    bridgeOnline: boolean;
    /** The default receipt printer, when it prints through the bridge. */
    receiptPrinter: {
        id: string;
        name: string;
        paperWidth: z.infer<typeof paperWidthSchema>;
    } | null;
    /** True when at least one kitchen ticket printer prints through the bridge. */
    kitchenPrinters: boolean;
}
export declare const bridgeHelloSchema: z.ZodObject<{
    version: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const bridgeResultSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    error: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type BridgeResultInput = z.input<typeof bridgeResultSchema>;
//# sourceMappingURL=printing.d.ts.map