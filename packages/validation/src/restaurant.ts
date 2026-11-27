import { GST_STATES } from '@pos/types';
import { z } from 'zod';
import { bpsSchema, emailSchema, gstinSchema, nullableText, text, uuidSchema } from './common.js';
import type { SubscriptionDto } from './platform.js';

export const stateCodeSchema = z.string().refine((code) => code in GST_STATES, 'Choose a state');

export const updateRestaurantSchema = z
  .object({
    name: text(120, 'Restaurant name'),
    legalName: nullableText(160),
    gstin: z.union([gstinSchema, z.literal('').transform(() => null), z.null()]).optional(),
    fssaiNumber: z
      .union([z.string().trim().regex(/^\d{14}$/, 'FSSAI number has 14 digits'), z.literal('').transform(() => null), z.null()])
      .optional(),
    phone: nullableText(20),
    email: z.union([emailSchema, z.literal('').transform(() => null), z.null()]).optional(),
    addressLine1: nullableText(160),
    addressLine2: nullableText(160),
    city: nullableText(80),
    stateCode: stateCodeSchema,
    pincode: z
      .union([z.string().trim().regex(/^\d{6}$/, 'PIN code has 6 digits'), z.literal('').transform(() => null), z.null()])
      .optional(),
  })
  .partial()
  .refine(
    (value) => !value.gstin || !value.stateCode || value.gstin.startsWith(value.stateCode),
    { path: ['gstin'], message: 'The first two digits of the GSTIN must match the state' },
  );
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

export const gstRegistrationSchema = z.enum(['REGULAR', 'COMPOSITION', 'UNREGISTERED']);
export const roundOffModeSchema = z.enum(['NONE', 'NEAREST_RUPEE']);
export const orderNumberResetSchema = z.enum(['DAILY', 'FINANCIAL_YEAR', 'NEVER']);
export const orderRenumberModeSchema = z.enum(['AUTO', 'MANUAL', 'OFF']);

export const updateSettingsSchema = z
  .object({
    gstRegistration: gstRegistrationSchema,
    pricesIncludeTax: z.boolean(),
    roundOffMode: roundOffModeSchema,
    serviceChargeEnabled: z.boolean(),
    serviceChargeBps: bpsSchema.max(2000, 'Service charge cannot exceed 20%'),
    dayCutoffMinutes: z.number().int().min(0).max(1439),
    orderNumberReset: orderNumberResetSchema,
    orderRenumberMode: orderRenumberModeSchema,
    discountCapBps: bpsSchema,
    autoPrintKot: z.boolean(),
    autoPrintReceipt: z.boolean(),
    registerRequired: z.boolean(),
    defaultTaxGroupId: uuidSchema.nullable(),
    invoiceFooter: nullableText(300),
    upiVpa: z
      .union([z.string().trim().regex(/^[\w.-]{2,}@[a-zA-Z]{2,}$/, 'Enter a valid UPI ID'), z.literal('').transform(() => null), z.null()]),
  })
  .partial();
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

// ── Tax groups ──

export const taxGroupSchema = z.object({
  name: text(40, 'Name'),
  /** Total GST rate in basis points. Must be even so CGST and SGST are exact halves. */
  gstRateBps: bpsSchema.refine((bps) => bps % 2 === 0, 'GST rate must split evenly into CGST and SGST'),
  cessRateBps: bpsSchema.default(0),
  isActive: z.boolean().default(true),
});
export type TaxGroupInput = z.input<typeof taxGroupSchema>;
export const updateTaxGroupSchema = taxGroupSchema.partial();
export type UpdateTaxGroupInput = z.input<typeof updateTaxGroupSchema>;

export interface TaxGroupDto {
  id: string;
  name: string;
  isActive: boolean;
  gstRateBps: number;
  cessRateBps: number;
  components: { type: 'CGST' | 'SGST' | 'IGST' | 'CESS'; name: string; rateBps: number }[];
  productCount: number;
}

// ── Terminals and kitchen stations ──

export const createTerminalSchema = z.object({
  name: text(40, 'Name'),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}$/, 'Use 1 to 4 letters or digits')
    // Codes starting with Z number the bills each device makes while the internet is down.
    .refine((code) => !code.startsWith('Z'), 'Codes starting with Z are kept for offline billing. Choose another letter.'),
});
export type CreateTerminalInput = z.input<typeof createTerminalSchema>;
export const updateTerminalSchema = z.object({ name: text(40, 'Name'), isActive: z.boolean() }).partial();
export type UpdateTerminalInput = z.input<typeof updateTerminalSchema>;

export interface TerminalDto {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  lastSeenAt: string | null;
}

export const stationSchema = z.object({
  name: text(40, 'Name'),
  isActive: z.boolean().default(true),
  /** Where this station's kitchen tickets print, and where they go when that printer fails. */
  printerId: uuidSchema.nullable().optional(),
  fallbackPrinterId: uuidSchema.nullable().optional(),
});
export type StationInput = z.input<typeof stationSchema>;
export const updateStationSchema = stationSchema.partial();
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
