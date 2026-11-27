import type { InvoiceDto, SyncOperationInput } from '@pos/validation';
import Dexie, { type EntityTable } from 'dexie';

interface Saved {
  key: string;
  value: unknown;
  /** When the value was last saved, as an ISO time. */
  savedAt: string;
}

/** Work done offline, waiting to be uploaded, in the order it was done. */
export interface OutboxEntry {
  /** Given by the database in the order entries are added: the order they are uploaded in. */
  seq?: number;
  /** The operation's own id, which the server applies it under exactly once. */
  id: string;
  restaurantId: string;
  operation: SyncOperationInput;
  createdAt: string;
}

/** A bill made offline, kept on the device as printed, so it can be printed again and listed. */
export interface OfflineSale {
  invoiceId: string;
  restaurantId: string;
  businessDate: string;
  invoice: InvoiceDto;
  createdAt: string;
}

/**
 * The POS's database on the device (IndexedDB): the last menu and settings each till received, and the work done
 * while the internet was down, until it has been uploaded.
 */
class OfflineDatabase extends Dexie {
  saved!: EntityTable<Saved, 'key'>;
  outbox!: EntityTable<OutboxEntry, 'seq'>;
  sales!: EntityTable<OfflineSale, 'invoiceId'>;

  constructor() {
    super('pos-offline');
    this.version(1).stores({ saved: 'key' });
    this.version(2).stores({ saved: 'key', outbox: '++seq, restaurantId', sales: 'invoiceId, restaurantId, businessDate' });
  }
}

let database: OfflineDatabase | null = null;
/** The database, or null where the browser has none (some private windows). */
export const offlineDb = () => (typeof indexedDB === 'undefined' ? null : (database ??= new OfflineDatabase()));

/** Keeps a copy of `value` on the device. A device that cannot store it (private window, storage full) keeps none. */
export async function remember(key: string, value: unknown): Promise<void> {
  try {
    await offlineDb()?.saved.put({ key, value, savedAt: new Date().toISOString() });
  } catch {
    // Nothing kept: the POS works online as before and cannot open offline.
  }
}

/** The copy kept under `key`, with when it was saved, or null. */
export async function recall<T>(key: string): Promise<{ value: T; savedAt: string } | null> {
  try {
    const row = await offlineDb()?.saved.get(key);
    return row ? { value: row.value as T, savedAt: row.savedAt } : null;
  } catch {
    return null;
  }
}

/**
 * Bills and kitchen tickets made on this device offline that the server does not have yet, as far as this session
 * knows: they are printed and paid on the device. Once uploaded, they are the server's like any other.
 */
export const madeOffline = new Set<string>();
