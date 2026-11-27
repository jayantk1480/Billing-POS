import { z } from 'zod';
import { mobileSchema, pageQuerySchema, sortDirectionSchema } from './common.js';
import type { OrderStatus, OrderType } from './orders.js';

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
export type CustomerQuery = z.input<typeof customerQuerySchema>;

export const customerLookupSchema = z.object({ phone: mobileSchema });

/** Part of a number as it is being typed: the digits in it, with or without a country code or leading zero. */
export const customerSuggestSchema = z.object({ phone: z.string().trim().max(20) });

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
