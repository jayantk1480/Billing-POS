import { z } from 'zod';
import type { SubscriptionDto } from './platform.js';
export declare const stateCodeSchema: z.ZodString;
export declare const updateRestaurantSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    legalName: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>>;
    gstin: z.ZodOptional<z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodPipe<z.ZodLiteral<"">, z.ZodTransform<null, "">>, z.ZodNull]>>>;
    fssaiNumber: z.ZodOptional<z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodPipe<z.ZodLiteral<"">, z.ZodTransform<null, "">>, z.ZodNull]>>>;
    phone: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>>;
    email: z.ZodOptional<z.ZodOptional<z.ZodUnion<readonly [z.ZodPipe<z.ZodString, z.ZodEmail>, z.ZodPipe<z.ZodLiteral<"">, z.ZodTransform<null, "">>, z.ZodNull]>>>;
    addressLine1: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>>;
    addressLine2: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>>;
    city: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>>;
    stateCode: z.ZodOptional<z.ZodString>;
    pincode: z.ZodOptional<z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodPipe<z.ZodLiteral<"">, z.ZodTransform<null, "">>, z.ZodNull]>>>;
}, z.core.$strip>;
export type UpdateRestaurantInput = z.input<typeof updateRestaurantSchema>;
export interface RestaurantDto {
    id: string;
    name: string;
    legalName: string | null;
    gstin: string | null;
    fssaiNumber: string | null;
    phone: string | null;
    email: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    stateCode: string;
    stateName: string;
    pincode: string | null;
    logoUrl: string | null;
    /** Trial or paid period, and whether the restaurant can still make changes. */
    subscription: SubscriptionDto;
}
export declare const gstRegistrationSchema: z.ZodEnum<{
    REGULAR: "REGULAR";
    COMPOSITION: "COMPOSITION";
    UNREGISTERED: "UNREGISTERED";
}>;
export declare const roundOffModeSchema: z.ZodEnum<{
    NONE: "NONE";
    NEAREST_RUPEE: "NEAREST_RUPEE";
}>;
export declare const orderNumberResetSchema: z.ZodEnum<{
    DAILY: "DAILY";
    FINANCIAL_YEAR: "FINANCIAL_YEAR";
    NEVER: "NEVER";
}>;
export declare const orderRenumberModeSchema: z.ZodEnum<{
    AUTO: "AUTO";
    MANUAL: "MANUAL";
    OFF: "OFF";
}>;
export declare const updateSettingsSchema: z.ZodObject<{
    gstRegistration: z.ZodOptional<z.ZodEnum<{
        REGULAR: "REGULAR";
        COMPOSITION: "COMPOSITION";
        UNREGISTERED: "UNREGISTERED";
    }>>;
    pricesIncludeTax: z.ZodOptional<z.ZodBoolean>;
    roundOffMode: z.ZodOptional<z.ZodEnum<{
        NONE: "NONE";
        NEAREST_RUPEE: "NEAREST_RUPEE";
    }>>;
    serviceChargeEnabled: z.ZodOptional<z.ZodBoolean>;
    serviceChargeBps: z.ZodOptional<z.ZodNumber>;
    dayCutoffMinutes: z.ZodOptional<z.ZodNumber>;
    orderNumberReset: z.ZodOptional<z.ZodEnum<{
        DAILY: "DAILY";
        FINANCIAL_YEAR: "FINANCIAL_YEAR";
        NEVER: "NEVER";
    }>>;
    orderRenumberMode: z.ZodOptional<z.ZodEnum<{
        AUTO: "AUTO";
        MANUAL: "MANUAL";
        OFF: "OFF";
    }>>;
    discountCapBps: z.ZodOptional<z.ZodNumber>;
    autoPrintKot: z.ZodOptional<z.ZodBoolean>;
    autoPrintReceipt: z.ZodOptional<z.ZodBoolean>;
    registerRequired: z.ZodOptional<z.ZodBoolean>;
    defaultTaxGroupId: z.ZodOptional<z.ZodNullable<z.ZodUUID>>;
    invoiceFooter: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>>;
    upiVpa: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodPipe<z.ZodLiteral<"">, z.ZodTransform<null, "">>, z.ZodNull]>>;
}, z.core.$strip>;
export type UpdateSettingsInput = z.input<typeof updateSettingsSchema>;
export interface SettingsDto {
    /** Raised by "Start numbering again from 1"; part of the period order numbers are unique in. */
    orderNumberEpoch: number;
    gstRegistration: z.infer<typeof gstRegistrationSchema>;
    pricesIncludeTax: boolean;
    currency: string;
    timezone: string;
    roundOffMode: z.infer<typeof roundOffModeSchema>;
    serviceChargeEnabled: boolean;
    serviceChargeBps: number;
    dayCutoffMinutes: number;
    orderNumberReset: z.infer<typeof orderNumberResetSchema>;
    orderRenumberMode: z.infer<typeof orderRenumberModeSchema>;
    discountCapBps: number;
    /** Print kitchen tickets when KOT is pressed. Off: tickets go to the kitchen display only. Bill & pay never makes or prints one. */
    autoPrintKot: boolean;
    /** Print the bill as soon as it is fully paid. */
    autoPrintReceipt: boolean;
    /** Cash is taken only while the cashier has a cash register open. */
    registerRequired: boolean;
    defaultTaxGroupId: string | null;
    invoiceFooter: string | null;
    upiVpa: string | null;
}
export declare const taxGroupSchema: z.ZodObject<{
    name: z.ZodString;
    gstRateBps: z.ZodNumber;
    cessRateBps: z.ZodDefault<z.ZodNumber>;
    isActive: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type TaxGroupInput = z.input<typeof taxGroupSchema>;
export declare const updateTaxGroupSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    gstRateBps: z.ZodOptional<z.ZodNumber>;
    cessRateBps: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    isActive: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
}, z.core.$strip>;
export type UpdateTaxGroupInput = z.input<typeof updateTaxGroupSchema>;
export interface TaxGroupDto {
    id: string;
    name: string;
    isActive: boolean;
    gstRateBps: number;
    cessRateBps: number;
    components: {
        type: 'CGST' | 'SGST' | 'IGST' | 'CESS';
        name: string;
        rateBps: number;
    }[];
    productCount: number;
}
export declare const createTerminalSchema: z.ZodObject<{
    name: z.ZodString;
    code: z.ZodString;
}, z.core.$strip>;
export type CreateTerminalInput = z.input<typeof createTerminalSchema>;
export declare const updateTerminalSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    isActive: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type UpdateTerminalInput = z.input<typeof updateTerminalSchema>;
export interface TerminalDto {
    id: string;
    code: string;
    name: string;
    isActive: boolean;
    lastSeenAt: string | null;
}
export declare const stationSchema: z.ZodObject<{
    name: z.ZodString;
    isActive: z.ZodDefault<z.ZodBoolean>;
    printerId: z.ZodOptional<z.ZodNullable<z.ZodUUID>>;
    fallbackPrinterId: z.ZodOptional<z.ZodNullable<z.ZodUUID>>;
}, z.core.$strip>;
export type StationInput = z.input<typeof stationSchema>;
export declare const updateStationSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    isActive: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    printerId: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodUUID>>>;
    fallbackPrinterId: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodUUID>>>;
}, z.core.$strip>;
export type UpdateStationInput = z.input<typeof updateStationSchema>;
export interface StationDto {
    id: string;
    name: string;
    sortOrder: number;
    isActive: boolean;
    productCount: number;
    printerId: string | null;
    fallbackPrinterId: string | null;
}
//# sourceMappingURL=restaurant.d.ts.map