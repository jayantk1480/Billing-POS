import { z } from 'zod';
/** A calendar date as "YYYY-MM-DD". 30 February is refused here, not left for the database to choke on. */
export const isoDateSchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
    .refine((value) => {
    const date = new Date(value + 'T00:00:00Z');
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= '2000-01-01';
}, 'That date does not exist');
export const uuidSchema = z.uuid();
export const paiseSchema = z
    .number('Enter a valid amount')
    .int('Enter a valid amount')
    .min(0, 'Amount cannot be negative')
    .max(2_000_000_000, 'Amount is too large');
export const bpsSchema = z
    .number('Enter a valid percentage')
    .int('Use at most two decimal places')
    .min(0, 'Cannot be negative')
    .max(10_000, 'Cannot exceed 100%');
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address'));
/** Length matters more than character rules; 10+ characters, no forced symbols. */
export const passwordSchema = z
    .string()
    .min(10, 'Use at least 10 characters')
    .max(200, 'Use at most 200 characters');
export const pinSchema = z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits');
export const gstinSchema = z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid 15 character GSTIN');
/** Required text, trimmed. */
export const text = (max, label = 'This field') => z.string().trim().min(1, `${label} is required`).max(max, `${label} must be at most ${max} characters`);
/**
 * Optional text for create and update bodies: omitted means "leave as is",
 * null or an empty string means "clear".
 */
export const nullableText = (max) => z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === undefined ? undefined : value || null));
export const pageQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export const sortDirectionSchema = z.enum(['asc', 'desc']).default('asc');
export const healthResponseSchema = z.object({
    status: z.enum(['ok', 'degraded']),
    version: z.string(),
    database: z.enum(['up', 'down']),
    redis: z.enum(['up', 'down']),
    time: z.string(),
});
/**
 * An Indian mobile number, kept as its 10 digits. Spaces, dashes and brackets are ignored, and a leading +91, 91 or 0
 * is dropped, so "+91 98000 12345", "098000-12345" and "9800012345" are one number. The number is what identifies a
 * customer, so it must come out the same however it was typed.
 */
export const mobileSchema = z.string().trim().transform((text, ctx) => {
    let digits = text.replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91'))
        digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith('0'))
        digits = digits.slice(1);
    if (!/^[6-9]\d{9}$/.test(digits)) {
        ctx.addIssue({ code: 'custom', message: 'Enter a 10-digit mobile number' });
        return z.NEVER;
    }
    return digits;
});
//# sourceMappingURL=common.js.map