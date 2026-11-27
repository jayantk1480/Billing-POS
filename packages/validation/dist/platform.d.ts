import { z } from 'zod';
import { gstRegistrationSchema } from './restaurant.js';
/**
 * TRIAL and ACTIVE restaurants work in full. EXPIRED (the trial or the paid period is over) can still look at
 * and export everything but cannot change anything. SUSPENDED (by the platform) cannot sign in at all.
 */
export type SubscriptionStatus = 'ACTIVE' | 'TRIAL' | 'EXPIRED' | 'SUSPENDED';
export declare const subscriptionStatusSchema: z.ZodEnum<{
    ACTIVE: "ACTIVE";
    TRIAL: "TRIAL";
    EXPIRED: "EXPIRED";
    SUSPENDED: "SUSPENDED";
}>;
export interface SubscriptionDto {
    status: SubscriptionStatus;
    trialEndsAt: string | null;
    /** The last day that is paid for, "YYYY-MM-DD". */
    paidUntil: string | null;
    /** Whole days until the trial or the paid period ends; 0 on the last day. Null when there is no time limit. */
    daysLeft: number | null;
}
/** Where a restaurant stands at `now`. A restaurant with neither a trial nor a paid period has no time limit. */
export declare function subscriptionOf(restaurant: {
    isActive: boolean;
    trialEndsAt: Date | null;
    paidUntil: Date | null;
}, now?: Date, timeZone?: string): SubscriptionDto;
export declare const signupSchema: z.ZodObject<{
    password: z.ZodString;
    restaurantName: z.ZodString;
    ownerName: z.ZodString;
    email: z.ZodPipe<z.ZodString, z.ZodEmail>;
    phone: z.ZodString;
    stateCode: z.ZodString;
    gstRegistration: z.ZodEnum<{
        REGULAR: "REGULAR";
        COMPOSITION: "COMPOSITION";
        UNREGISTERED: "UNREGISTERED";
    }>;
    gstin: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodPipe<z.ZodLiteral<"">, z.ZodTransform<null, "">>, z.ZodNull]>>;
}, z.core.$strip>;
export type SignupInput = z.input<typeof signupSchema>;
export declare const verifyEmailSchema: z.ZodObject<{
    token: z.ZodString;
}, z.core.$strip>;
export declare const resendVerificationSchema: z.ZodObject<{
    email: z.ZodPipe<z.ZodString, z.ZodEmail>;
}, z.core.$strip>;
/** What the owner still has to do before the restaurant can trade, worked out from what exists. */
export interface OnboardingDto {
    dismissed: boolean;
    steps: {
        details: boolean;
        menu: boolean;
        tables: boolean;
        staff: boolean;
        firstBill: boolean;
    };
}
export declare const platformLoginSchema: z.ZodObject<{
    email: z.ZodPipe<z.ZodString, z.ZodEmail>;
    password: z.ZodString;
}, z.core.$strip>;
export type PlatformLoginInput = z.infer<typeof platformLoginSchema>;
export interface PlatformAdminDto {
    id: string;
    name: string;
    email: string;
}
export declare const platformRestaurantQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    pageSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    search: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<{
        ACTIVE: "ACTIVE";
        TRIAL: "TRIAL";
        EXPIRED: "EXPIRED";
        SUSPENDED: "SUSPENDED";
    }>>;
    sort: z.ZodDefault<z.ZodEnum<{
        status: "status";
        name: "name";
        created: "created";
        ends: "ends";
        lastActive: "lastActive";
        bills: "bills";
        sales: "sales";
        users: "users";
    }>>;
    direction: z.ZodDefault<z.ZodDefault<z.ZodEnum<{
        asc: "asc";
        desc: "desc";
    }>>>;
}, z.core.$strip>;
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
    people: {
        id: string;
        name: string;
        email: string;
        roleName: string;
        isActive: boolean;
        lastLoginAt: string | null;
    }[];
    /** The most recent entries of the restaurant's audit log: what was done, not the data itself. */
    activity: {
        at: string;
        action: string;
        userName: string | null;
        reason: string | null;
    }[];
}
export interface PlatformOverviewDto {
    restaurants: Record<SubscriptionStatus, number> & {
        total: number;
    };
    signupsLast30Days: number;
    /** Trials that end within a week, soonest first. */
    trialsEndingSoon: {
        id: string;
        name: string;
        trialEndsAt: string;
        daysLeft: number;
    }[];
}
export declare const platformCreateRestaurantSchema: z.ZodObject<{
    phone: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodPipe<z.ZodLiteral<"">, z.ZodTransform<null, "">>, z.ZodNull]>>;
    trialDays: z.ZodDefault<z.ZodNumber>;
    restaurantName: z.ZodString;
    ownerName: z.ZodString;
    email: z.ZodPipe<z.ZodString, z.ZodEmail>;
    stateCode: z.ZodString;
    gstRegistration: z.ZodEnum<{
        REGULAR: "REGULAR";
        COMPOSITION: "COMPOSITION";
        UNREGISTERED: "UNREGISTERED";
    }>;
    gstin: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodPipe<z.ZodLiteral<"">, z.ZodTransform<null, "">>, z.ZodNull]>>;
}, z.core.$strip>;
export type PlatformCreateRestaurantInput = z.input<typeof platformCreateRestaurantSchema>;
export declare const suspendRestaurantSchema: z.ZodObject<{
    reason: z.ZodString;
}, z.core.$strip>;
export type SuspendRestaurantInput = z.input<typeof suspendRestaurantSchema>;
export declare const setTrialSchema: z.ZodObject<{
    trialEndsOn: z.ZodString;
    note: z.ZodString;
}, z.core.$strip>;
export type SetTrialInput = z.input<typeof setTrialSchema>;
export declare const setPaidUntilSchema: z.ZodObject<{
    paidUntil: z.ZodNullable<z.ZodString>;
    note: z.ZodString;
}, z.core.$strip>;
export type SetPaidUntilInput = z.input<typeof setPaidUntilSchema>;
//# sourceMappingURL=platform.d.ts.map