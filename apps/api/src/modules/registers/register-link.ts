import type { Prisma } from '@pos/database';

type Tx = Prisma.TransactionClient;

/**
 * The cash register this user has open, or null. The session is held (shared) until the transaction ends,
 * so a register cannot be closed and counted while a payment into it is still being written.
 */
export async function openRegisterOf(tx: Tx, restaurantId: string, userId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM cash_register_sessions
    WHERE user_id = ${userId}::uuid AND restaurant_id = ${restaurantId}::uuid AND status = 'OPEN'
    FOR SHARE`;
  return rows[0]?.id ?? null;
}

/** The given register if it is still open (held as above), or null. */
export async function stillOpen(tx: Tx, restaurantId: string, sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM cash_register_sessions
    WHERE id = ${sessionId}::uuid AND restaurant_id = ${restaurantId}::uuid AND status = 'OPEN'
    FOR SHARE`;
  return rows[0]?.id ?? null;
}
