import { Prisma } from '@pos/database';

type Tx = Prisma.TransactionClient;

/** What was removed, kept in the audit log: the only place an erased bill is still recorded. */
export interface ErasedBill {
  invoiceNumber: string;
  status: string;
  businessDate: string;
  totalPaise: number;
  paidPaise: number;
  payments: { method: string; amountPaise: number }[];
  refunds: { creditNoteNumber: string; amountPaise: number }[];
}

/**
 * Bills (or credit notes) whose number changed when a gap was closed, kept in the audit log.
 * `moved` is in runs: numbers `from`..`to` each moved by `by`. A printed copy still shows the old number.
 */
export interface RenumberedSeries {
  series: string;
  count: number;
  moved: { from: number; to: number; by: number }[];
}

/**
 * A series, and the number to close gaps from. Gaps are always closed from the start of the series, so that
 * "no missing numbers" holds for the whole series and not only above the bill that was just erased.
 */
interface SeriesStart {
  seriesId: string;
  from: number;
}

/**
 * The database refuses to change or delete bills, payments and refunds. This lifts that for the
 * statements run inside `work`, in this transaction only. Callers check the permission first and
 * write an audit entry in the same transaction. If `work` fails the transaction rolls back, and the setting with it.
 */
export async function withOwnerOverride<T>(tx: Tx, work: () => Promise<T>): Promise<T> {
  await tx.$queryRaw`SELECT set_config('app.owner_override', 'on', true)`;
  const result = await work();
  await tx.$queryRaw`SELECT set_config('app.owner_override', 'off', true)`;
  return result;
}

/**
 * Holds an order until the transaction ends. Everything that changes an order's bills takes this
 * first (billing, paying, refunding, cancelling, erasing), so two such changes to the same order
 * happen one after the other and the second sees what the first did.
 */
export async function lockOrder(tx: Tx, restaurantId: string, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid AND restaurant_id = ${restaurantId}::uuid FOR UPDATE`;
}

/** The series the bills and credit notes of an order sit in, each with the lowest number the order holds there. */
async function seriesOf(tx: Tx, restaurantId: string, orderId: string, standingOnly: boolean): Promise<SeriesStart[]> {
  const standing = standingOnly ? Prisma.sql`AND i.status = 'ISSUED'` : Prisma.empty;
  const rows = await tx.$queryRaw<{ series_id: string; from: number }[]>`
    SELECT DISTINCT i.series_id, 1 AS "from" FROM invoices i
    WHERE i.order_id = ${orderId}::uuid AND i.restaurant_id = ${restaurantId}::uuid ${standing}
    UNION
    SELECT DISTINCT r.series_id, 1 AS "from" FROM refunds r JOIN invoices i ON i.id = r.invoice_id
    WHERE i.order_id = ${orderId}::uuid AND i.restaurant_id = ${restaurantId}::uuid ${standing}`;
  return rows.map((row) => ({ seriesId: row.series_id, from: row.from }));
}

/**
 * The series among these that belong to a device's hidden offline till. Their numbers are given on the device, which
 * may hold bills the server has not seen yet, so they are never compacted and their counters never moved back: an
 * erased offline bill leaves a gap, recorded in the audit entry of the erase.
 */
async function offlineSeries(tx: Tx, seriesIds: string[]): Promise<Set<string>> {
  if (seriesIds.length === 0) return new Set();
  const rows = await tx.numberSeries.findMany({ where: { id: { in: seriesIds }, terminal: { kind: 'OFFLINE' } }, select: { id: true } });
  return new Set(rows.map((row) => row.id));
}

/**
 * Takes every order lock an erase will need, in one statement and in id order, before any bill is touched:
 * the order itself; with `closeGaps`, every order with a bill or credit note in the same series, since any of them
 * may move up; and with `laterOrders`,
 * the orders whose order number will move up. Taking them all at once, in a fixed order, is what stops two
 * such changes from blocking each other for good.
 */
export async function lockForErase(
  tx: Tx, restaurantId: string, orderId: string,
  options: { standingOnly?: boolean; closeGaps?: boolean; laterOrders?: { series: string; numberPeriod: string; after: number } },
): Promise<void> {
  const starts = options.closeGaps ? await seriesOf(tx, restaurantId, orderId, options.standingOnly ?? false) : [];
  const ids = starts.map((start) => start.seriesId);
  const froms = starts.map((start) => start.from);
  const moving = starts.length > 0
    ? Prisma.sql`
        OR o.id IN (SELECT i.order_id FROM invoices i JOIN unnest(${ids}::uuid[], ${froms}::int[]) AS s(series_id, from_number) ON i.series_id = s.series_id AND i.number > s.from_number)
        OR o.id IN (SELECT i.order_id FROM refunds r JOIN invoices i ON i.id = r.invoice_id
                    JOIN unnest(${ids}::uuid[], ${froms}::int[]) AS s(series_id, from_number) ON r.series_id = s.series_id AND r.number > s.from_number)`
    : Prisma.empty;
  const later = options.laterOrders
    ? Prisma.sql`OR (o.series = ${options.laterOrders.series} AND o.number_period = ${options.laterOrders.numberPeriod} AND o.order_number > ${options.laterOrders.after})`
    : Prisma.empty;
  await tx.$queryRaw`
    SELECT o.id FROM orders o
    WHERE o.restaurant_id = ${restaurantId}::uuid AND (o.id = ${orderId}::uuid ${moving} ${later})
    ORDER BY o.id FOR UPDATE`;
}

/**
 * Closes the gaps in the given series from the given numbers upwards, so the bills after an erased one move up.
 * The caller holds the orders those bills belong to (see lockForErase). Returns what moved, for the audit log.
 */
export async function compactSeries(tx: Tx, starts: SeriesStart[]): Promise<RenumberedSeries[]> {
  const offline = await offlineSeries(tx, starts.map((start) => start.seriesId));
  const lowest = new Map<string, number>();
  for (const start of starts) {
    if (offline.has(start.seriesId)) continue;
    lowest.set(start.seriesId, Math.min(start.from, lowest.get(start.seriesId) ?? start.from));
  }
  const result: RenumberedSeries[] = [];
  for (const seriesId of [...lowest.keys()].sort()) {
    const rows = await withOwnerOverride(tx, () =>
      tx.$queryRaw<{ old_number: number; new_number: number }[]>`SELECT old_number, new_number FROM compact_series(${seriesId}::uuid, ${lowest.get(seriesId)!}::int)`,
    );
    if (rows.length === 0) continue;
    const series = await tx.numberSeries.findUniqueOrThrow({ where: { id: seriesId } });
    const moved: RenumberedSeries['moved'] = [];
    for (const row of rows) {
      const by = row.new_number - row.old_number;
      const last = moved.at(-1);
      if (last && last.by === by && last.to === row.old_number - 1) last.to = row.old_number;
      else moved.push({ from: row.old_number, to: row.old_number, by });
    }
    result.push({ series: `${series.prefix}/${series.financialYear}`, count: rows.length, moved });
  }
  return result;
}

/**
 * Permanently removes the bills of an order, with the payments, refunds and credit notes against them.
 * The caller holds the order (see lockOrder or lockForErase). With `standingOnly`, bills already cancelled are
 * left as the records they are; deleting the order itself has to take them too.
 *
 * With `closeGaps` the bills after the erased ones move up, so no number is missing. Without it the series
 * counter ends up one past the highest number still in use: a number freed at the end of its series is handed
 * out again, and one freed in the middle stays as a gap.
 */
export async function eraseBills(
  tx: Tx, restaurantId: string, orderId: string, options: { standingOnly?: boolean; closeGaps?: boolean } = {},
): Promise<{ erased: ErasedBill[]; renumbered: RenumberedSeries[]; starts: SeriesStart[] }> {
  const where = { orderId, restaurantId, ...(options.standingOnly ? { status: 'ISSUED' as const } : {}) };
  const ids = (await tx.invoice.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } })).map((invoice) => invoice.id);
  if (ids.length === 0) return { erased: [], renumbered: [], starts: [] };
  // Bills first, then series: the same order a refund takes them in, so the two cannot deadlock.
  await tx.$queryRaw`SELECT id FROM invoices WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
  // Read only now that nothing can be paid or refunded against these bills any more.
  const invoices = await tx.invoice.findMany({ where: { id: { in: ids } }, include: { payments: true, refunds: true }, orderBy: [{ issuedAt: 'asc' }, { number: 'asc' }] });
  const invoiceIds = invoices.map((invoice) => invoice.id);
  const refunds = invoices.flatMap((invoice) => invoice.refunds);
  const seriesIds = [...new Set([...invoices.map((invoice) => invoice.seriesId), ...refunds.map((refund) => refund.seriesId)])].sort();
  const starts: SeriesStart[] = seriesIds.map((seriesId) => ({ seriesId, from: 1 }));

  // No bill may take a number from these series while their counters are being moved back.
  await tx.$queryRaw`SELECT id FROM number_series WHERE id = ANY(${seriesIds}::uuid[]) ORDER BY id FOR UPDATE`;

  await withOwnerOverride(tx, async () => {
    await tx.refundItem.deleteMany({ where: { refundId: { in: refunds.map((refund) => refund.id) } } });
    await tx.refund.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await tx.payment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await tx.invoiceTax.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await tx.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
  });

  let renumbered: RenumberedSeries[] = [];
  if (options.closeGaps) {
    renumbered = await compactSeries(tx, starts);
  } else {
    const offline = await offlineSeries(tx, seriesIds);
    for (const seriesId of seriesIds) {
      if (offline.has(seriesId)) continue;
      const lastInvoice = await tx.invoice.aggregate({ where: { seriesId }, _max: { number: true } });
      const lastRefund = await tx.refund.aggregate({ where: { seriesId }, _max: { number: true } });
      await tx.numberSeries.update({ where: { id: seriesId }, data: { nextNumber: Math.max(lastInvoice._max.number ?? 0, lastRefund._max.number ?? 0) + 1 } });
    }
  }

  const erased = invoices.map((invoice) => ({
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    businessDate: invoice.businessDate.toISOString().slice(0, 10),
    totalPaise: invoice.totalPaise,
    paidPaise: invoice.paidPaise,
    payments: invoice.payments.map((payment) => ({ method: payment.method, amountPaise: payment.amountPaise })),
    refunds: invoice.refunds.map((refund) => ({ creditNoteNumber: refund.creditNoteNumber, amountPaise: refund.amountPaise })),
  }));
  return { erased, renumbered, starts };
}
