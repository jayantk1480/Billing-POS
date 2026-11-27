import { z } from 'zod';
import { emailSchema, gstinSchema, isoDateSchema, pageQuerySchema, passwordSchema, sortDirectionSchema, text } from './common.js';
import { gstRegistrationSchema, stateCodeSchema } from './restaurant.js';

// ── Subscription ──

/**
 * TRIAL and ACTIVE restaurants work in full. EXPIRED (the trial or the paid period is over) can still look at
 * and export everything but cannot change anything. SUSPENDED (by the platform) cannot sign in at all.
 */
export type SubscriptionStatus = 'ACTIVE' | 'TRIAL' | 'EXPIRED' | 'SUSPENDED';
export const subscriptionStatusSchema = z.enum(['ACTIVE', 'TRIAL', 'EXPIRED', 'SUSPENDED']);

export interface SubscriptionDto {
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  /** The last day that is paid for, "YYYY-MM-DD". */
  paidUntil: string | null;
  /** Whole days until the trial or the paid period ends; 0 on the last day. Null when there is no time limit. */
  daysLeft: number | null;
}

const DAY_MS = 86_400_000;
const dateIn = (instant: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);

/** Where a restaurant stands at `now`. A restaurant with neither a trial nor a paid period has no time limit. */
export function subscriptionOf(
  restaurant: { isActive: boolean; trialEndsAt: Date | null; paidUntil: Date | null }, now: Date = new Date(), timeZone = 'Asia/Kolkata',
): SubscriptionDto {
  const trialEndsAt = restaurant.trialEndsAt?.toISOString() ?? null;
  const paidUntil = restaurant.paidUntil?.toISOString().slice(0, 10) ?? null;
  const today = dateIn(now, timeZone);
  const base = { trialEndsAt, paidUntil };
  if (!restaurant.isActive) return { ...base, status: 'SUSPENDED', daysLeft: null };
  // Paid through the end of that day, by the restaurant's own calendar.
  if (paidUntil && paidUntil >= today) return { ...base, status: 'ACTIVE', daysLeft: Math.round((Date.parse(paidUntil) - Date.parse(today)) / DAY_MS) };
  if (restaurant.trialEndsAt && restaurant.trialEndsAt > now) {
    return { ...base, status: 'TRIAL', daysLeft: Math.floor((restaurant.trialEndsAt.getTime() - now.getTime()) / DAY_MS) };
  }
  if (!restaurant.trialEndsAt && !restaurant.paidUntil) return { ...base, status: 'ACTIVE', daysLeft: null };
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
const gstRules = (value: { gstRegistration: string; gstin?: string | null | undefined; stateCode: string }, ctx: z.RefinementCtx) => {
  if (value.gstRegistration !== 'UNREGISTERED' && !value.gstin) ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'Enter the GSTIN, or choose "Not registered for GST"' });
  if (value.gstin && !value.gstin.startsWith(value.stateCode)) ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'The first two digits of the GSTIN must match the state' });
};

export const signupSchema = z.object({ ...restaurantFields, password: passwordSchema }).superRefine(gstRules);
export type SignupInput = z.input<typeof signupSchema>;

export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) });
export const resendVerificationSchema = z.object({ email: emailSchema });

/** What the owner still has to do before the restaurant can trade, worked out from what exists. */
export interface OnboardingDto {
  dismissed: boolean;
  steps: { details: boolean; menu: boolean; tables: boolean; staff: boolean; firstBill: boolean };
}

// ── Platform admin ──

export const platformLoginSchema = z.object({ email: emailSchema, password: z.string().min(1, 'Enter your password').max(200) });
export type PlatformLoginInput = z.infer<typeof platformLoginSchema>;

export interface PlatformAdminDto {
  id: string;
  name: string;
  email: string;
}

export const platformRestaurantQuerySchema = pageQuerySchema.extend({
  search: z.string().trim().max(80).optional(),
  status: subscriptionStatusSchema.optional(),
  sort: z.enum(['name', 'created', 'status', 'ends', 'lastActive', 'bills', 'sales', 'users']).default('created'),
  direction: sortDirectionSchema.default('desc'),
});
export type PlatformRestaurantQuery = z.input<typeof platformRestaurantQuerySchema>;

export interface PlatformRestaurantDto {
  id: string;
  name: string;
  city: string | null;
  stateName: string;
  ownerName: string | null;
  ownerEmail: string | null;
  /** False while the owner who signed up has not opened the link sent to their email. */
  ownerVerified: boolean;
  createdAt: string;
  createdVia: 'SEED' | 'SIGNUP' | 'PLATFORM';
  subscription: SubscriptionDto;
  suspendReason: string | null;
  users: number;
  /** The last time anyone at the restaurant signed in. */
  lastActiveAt: string | null;
  billsLast30Days: number;
  salesLast30DaysPaise: number;
}

export interface PlatformRestaurantDetailDto extends PlatformRestaurantDto {
  legalName: string | null;
  gstin: string | null;
  phone: string | null;
  gstRegistration: z.infer<typeof gstRegistrationSchema>;
  terminals: number;
  products: number;
  billsTotal: number;
  people: { id: string; name: string; email: string; roleName: string; isActive: boolean; lastLoginAt: string | null }[];
  /** The most recent entries of the restaurant's audit log: what was done, not the data itself. */
  activity: { at: string; action: string; userName: string | null; reason: string | null }[];
}

export interface PlatformOverviewDto {
  restaurants: Record<SubscriptionStatus, number> & { total: number };
  signupsLast30Days: number;
  /** Trials that end within a week, soonest first. */
  trialsEndingSoon: { id: string; name: string; trialEndsAt: string; daysLeft: number }[];
}

export const platformCreateRestaurantSchema = z
  .object({ ...restaurantFields, phone: z.union([mobileSchema, z.literal('').transform(() => null), z.null()]).optional(), trialDays: z.number().int().min(0).max(365).default(14) })
  .superRefine(gstRules);
export type PlatformCreateRestaurantInput = z.input<typeof platformCreateRestaurantSchema>;

export const suspendRestaurantSchema = z.object({ reason: text(300, 'Reason') });
export type SuspendRestaurantInput = z.input<typeof suspendRestaurantSchema>;

export const setTrialSchema = z.object({ trialEndsOn: isoDateSchema, note: text(300, 'Note') });
export type SetTrialInput = z.input<typeof setTrialSchema>;

export const setPaidUntilSchema = z.object({
  /** The last day paid for; null removes the paid period. */
  paidUntil: isoDateSchema.nullable(),
  /** How it was paid, for example "UPI ref 4411, ₹12,000 for one year". */
  note: text(300, 'Note'),
});
export type SetPaidUntilInput = z.input<typeof setPaidUntilSchema>;
