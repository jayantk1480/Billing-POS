import type { DeviceNumbersDto } from '@pos/validation';
import { offlineDb } from './offline-store';

/**
 * The device's own numbering while offline: bills per financial year, orders per numbering period and kitchen tickets
 * per business day, in its own series (Z01). Kept in the device's database and taken inside one of its transactions,
 * so two tabs never take the same number.
 */
interface Counters {
  invoice: Record<string, number>;
  order: Record<string, number>;
  kot: Record<string, number>;
}

const countersKey = (restaurantId: string) => `numbers:${restaurantId}`;
const readCounters = (value: unknown): Counters => {
  const stored = (value ?? {}) as Partial<Counters>;
  return { invoice: { ...stored.invoice }, order: { ...stored.order }, kot: { ...stored.kot } };
};

/** Where the device's own series stand: the server's word, unless the device is already further on. */
export async function mergeNumbers(restaurantId: string, numbers: DeviceNumbersDto): Promise<void> {
  const db = offlineDb();
  if (!db) return;
  const key = countersKey(restaurantId);
  await db.transaction('rw', db.saved, async () => {
    const counters = readCounters((await db.saved.get(key))?.value);
    counters.invoice[numbers.financialYear] = Math.max(counters.invoice[numbers.financialYear] ?? 1, numbers.nextInvoiceNumber);
    counters.order[numbers.numberPeriod] = Math.max(counters.order[numbers.numberPeriod] ?? 1, numbers.nextOrderNumber);
    await db.saved.put({ key, value: counters, savedAt: new Date().toISOString() });
  });
}

/** Takes `count` numbers in a row from one counter and returns the first. */
export async function takeNumbers(restaurantId: string, kind: keyof Counters, key: string, count = 1): Promise<number> {
  const db = offlineDb();
  if (!db) throw new Error('This browser cannot keep bills on the device.');
  const stored = countersKey(restaurantId);
  return db.transaction('rw', db.saved, async () => {
    const counters = readCounters((await db.saved.get(stored))?.value);
    const first = counters[kind][key] ?? 1;
    counters[kind][key] = first + count;
    await db.saved.put({ key: stored, value: counters, savedAt: new Date().toISOString() });
    return first;
  });
}
