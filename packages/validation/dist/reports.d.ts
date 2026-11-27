import { z } from 'zod';
import type { InvoiceListItemDto, PaymentMethod } from './orders.js';
export declare const REPORTS: readonly [{
    readonly type: "sales-daily";
    readonly title: "Daily sales";
    readonly description: "Completed orders: bills, tax, refunds and net sales for each business day.";
}, {
    readonly type: "sales-monthly";
    readonly title: "Monthly sales";
    readonly description: "The same figures added up by month.";
}, {
    readonly type: "orders";
    readonly title: "Orders";
    readonly description: "Every completed order, with its bill numbers and how it was paid.";
}, {
    readonly type: "items";
    readonly title: "Item-wise sales";
    readonly description: "Every item sold, line by line: receipt, payment method, units, amount, discount and who billed it.";
}, {
    readonly type: "item-summary";
    readonly title: "Item summary";
    readonly description: "Total quantity and value sold of each item, best sellers first.";
}, {
    readonly type: "categories";
    readonly title: "Category-wise sales";
    readonly description: "Quantity and value sold in each menu category.";
}, {
    readonly type: "gst";
    readonly title: "GST summary";
    readonly description: "Taxable value and tax by GST rate on every bill issued, less credit notes. For your GST return working.";
}, {
    readonly type: "hsn";
    readonly title: "HSN / SAC summary";
    readonly description: "Quantity, taxable value and tax by HSN or SAC code and rate.";
}, {
    readonly type: "payments";
    readonly title: "Payments";
    readonly description: "Every payment received, line by line: receipt, payment method, amount and who took it.";
}, {
    readonly type: "payment-summary";
    readonly title: "Payment summary";
    readonly description: "Money received, added up by day and payment method.";
}, {
    readonly type: "discounts";
    readonly title: "Discounts";
    readonly description: "Every discount on a completed order, with who gave it and who approved it.";
}, {
    readonly type: "refunds";
    readonly title: "Refunds";
    readonly description: "Credit notes issued, with reason and approver.";
}, {
    readonly type: "cancellations";
    readonly title: "Cancelled bills";
    readonly description: "Bills cancelled after being issued, with reason.";
}, {
    readonly type: "cashiers";
    readonly title: "Cashier-wise";
    readonly description: "Bills, collections, discounts, refunds and cancellations for each staff member.";
}];
export type ReportType = (typeof REPORTS)[number]['type'];
export declare const reportTypeSchema: z.ZodEnum<{
    items: "items";
    payments: "payments";
    orders: "orders";
    "sales-daily": "sales-daily";
    "sales-monthly": "sales-monthly";
    "item-summary": "item-summary";
    categories: "categories";
    gst: "gst";
    hsn: "hsn";
    "payment-summary": "payment-summary";
    discounts: "discounts";
    refunds: "refunds";
    cancellations: "cancellations";
    cashiers: "cashiers";
}>;
export declare const reportQuerySchema: z.ZodObject<{
    from: z.ZodString;
    to: z.ZodString;
}, z.core.$strip>;
export type ReportQuery = z.infer<typeof reportQuerySchema>;
export declare const reportFormatSchema: z.ZodEnum<{
    csv: "csv";
    xlsx: "xlsx";
    pdf: "pdf";
}>;
export type ReportFormat = z.infer<typeof reportFormatSchema>;
export declare const reportExportQuerySchema: z.ZodObject<{
    from: z.ZodString;
    to: z.ZodString;
    format: z.ZodEnum<{
        csv: "csv";
        xlsx: "xlsx";
        pdf: "pdf";
    }>;
}, z.core.$strip>;
export declare const shareReportSchema: z.ZodObject<{
    userIds: z.ZodArray<z.ZodUUID>;
}, z.core.$strip>;
export type ShareReportInput = z.infer<typeof shareReportSchema>;
/** What the signed-in user may open. */
export interface AvailableReports {
    /** True when the user's role lets them see every report. */
    all: boolean;
    types: ReportType[];
}
/** Who each report is shared with, and who it could be shared with. */
export interface ReportSharing {
    /** Report type to the ids of the users it is shared with. */
    shares: Record<string, string[]>;
    /** Active users whose role does not already include every report. */
    candidates: {
        id: string;
        name: string;
        roleName: string;
    }[];
}
export interface ReportColumn {
    key: string;
    label: string;
    /** money is in paise; percent is a plain number such as 5 for 5%. */
    type: 'text' | 'number' | 'money' | 'percent' | 'date' | 'datetime';
}
export type ReportCell = string | number | null;
export interface ReportData {
    type: ReportType;
    title: string;
    from: string;
    to: string;
    generatedAt: string;
    columns: ReportColumn[];
    rows: Record<string, ReportCell>[];
    /** Headline figures shown above the table, such as total sales quantity and amount. */
    summary: {
        label: string;
        value: number;
        type: 'number' | 'money';
    }[];
    /** Column totals for the numeric columns that can be added up, or null when totals make no sense. */
    totals: Record<string, number> | null;
    /** Extra context shown under the title, such as counts that do not fit the table. */
    note: string | null;
    /** True when the list was cut off at the row limit. */
    truncated: boolean;
}
export interface DashboardDto {
    businessDate: string;
    sales: {
        totalPaise: number;
        bills: number;
        averagePaise: number;
        discountPaise: number;
        refundsPaise: number;
        netPaise: number;
    };
    orders: {
        taken: number;
        running: number;
        cancelled: number;
    };
    unpaid: {
        bills: number;
        amountPaise: number;
    };
    payments: {
        method: PaymentMethod;
        amountPaise: number;
        count: number;
    }[];
    /** The last seven business days, oldest first, ending today. */
    trend: {
        date: string;
        totalPaise: number;
        bills: number;
    }[];
    topItems: {
        name: string;
        quantity: number;
        totalPaise: number;
    }[];
    recentBills: InvoiceListItemDto[];
}
//# sourceMappingURL=reports.d.ts.map