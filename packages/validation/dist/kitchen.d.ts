import { z } from 'zod';
import type { OrderType } from './orders.js';
export declare const kotStatusSchema: z.ZodEnum<{
    PENDING: "PENDING";
    PREPARING: "PREPARING";
    READY: "READY";
    COMPLETED: "COMPLETED";
}>;
export type KotStatus = z.infer<typeof kotStatusSchema>;
export declare const updateKotStatusSchema: z.ZodObject<{
    status: z.ZodEnum<{
        PENDING: "PENDING";
        PREPARING: "PREPARING";
        READY: "READY";
        COMPLETED: "COMPLETED";
    }>;
}, z.core.$strip>;
export declare const kotQuerySchema: z.ZodObject<{
    stationId: z.ZodOptional<z.ZodUUID>;
    orderId: z.ZodOptional<z.ZodUUID>;
    scope: z.ZodDefault<z.ZodEnum<{
        active: "active";
        today: "today";
    }>>;
}, z.core.$strip>;
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
    items: {
        id: string;
        name: string;
        quantity: number;
        cancelledQuantity: number;
        notes: string | null;
    }[];
    printCount: number;
    createdByName: string;
    createdAt: string;
    preparingAt: string | null;
    readyAt: string | null;
    completedAt: string | null;
}
export declare const areaSchema: z.ZodObject<{
    name: z.ZodString;
}, z.core.$strip>;
export type AreaInput = z.input<typeof areaSchema>;
export interface AreaDto {
    id: string;
    name: string;
    sortOrder: number;
    tableCount: number;
}
export declare const tableShapeSchema: z.ZodEnum<{
    SQUARE: "SQUARE";
    ROUND: "ROUND";
    RECTANGLE: "RECTANGLE";
}>;
export declare const createTableSchema: z.ZodObject<{
    areaId: z.ZodUUID;
    name: z.ZodString;
    seats: z.ZodNumber;
    shape: z.ZodDefault<z.ZodEnum<{
        SQUARE: "SQUARE";
        ROUND: "ROUND";
        RECTANGLE: "RECTANGLE";
    }>>;
    posX: z.ZodOptional<z.ZodNumber>;
    posY: z.ZodOptional<z.ZodNumber>;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type CreateTableInput = z.input<typeof createTableSchema>;
export declare const updateTableSchema: z.ZodObject<{
    areaId: z.ZodOptional<z.ZodUUID>;
    name: z.ZodOptional<z.ZodString>;
    seats: z.ZodOptional<z.ZodNumber>;
    shape: z.ZodOptional<z.ZodEnum<{
        SQUARE: "SQUARE";
        ROUND: "ROUND";
        RECTANGLE: "RECTANGLE";
    }>>;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    blocked: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type UpdateTableInput = z.input<typeof updateTableSchema>;
export declare const layoutSchema: z.ZodObject<{
    tables: z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
        posX: z.ZodNumber;
        posY: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type LayoutInput = z.infer<typeof layoutSchema>;
export declare const transferOrderSchema: z.ZodObject<{
    tableId: z.ZodUUID;
}, z.core.$strip>;
//# sourceMappingURL=kitchen.d.ts.map