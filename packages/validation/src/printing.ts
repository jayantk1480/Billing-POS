import { z } from 'zod';
import { nullableText, pageQuerySchema, text, uuidSchema } from './common.js';

// ── Printers ──

export const printerRoleSchema = z.enum(['RECEIPT', 'KOT']);
/** BROWSER is a printer reached through the browser's print dialog at the counter, with no bridge. */
export const printerConnectionSchema = z.enum(['NETWORK', 'USB', 'BLUETOOTH', 'BROWSER']);
export const paperWidthSchema = z.enum(['MM58', 'MM80']);

const hostSchema = z
  .string()
  .trim()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/, 'Enter an IP address or a host name');

const printerFields = {
  name: text(40, 'Name'),
  role: printerRoleSchema,
  connection: printerConnectionSchema,
  paperWidth: paperWidthSchema.default('MM80'),
  host: z.union([hostSchema, z.literal('').transform(() => null), z.null()]).optional(),
  port: z.number().int().min(1).max(65_535).nullable().optional(),
  /** A device file, a serial port or the name of a printer queue on the computer running the print bridge. */
  devicePath: nullableText(200),
  /** The printer used for this role when nothing more specific is set. */
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
};

const connectionComplete = (value: { connection?: string | undefined; host?: string | null | undefined; devicePath?: string | null | undefined }, ctx: z.RefinementCtx) => {
  if (value.connection === 'NETWORK' && !value.host) ctx.addIssue({ code: 'custom', path: ['host'], message: 'Enter the IP address of the printer' });
  if ((value.connection === 'USB' || value.connection === 'BLUETOOTH') && !value.devicePath) {
    ctx.addIssue({ code: 'custom', path: ['devicePath'], message: 'Enter the device or the printer name on the bridge computer' });
  }
};

export const printerSchema = z.object(printerFields).superRefine(connectionComplete);
export type PrinterInput = z.input<typeof printerSchema>;
export const updatePrinterSchema = z.object(printerFields).partial();
export type UpdatePrinterInput = z.input<typeof updatePrinterSchema>;

export interface PrinterDto {
  id: string;
  name: string;
  role: z.infer<typeof printerRoleSchema>;
  connection: z.infer<typeof printerConnectionSchema>;
  paperWidth: z.infer<typeof paperWidthSchema>;
  host: string | null;
  port: number | null;
  devicePath: string | null;
  isDefault: boolean;
  isActive: boolean;
  /** "ok" or "error", from the last job sent to it. */
  lastStatus: string | null;
  lastError: string | null;
  lastSeenAt: string | null;
  /** Kitchen stations whose tickets print here. */
  stations: string[];
}

// ── Layouts ──

const copies = z.number().int().min(1).max(3);

export const receiptLayoutSchema = z.object({
  /** A line under the restaurant name, for example a tagline or a branch name. */
  headerNote: z.string().trim().max(80).nullable().default(null),
  showCustomer: z.boolean().default(true),
  showHsn: z.boolean().default(false),
  showTaxBreakup: z.boolean().default(true),
  showAmountInWords: z.boolean().default(false),
  /** Print a UPI QR code for the amount due, when the restaurant has a UPI ID and the bill is not fully paid. */
  showUpiQr: z.boolean().default(true),
  /** Open the cash drawer when a bill paid in cash prints. */
  openDrawer: z.boolean().default(true),
  copies: copies.default(1),
});
export type ReceiptLayout = z.infer<typeof receiptLayoutSchema>;

export const kotLayoutSchema = z.object({
  /** Taller item lines, for a kitchen that reads tickets from a distance. Off, the ticket is in the bill's sizes. */
  largeItems: z.boolean().default(false),
  showOrderedBy: z.boolean().default(true),
  copies: copies.default(1),
});
export type KotLayout = z.infer<typeof kotLayoutSchema>;

export const printLayoutsSchema = z.object({ receipt: receiptLayoutSchema, kot: kotLayoutSchema });
export const updatePrintLayoutsSchema = z.object({ receipt: receiptLayoutSchema.partial(), kot: kotLayoutSchema.partial() }).partial();
export type UpdatePrintLayoutsInput = z.input<typeof updatePrintLayoutsSchema>;
export interface PrintLayoutsDto {
  receipt: ReceiptLayout;
  kot: KotLayout;
}

// ── Print bridges ──

export const createBridgeSchema = z.object({ name: text(40, 'Name') });
export type CreateBridgeInput = z.input<typeof createBridgeSchema>;

export interface BridgeDto {
  id: string;
  name: string;
  version: string | null;
  lastSeenAt: string | null;
  /** Heard from in the last half minute. */
  online: boolean;
}
/** The token is shown once, when the bridge is added. Only its hash is stored. */
export interface BridgeCreatedDto extends BridgeDto {
  token: string;
}

// ── Print jobs ──

export const printJobTypeSchema = z.enum(['RECEIPT', 'KOT', 'CREDIT_NOTE', 'REGISTER_REPORT', 'TEST']);
export const printJobStatusSchema = z.enum(['QUEUED', 'PRINTING', 'DONE', 'FAILED']);

/** Sends something to a thermal printer: the usual one for it, or the one named. */
export const printRequestSchema = z.object({ printerId: uuidSchema.optional() });
export type PrintRequestInput = z.input<typeof printRequestSchema>;

/** Asks for a printout laid out for a printer connected to the device itself (WebUSB or Web Serial). */
export const printDocumentQuerySchema = z.object({ width: paperWidthSchema.default('MM80') });
export type PrintDocumentQuery = z.input<typeof printDocumentQuerySchema>;

export const printJobQuerySchema = pageQuerySchema.extend({
  status: printJobStatusSchema.optional(),
  /** Only jobs the caller asked for. */
  mine: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
});
export type PrintJobQuery = z.input<typeof printJobQuerySchema>;

export interface PrintJobDto {
  id: string;
  type: z.infer<typeof printJobTypeSchema>;
  status: z.infer<typeof printJobStatusSchema>;
  title: string;
  printerId: string | null;
  printerName: string | null;
  refId: string | null;
  isReprint: boolean;
  attempts: number;
  lastError: string | null;
  requestedByName: string | null;
  createdAt: string;
  printedAt: string | null;
}

/** What a screen needs to decide between the bridge and the browser's print dialog. */
export interface PrintingStatusDto {
  bridgeOnline: boolean;
  /** The default receipt printer, when it prints through the bridge. */
  receiptPrinter: { id: string; name: string; paperWidth: z.infer<typeof paperWidthSchema> } | null;
  /** True when at least one kitchen ticket printer prints through the bridge. */
  kitchenPrinters: boolean;
}

// ── Bridge protocol ──

export const bridgeHelloSchema = z.object({ version: z.string().trim().max(20).optional() });
export const bridgeResultSchema = z.object({ ok: z.boolean(), error: z.string().trim().max(300).optional() });
export type BridgeResultInput = z.input<typeof bridgeResultSchema>;
