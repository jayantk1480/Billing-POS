import type { Prisma } from '@pos/database';

/**
 * Every customer named on an order is a record of its own, identified by mobile number: one number, one customer
 * (the back office lists them under Sales, Customers). An order with a number already on record joins that customer.
 * Details typed replace those on record; a field left empty keeps what was there. Returns the customer's id.
 */
export async function saveCustomerRecord(
  tx: Prisma.TransactionClient, restaurantId: string, customer: { phone: string; name?: string | null; address?: string | null },
): Promise<string> {
  // Two tills can type the same new number at the same moment; the second waits for the first and then finds it.
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`customer:${restaurantId}:${customer.phone}`}, 0))`;
  const typed = { name: customer.name ?? undefined, address: customer.address ?? undefined };
  const record = await tx.customer.upsert({
    where: { restaurantId_phone: { restaurantId, phone: customer.phone } },
    update: typed,
    create: { restaurantId, phone: customer.phone, name: typed.name ?? null, address: typed.address ?? null },
  });
  return record.id;
}

