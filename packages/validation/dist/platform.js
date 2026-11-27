import { z } from 'zod';
import { emailSchema, gstinSchema, isoDateSchema, pageQuerySchema, passwordSchema, sortDirectionSchema, text } from './common.js';
import { gstRegistrationSchema, stateCodeSchema } from './restaurant.js';
export const subscriptionStatusSchema = z.enum(['ACTIVE', 'TRIAL', 'EXPIRED', 'SUSPENDED']);
const DAY_MS = 86_400_000;
const dateIn = (instant, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
/** Where a restaurant stands at `now`. A restaurant with neither a trial nor a paid period has no time limit. */
export function subscriptionOf(restaurant, now = new Date(), timeZone = 'Asia/Kolkata') {
    const trialEndsAt = restaurant.trialEndsAt?.toISOString() ?? null;
    const paidUntil = restaurant.paidUntil?.toISOString().slice(0, 10) ?? null;
    const today = dateIn(now, timeZone);
    const base = { trialEndsAt, paidUntil };
    if (!restaurant.isActive)
        return { ...base, status: 'SUSPENDED', daysLeft: null };
    // Paid through the end of that day, by the restaurant's own calendar.
    if (paidUntil && paidUntil >= today)
        return { ...base, status: 'ACTIVE', daysLeft: Math.round((Date.parse(paidUntil) - Date.parse(today)) / DAY_MS) };
    if (restaurant.trialEndsAt && restaurant.trialEndsAt > now) {
        return { ...base, status: 'TRIAL', daysLeft: Math.floor((restaurant.trialEndsAt.getTime() - now.getTime()) / DAY_MS) };
    }
    if (!restaurant.trialEndsAt && !restaurant.paidUntil)
        return { ...base, status: 'ACTIVE', daysLeft: null };
    return { ...base, status: 'EXPIRED', daysLeft: 0 };
}
// ── Sign-up ──
const mobileSchema = z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a 10 digit mobile number');
const optionalGstin = z.union([gstinSchema, z.literal('').transform(() => null), z.null()]).optional();
const restaurantFields = {
    restaurantName: text(120, 'Restaurant name'),
    ownerName: text(80, 'Your name'),
    email: emailSchema,
    phone: mobileSchema,
    stateCode: stateCodeSchema,
    gstRegistration: gstRegistrationSchema,
    gstin: optionalGstin,
};
/** A GST-registered restaurant has a GSTIN, and a GSTIN starts with the code of the state it was issued in. */
const gstRules = (value, ctx) => {
    if (value.gstRegistration !== 'UNREGISTERED' && !value.gstin)
        ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'Enter the GSTIN, or choose "Not registered for GST"' });
    if (value.gstin && !value.gstin.startsWith(value.stateCode))
        ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'The first two digits of the GSTIN must match the state' });
};
export const signupSchema = z.object({ ...restaurantFields, password: passwordSchema }).superRefine(gstRules);
export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) });
export const resendVerificationSchema = z.object({ email: emailSchema });
// ── Platform admin ──
export const platformLoginSchema = z.object({ email: emailSchema, password: z.string().min(1, 'Enter your password').max(200) });
export const platformRestaurantQuerySchema = pageQuerySchema.extend({
    search: z.string().trim().max(80).optional(),
    status: subscriptionStatusSchema.optional(),
    sort: z.enum(['name', 'created', 'status', 'ends', 'lastActive', 'bills', 'sales', 'users']).default('created'),
    direction: sortDirectionSchema.default('desc'),
});
export const platformCreateRestaurantSchema = z
    .object({ ...restaurantFields, phone: z.union([mobileSchema, z.literal('').transform(() => null), z.null()]).optional(), trialDays: z.number().int().min(0).max(365).default(14) })
    .superRefine(gstRules);
export const suspendRestaurantSchema = z.object({ reason: text(300, 'Reason') });
export const setTrialSchema = z.object({ trialEndsOn: isoDateSchema, note: text(300, 'Note') });
export const setPaidUntilSchema = z.object({
    /** The last day paid for; null removes the paid period. */
    paidUntil: isoDateSchema.nullable(),
    /** How it was paid, for example "UPI ref 4411, ₹12,000 for one year". */
    note: text(300, 'Note'),
});
//# sourceMappingURL=platform.js.map