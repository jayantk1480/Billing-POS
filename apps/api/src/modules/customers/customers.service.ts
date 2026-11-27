import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@pos/database';
import type { CustomerRecordDto, CustomerListItemDto, CustomerLookupDto, customerQuerySchema, CustomerSuggestionDto, Page } from '@pos/validation';
import type { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { notFound } from '../../common/errors.js';
import { displayNumber } from '../billing/mappers.js';
import { fromDate } from '../billing/billing-context.js';

/** A customer row with the figures the list shows, as the database works them out. */
interface CustomerRow {
  id: string;
  name: string | null;
  phone: string;
  address: string | null;
  created_at: Date;
  orders: bigint;
  spent: bigint;
  last_order: Date | null;
}

/** Orders cancelled or merged into another order are not the customer's orders any more. */
const COUNTED = Prisma.sql`o.status NOT IN ('CANCELLED', 'MERGED')`;

const SORT: Record<NonNullable<z.output<typeof customerQuerySchema>['sort']>, Prisma.Sql> = {
  name: Prisma.sql`lower(c.name)`,
  phone: Prisma.sql`c.phone`,
  orders: Prisma.sql`orders`,
  spent: Prisma.sql`spent`,
  lastOrder: Prisma.sql`last_order`,
};

/**
 * The customers named on orders, with what they ordered. The records themselves are written when an order is
 * saved (OrdersService.saveCustomer); this reads them for the back office and for the billing screen's lookup.
 */
@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(auth: AuthContext, query: z.output<typeof customerQuerySchema>): Promise<Page<CustomerListItemDto>> {
    const search = query.search ? `%${query.search}%` : null;
    // A number is searched by its digits, with or without a country code or a leading zero, so "+91 98000" finds 9800012345.
    const forms = numberForms(query.search ?? '');
    const byNumber = forms.length > 0 ? Prisma.sql` OR ${Prisma.join(forms.map((form) => Prisma.sql`c.phone LIKE ${`%${form}%`}`), ' OR ')}` : Prisma.empty;
    const where = Prisma.sql`c.restaurant_id = ${auth.restaurantId}::uuid${
      search ? Prisma.sql` AND (c.name ILIKE ${search}${byNumber})` : Prisma.empty
    }`;
    // Empty cells (no phone, no order yet) stay at the bottom whichever way the column is sorted.
    const direction = query.direction === 'desc' ? Prisma.sql`DESC NULLS LAST` : Prisma.sql`ASC NULLS LAST`;
    const orderBy = query.sort ? Prisma.sql`${SORT[query.sort]} ${direction}, c.created_at DESC` : Prisma.sql`c.created_at DESC`;
    const [rows, counted] = await Promise.all([
      this.prisma.$queryRaw<CustomerRow[]>`
        SELECT c.id, c.name, c.phone, c.address, c.created_at,
               COUNT(o.id) FILTER (WHERE ${COUNTED}) AS orders,
               COALESCE(SUM(o.total_paise) FILTER (WHERE o.status = 'SETTLED'), 0) AS spent,
               MAX(o.created_at) FILTER (WHERE ${COUNTED}) AS last_order
        FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
        WHERE ${where}
        GROUP BY c.id
        ORDER BY ${orderBy}
        LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
      this.prisma.$queryRaw<{ total: bigint }[]>`SELECT COUNT(*) AS total FROM customers c WHERE ${where}`,
    ]);
    return { items: rows.map(toListItem), total: Number(counted[0]?.total ?? 0), page: query.page, pageSize: query.pageSize };
  }

  async get(auth: AuthContext, id: string): Promise<CustomerRecordDto> {
    const [row] = await this.prisma.$queryRaw<CustomerRow[]>`
      SELECT c.id, c.name, c.phone, c.address, c.created_at,
             COUNT(o.id) FILTER (WHERE ${COUNTED}) AS orders,
             COALESCE(SUM(o.total_paise) FILTER (WHERE o.status = 'SETTLED'), 0) AS spent,
             MAX(o.created_at) FILTER (WHERE ${COUNTED}) AS last_order
      FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
      WHERE c.id = ${id}::uuid AND c.restaurant_id = ${auth.restaurantId}::uuid
      GROUP BY c.id`;
    if (!row) throw notFound('Customer');
    const orders = await this.prisma.order.findMany({
      where: { customerId: id, restaurantId: auth.restaurantId },
      include: { invoices: { select: { invoiceNumber: true, status: true, paidPaise: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return {
      ...toListItem(row),
      orders: orders.map((order) => {
        const standing = order.invoices.filter((invoice) => invoice.status === 'ISSUED');
        return {
          id: order.id, displayNumber: displayNumber(order), businessDate: fromDate(order.businessDate), createdAt: order.createdAt.toISOString(),
          type: order.type, status: order.status, invoiceNumbers: standing.map((invoice) => invoice.invoiceNumber),
          totalPaise: order.totalPaise, paidPaise: standing.reduce((sum, invoice) => sum + invoice.paidPaise, 0),
        };
      }),
    };
  }

  /**
   * Customers whose number begins with what has been typed so far, for the billing screen to offer while the cashier
   * types. Nothing until three digits are in, and never more than eight, numbers in order.
   */
  async suggest(auth: AuthContext, typed: string): Promise<CustomerSuggestionDto[]> {
    const forms = numberForms(typed);
    if (forms.length === 0) return [];
    const rows = await this.prisma.$queryRaw<{ id: string; phone: string; name: string | null; address: string | null; orders: bigint }[]>`
      SELECT c.id, c.phone, c.name, c.address, COUNT(o.id) FILTER (WHERE ${COUNTED}) AS orders
      FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
      WHERE c.restaurant_id = ${auth.restaurantId}::uuid AND (${Prisma.join(forms.map((form) => Prisma.sql`c.phone LIKE ${`${form}%`}`), ' OR ')})
      GROUP BY c.id ORDER BY c.phone LIMIT 8`;
    return rows.map((row) => ({ id: row.id, phone: row.phone, name: row.name, address: row.address, orderCount: Number(row.orders) }));
  }

  /** The customer a phone number belongs to, for filling in the billing screen's customer form. */
  async lookup(auth: AuthContext, phone: string): Promise<CustomerLookupDto> {
    const customer = await this.prisma.customer.findFirst({
      where: { restaurantId: auth.restaurantId, phone },
      include: { _count: { select: { orders: { where: { status: { notIn: ['CANCELLED', 'MERGED'] } } } } } },
    });
    if (!customer) return { customer: null };
    return { customer: { id: customer.id, name: customer.name, phone: customer.phone, address: customer.address, orderCount: customer._count.orders } };
  }
}

/**
 * The digits of a number as typed, in the forms it may be on record in: as typed, without a leading country code, and
 * without a leading zero. Fewer than three digits match too much to be worth looking for.
 */
function numberForms(typed: string): string[] {
  const digits = typed.replace(/\D/g, '');
  return [digits, digits.startsWith('91') ? digits.slice(2) : '', digits.startsWith('0') ? digits.slice(1) : ''].filter((form) => form.length >= 3);
}

function toListItem(row: CustomerRow): CustomerListItemDto {
  return {
    id: row.id, name: row.name, phone: row.phone, address: row.address,
    orderCount: Number(row.orders), spentPaise: Number(row.spent), lastOrderAt: row.last_order?.toISOString() ?? null, createdAt: row.created_at.toISOString(),
  };
}
