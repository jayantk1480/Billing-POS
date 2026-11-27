import { z } from 'zod';
import { mobileSchema, pageQuerySchema, sortDirectionSchema } from './common.js';
/**
 * Customers are the people a cashier names on an order, identified by mobile number: one number is one customer,
 * however it was typed. An order with a number already on record joins that customer, and details typed replace
 * those on record (a field left empty keeps what was there). A customer without a mobile number cannot be saved.
 */
export const customerQuerySchema = pageQuerySchema.extend({
    /** Part of a name, phone number or GSTIN. */
    search: z.string().trim().max(60).optional(),
    /** The column to sort by. Left out, the most recent customers come first. */
    sort: z.enum(['name', 'phone', 'orders', 'spent', 'lastOrder']).optional(),
    direction: sortDirectionSchema,
});
export const customerLookupSchema = z.object({ phone: mobileSchema });
/** Part of a number as it is being typed: the digits in it, with or without a country code or leading zero. */
export const customerSuggestSchema = z.object({ phone: z.string().trim().max(20) });
//# sourceMappingURL=customers.js.map