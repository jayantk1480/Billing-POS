import { z } from 'zod';
import { isoDateSchema, nullableText, pageQuerySchema, paiseSchema, sortDirectionSchema, text, uuidSchema } from './common.js';
import { approvalSchema, paymentMethodSchema } from './orders.js';
// ── Cash register ──
/** Notes and coins counted when a register is closed, in rupees, largest first. */
export const CASH_DENOMINATIONS = [500, 200, 100, 50, 20, 10, 5, 2, 1];
export const openRegisterSchema = z.object({ openingCashPaise: paiseSchema });
export const cashMovementSchema = z.object({
    type: z.enum(['CASH_IN', 'CASH_OUT']),
    amountPaise: paiseSchema.min(1, 'Enter an amount'),
    reason: text(200, 'Reason'),
    approval: approvalSchema.optional(),
});
const denominationKeys = new Set(CASH_DENOMINATIONS.map(String));
export const closeRegisterSchema = z
    .object({
    countedCashPaise: paiseSchema,
    /** How many of each note and coin, keyed by its value in rupees. When given, it must add up to the counted cash. */
    denominations: z
        .record(z.string(), z.number().int().min(0).max(100_000))
        .refine((value) => Object.keys(value).every((key) => denominationKeys.has(key)), 'Unknown note or coin')
        .optional(),
    notes: nullableText(300),
})
    .refine((value) => !value.denominations || Object.entries(value.denominations).reduce((sum, [rupees, count]) => sum + Number(rupees) * count * 100, 0) === value.countedCashPaise, { path: ['denominations'], message: 'The notes and coins do not add up to the counted cash' });
export const registerQuerySchema = pageQuerySchema.extend({
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    userId: uuidSchema.optional(),
    status: z.enum(['OPEN', 'CLOSED']).optional(),
    sort: z.enum(['opened', 'closed', 'cashier', 'terminal', 'opening', 'expected', 'counted', 'variance', 'status']).default('opened'),
    direction: sortDirectionSchema.default('desc'),
});
// ── Payments and reconciliation ──
export const reconciliationQuerySchema = z
    .object({ from: isoDateSchema, to: isoDateSchema })
    .refine((value) => value.from <= value.to, { path: ['to'], message: 'The end date is before the start date' })
    .refine((value) => (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 <= 92, { path: ['to'], message: 'Choose at most three months' });
export const saveReconciliationSchema = z.object({
    businessDate: isoDateSchema,
    method: paymentMethodSchema,
    /** What the bank, the card machine or the UPI app shows as received for that day. */
    settledPaise: paiseSchema,
    note: nullableText(300),
});
export const paymentQuerySchema = pageQuerySchema.extend({
    from: isoDateSchema,
    to: isoDateSchema,
    method: paymentMethodSchema.optional(),
    registerSessionId: uuidSchema.optional(),
});
//# sourceMappingURL=registers.js.map