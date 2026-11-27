import { z } from 'zod';
import { isoDateSchema } from './common.js';
import type { InvoiceListItemDto, PaymentMethod } from './orders.js';

export const REPORTS = [
  { type: 'sales-daily', title: 'Daily sales', description: 'Completed orders: bills, tax, refunds and net sales for each business day.' },
  { type: 'sales-monthly', title: 'Monthly sales', description: 'The same figures added up by month.' },
  { type: 'orders', title: 'Orders', description: 'Every completed order, with its bill numbers and how it was paid.' },
  { type: 'items', title: 'Item-wise sales', description: 'Every item sold, line by line: receipt, payment method, units, amount, discount and who billed it.' },
  { type: 'item-summary', title: 'Item summary', description: 'Total quantity and value sold of each item, best sellers first.' },
  { type: 'categories', title: 'Category-wise sales', description: 'Quantity and value sold in each menu category.' },
  { type: 'gst', title: 'GST summary', description: 'Taxable value and tax by GST rate on every bill issued, less credit notes. For your GST return working.' },
  { type: 'hsn', title: 'HSN / SAC summary', description: 'Quantity, taxable value and tax by HSN or SAC code and rate.' },
  { type: 'payments', title: 'Payments', description: 'Every payment received, line by line: receipt, payment method, amount and who took it.' },
  { type: 'payment-summary', title: 'Payment summary', description: 'Money received, added up by day and payment method.' },
  { type: 'discounts', title: 'Discounts', description: 'Every discount on a completed order, with who gave it and who approved it.' },
  { type: 'refunds', title: 'Refunds', description: 'Credit notes issued, with reason and approver.' },
  { type: 'cancellations', title: 'Cancelled bills', description: 'Bills cancelled after being issued, with reason.' },
  { type: 'cashiers', title: 'Cashier-wise', description: 'Bills, collections, discounts, refunds and cancellations for each staff member.' },
] as const;

export type ReportType = (typeof REPORTS)[number]['type'];
export const reportTypeSchema = z.enum(REPORTS.map((report) => report.type) as [ReportType, ...ReportType[]]);

const dateSchema = isoDateSchema;
const MAX_DAYS = 1100;

export const reportQuerySchema = z
  .object({ from: dateSchema, to: dateSchema })
  .refine((range) => range.from <= range.to, { path: ['to'], message: 'The end date must not be before the start date' })
  .refine((range) => (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 <= MAX_DAYS, {
    path: ['to'],
    message: 'Choose a period of three years or less',
  });
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const reportFormatSchema = z.enum(['csv', 'xlsx', 'pdf']);
export type ReportFormat = z.infer<typeof reportFormatSchema>;
export const reportExportQuerySchema = z
  .object({ from: dateSchema, to: dateSchema, format: reportFormatSchema })
  .refine((range) => range.from <= range.to, { path: ['to'], message: 'The end date must not be before the start date' })
  .refine((range) => (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 <= MAX_DAYS, {
    path: ['to'],
    message: 'Choose a period of three years or less',
  });

export const shareReportSchema = z.object({ userIds: z.array(z.uuid()).max(200) });
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
  candidates: { id: string; name: string; roleName: string }[];
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
  summary: { label: string; value: number; type: 'number' | 'money' }[];
  /** Column totals for the numeric columns that can be added up, or null when totals make no sense. */
  totals: Record<string, number> | null;
  /** Extra context shown under the title, such as counts that do not fit the table. */
  note: string | null;
  /** True when the list was cut off at the row limit. */
  truncated: boolean;
}

export interface DashboardDto {
  businessDate: string;
  sales: { totalPaise: number; bills: number; averagePaise: number; discountPaise: number; refundsPaise: number; netPaise: number };
  orders: { taken: number; running: number; cancelled: number };
  unpaid: { bills: number; amountPaise: number };
  payments: { method: PaymentMethod; amountPaise: number; count: number }[];
  /** The last seven business days, oldest first, ending today. */
  trend: { date: string; totalPaise: number; bills: number }[];
  topItems: { name: string; quantity: number; totalPaise: number }[];
  recentBills: InvoiceListItemDto[];
}
