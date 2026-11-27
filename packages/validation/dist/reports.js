import { z } from 'zod';
import { isoDateSchema } from './common.js';
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
];
export const reportTypeSchema = z.enum(REPORTS.map((report) => report.type));
const dateSchema = isoDateSchema;
const MAX_DAYS = 1100;
export const reportQuerySchema = z
    .object({ from: dateSchema, to: dateSchema })
    .refine((range) => range.from <= range.to, { path: ['to'], message: 'The end date must not be before the start date' })
    .refine((range) => (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 <= MAX_DAYS, {
    path: ['to'],
    message: 'Choose a period of three years or less',
});
export const reportFormatSchema = z.enum(['csv', 'xlsx', 'pdf']);
export const reportExportQuerySchema = z
    .object({ from: dateSchema, to: dateSchema, format: reportFormatSchema })
    .refine((range) => range.from <= range.to, { path: ['to'], message: 'The end date must not be before the start date' })
    .refine((range) => (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 <= MAX_DAYS, {
    path: ['to'],
    message: 'Choose a period of three years or less',
});
export const shareReportSchema = z.object({ userIds: z.array(z.uuid()).max(200) });
//# sourceMappingURL=reports.js.map