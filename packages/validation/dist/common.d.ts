import { z } from 'zod';
/** A calendar date as "YYYY-MM-DD". 30 February is refused here, not left for the database to choke on. */
export declare const isoDateSchema: z.ZodString;
export declare const uuidSchema: z.ZodUUID;
export declare const paiseSchema: z.ZodNumber;
export declare const bpsSchema: z.ZodNumber;
export declare const emailSchema: z.ZodPipe<z.ZodString, z.ZodEmail>;
/** Length matters more than character rules; 10+ characters, no forced symbols. */
export declare const passwordSchema: z.ZodString;
export declare const pinSchema: z.ZodString;
export declare const gstinSchema: z.ZodString;
/** Required text, trimmed. */
export declare const text: (max: number, label?: string) => z.ZodString;
/**
 * Optional text for create and update bodies: omitted means "leave as is",
 * null or an empty string means "clear".
 */
export declare const nullableText: (max: number) => z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | null | undefined, string | null | undefined>>;
export declare const pageQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    pageSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
}, z.core.$strip>;
export declare const sortDirectionSchema: z.ZodDefault<z.ZodEnum<{
    asc: "asc";
    desc: "desc";
}>>;
export interface Page<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
}
export declare const healthResponseSchema: z.ZodObject<{
    status: z.ZodEnum<{
        ok: "ok";
        degraded: "degraded";
    }>;
    version: z.ZodString;
    database: z.ZodEnum<{
        up: "up";
        down: "down";
    }>;
    redis: z.ZodEnum<{
        up: "up";
        down: "down";
    }>;
    time: z.ZodString;
}, z.core.$strip>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
/**
 * An Indian mobile number, kept as its 10 digits. Spaces, dashes and brackets are ignored, and a leading +91, 91 or 0
 * is dropped, so "+91 98000 12345", "098000-12345" and "9800012345" are one number. The number is what identifies a
 * customer, so it must come out the same however it was typed.
 */
export declare const mobileSchema: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
//# sourceMappingURL=common.d.ts.map