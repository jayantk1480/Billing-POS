import { z } from 'zod';
import { isoDateSchema, nullableText, pageQuerySchema, paiseSchema, sortDirectionSchema, text, uuidSchema } from './common.js';
import { approvalSchema, type PaymentMethod, paymentMethodSchema } from './orders.js';

// ── Cash register ──

/** Notes and coins counted when a register is closed, in rupees, largest first. */
export const CASH_DENOMINATIONS = [500, 200, 100, 50, 20, 10, 5, 2, 1] as const;

export const openRegisterSchema = z.object({ openingCashPaise: paiseSchema });
export type OpenRegisterInput = z.input<typeof openRegisterSchema>;

export const cashMovementSchema = z.object({
  type: z.enum(['CASH_IN', 'CASH_OUT']),
  amountPaise: paiseSchema.min(1, 'Enter an amount'),
  reason: text(200, 'Reason'),
  approval: approvalSchema.optional(),
});
export type CashMovementInput = z.input<typeof cashMovementSchema>;

const denominationKeys = new Set<string>(CASH_DENOMINATIONS.map(String));

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
  .refine(
    (value) => !value.denominations || Object.entries(value.denominations).reduce((sum, [rupees, count]) => sum + Number(rupees) * count * 100, 0) === value.countedCashPaise,
    { path: ['denominations'], message: 'The notes and coins do not add up to the counted cash' },
  );
export type CloseRegisterInput = z.input<typeof closeRegisterSchema>;

export const registerQuerySchema = pageQuerySchema.extend({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  userId: uuidSchema.optional(),
  status: z.enum(['OPEN', 'CLOSED']).optional(),
  sort: z.enum(['opened', 'closed', 'cashier', 'terminal', 'opening', 'expected', 'counted', 'variance', 'status']).default('opened'),
  direction: sortDirectionSchema.default('desc'),
});
export type RegisterQuery = z.input<typeof registerQuerySchema>;

export interface RegisterSessionDto {
  id: string;
  status: 'OPEN' | 'CLOSED';
  businessDate: string;
  terminal: { id: string; code: string; name: string } | null;
  user: { id: string; name: string };
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
  takings: { method: PaymentMethod; count: number; receivedPaise: number; refundedPaise: number }[];
  movements: { id: string; type: 'CASH_IN' | 'CASH_OUT'; amountPaise: number; reason: string | null; createdByName: string; createdAt: string }[];
}

// ── Payments and reconciliation ──

export const reconciliationQuerySchema = z
  .object({ from: isoDateSchema, to: isoDateSchema })
  .refine((value) => value.from <= value.to, { path: ['to'], message: 'The end date is before the start date' })
  .refine((value) => (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 <= 92, { path: ['to'], message: 'Choose at most three months' });
export type ReconciliationQuery = z.input<typeof reconciliationQuerySchema>;

export const saveReconciliationSchema = z.object({
  businessDate: isoDateSchema,
  method: paymentMethodSchema,
  /** What the bank, the card machine or the UPI app shows as received for that day. */
  settledPaise: paiseSchema,
  note: nullableText(300),
});
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
  cash: { inRegistersPaise: number; outsideRegistersPaise: number; registerVariancePaise: number; registersClosed: number; registersOpen: number };
}

export const paymentQuerySchema = pageQuerySchema.extend({
  from: isoDateSchema,
  to: isoDateSchema,
  method: paymentMethodSchema.optional(),
  registerSessionId: uuidSchema.optional(),
});
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
