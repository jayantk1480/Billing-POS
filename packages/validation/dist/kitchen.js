import { z } from 'zod';
import { text, uuidSchema } from './common.js';
// ── Kitchen order tickets ──
export const kotStatusSchema = z.enum(['PENDING', 'PREPARING', 'READY', 'COMPLETED']);
export const updateKotStatusSchema = z.object({ status: kotStatusSchema });
export const kotQuerySchema = z.object({
    stationId: uuidSchema.optional(),
    orderId: uuidSchema.optional(),
    /** "active" is what the kitchen still has to deal with; "today" also includes finished tickets. */
    scope: z.enum(['active', 'today']).default('active'),
});
// ── Floor ──
export const areaSchema = z.object({ name: text(40, 'Name') });
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
export const layoutSchema = z.object({
    tables: z.array(z.object({ id: uuidSchema, posX: position, posY: position })).min(1).max(500),
});
export const transferOrderSchema = z.object({ tableId: uuidSchema });
//# sourceMappingURL=kitchen.js.map