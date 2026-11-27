import { z } from 'zod';
import type { OrderStatus, OrderType } from './orders.js';
/**
 * Customers are the people a cashier names on an order, identified by mobile number: one number is one customer,
 * however it was typed. An order with a number already on record joins that customer, and details typed replace
 * those on record (a field left empty keeps what was there). A customer without a mobile number cannot be saved.
 */
export declare const customerQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    pageSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    search: z.ZodOptional<z.ZodString>;
    sort: z.ZodOptional<z.ZodEnum<{
        phone: "phone";
        name: "name";
        orders: "orders";
        spent: "spent";
        lastOrder: "lastOrder";
    }>>;
    direction: z.ZodDefault<z.ZodEnum<{
        asc: "asc";
        desc: "desc";
    }>>;
}, z.core.$strip>;
export type CustomerQuery = z.input<typeof customerQuerySchema>;
export declare const customerLookupSchema: z.ZodObject<{
    phone: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
}, z.core.$strip>;
/** Part of a number as it is being typed: the digits in it, with or without a country code or leading zero. */
export declare const customerSuggestSchema: z.ZodObject<{
    phone: z.ZodString;
}, z.core.$strip>;
/** A customer on record whose number begins with what was typed, for the billing screen to offer. */
export interface CustomerSuggestionDto {
    id: string;
    phone: string;
    name: string | null;
    address: string | null;
    orderCount: number;
}
export interface CustomerListItemDto {
    id: string;
    name: string | null;
    phone: string;
    address: string | null;
    /** Orders taken for this customer that were not cancelled or merged away. */
    orderCount: number;
    /** What the customer has paid in full: the totals of their settled orders. */
    spentPaise: number;
    lastOrderAt: string | null;
    createdAt: string;
}
/** One of a customer's orders, as the back office lists them. */
export interface CustomerOrderDto {
    id: string;
    displayNumber: string;
    businessDate: string;
    createdAt: string;
    type: OrderType;
    status: OrderStatus;
    /** The order's bills that stand (a cancelled bill is left out). */
    invoiceNumbers: string[];
    totalPaise: number;
    paidPaise: number;
}
export interface CustomerRecordDto extends CustomerListItemDto {
    /** Newest first. */
    orders: CustomerOrderDto[];
}
/** What the billing screen is told when a phone number is typed: the customer on record, or nothing. */
export interface CustomerLookupDto {
    customer: Pick<CustomerListItemDto, 'id' | 'name' | 'phone' | 'address' | 'orderCount'> | null;
}
//# sourceMappingURL=customers.d.ts.map