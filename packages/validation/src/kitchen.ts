import { z } from 'zod';
import { text, uuidSchema } from './common.js';
import type { OrderType } from './orders.js';

// ── Kitchen order tickets ──

export const kotStatusSchema = z.enum(['PENDING', 'PREPARING', 'READY', 'COMPLETED']);
export type KotStatus = z.infer<typeof kotStatusSchema>;

export const updateKotStatusSchema = z.object({ status: kotStatusSchema });

export const kotQuerySchema = z.object({
  stationId: uuidSchema.optional(),
  orderId: uuidSchema.optional(),
  /** "active" is what the kitchen still has to deal with; "today" also includes finished tickets. */
  scope: z.enum(['active', 'today']).default('active'),
});
export type KotQuery = z.input<typeof kotQuerySchema>;

export interface KotDto {
  id: string;
  kotNumber: number;
  /** The number printed on a ticket made offline ("Z01-K3"); the server numbered it again. Printed in its place. */
  offlineNumber: string | null;
  /** NEW asks the kitchen to make something; CANCEL tells it to stop. */
  type: 'NEW' | 'CANCEL';
  status: KotStatus | 'CANCELLED';
  stationId: string | null;
  stationName: string | null;
  orderId: string;
  orderDisplayNumber: string;
  orderType: OrderType;
  tableName: string | null;
  tokenNumber: number | null;
  notes: string | null;
  /** `cancelledQuantity` of the `quantity` were later taken back; the kitchen makes the difference. */
  items: { id: string; name: string; quantity: number; cancelledQuantity: number; notes: string | null }[];
  printCount: number;
  createdByName: string;
  createdAt: string;
  preparingAt: string | null;
  readyAt: string | null;
  completedAt: string | null;
}

// ── Floor ──

export const areaSchema = z.object({ name: text(40, 'Name') });
export type AreaInput = z.input<typeof areaSchema>;

export interface AreaDto {
  id: string;
  name: string;
  sortOrder: number;
  tableCount: number;
}

const position = z.number().int().min(0).max(4000);
const size = z.number().int().min(48).max(400);
export const tableShapeSchema = z.enum(['SQUARE', 'ROUND', 'RECTANGLE']);

export const createTableSchema = z.object({
  areaId: uuidSchema,
  name: text(12, 'Name'),
  seats: z.number().int().min(1, 'At least 1 seat').max(50),
  shape: tableShapeSchema.default('SQUARE'),
  posX: position.optional(),
  posY: position.optional(),
  width: size.optional(),
  height: size.optional(),
});
export type CreateTableInput = z.input<typeof createTableSchema>;

export const updateTableSchema = z
  .object({
    areaId: uuidSchema,
    name: text(12, 'Name'),
    seats: z.number().int().min(1, 'At least 1 seat').max(50),
    shape: tableShapeSchema,
    width: size,
    height: size,
    /** A blocked table cannot take orders, for example while it is reserved or being repaired. */
    blocked: z.boolean(),
  })
  .partial();
export type UpdateTableInput = z.input<typeof updateTableSchema>;

export const layoutSchema = z.object({
  tables: z.array(z.object({ id: uuidSchema, posX: position, posY: position })).min(1).max(500),
});
export type LayoutInput = z.infer<typeof layoutSchema>;

export const transferOrderSchema = z.object({ tableId: uuidSchema });
