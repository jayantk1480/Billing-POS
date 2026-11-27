'use client';

import { toast } from '@pos/ui';
import type { AuthUser, SyncOperationInput } from '@pos/validation';
import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from './api';
import { isUnreachable, useConnection } from './connection';
import { storedDeviceKey } from './device';
import { mergeNumbers } from './offline-numbers';
import { madeOffline, offlineDb, type OfflineSale } from './offline-store';

/** How many operations go up in one request: the server takes at most 25. */
const BATCH = 25;
/** How often a device with work waiting tries again while the server answers. */
const RETRY_MS = 20_000;
/** Sales made offline are kept on the device for reprinting this long after they were uploaded. */
const KEEP_SALES_DAYS = 7;

interface OutboxState {
  /** Operations of the signed-in restaurant waiting on this device. */
  pending: number;
  uploading: boolean;
}

/** What is waiting to be uploaded from this device. */
export const useOutbox = create<OutboxState>(() => ({ pending: 0, uploading: false }));

let countedFor: string | null = null;

/** Counts again what the restaurant has waiting on this device. */
export async function refreshPending(restaurantId: string | null = countedFor): Promise<number> {
  countedFor = restaurantId;
  const db = offlineDb();
  const pending = restaurantId && db ? await db.outbox.where('restaurantId').equals(restaurantId).count().catch(() => 0) : 0;
  useOutbox.setState({ pending });
  return pending;
}

let wake: (() => void) | null = null;
/** Asks the uploader to try now, if it is running (signed in and online). */
export const requestUpload = () => wake?.();

/**
 * Keeps work done offline, in the order it was done, until it has been uploaded; with the sale it belongs to, if any,
 * for printing again. Everything is written together or not at all.
 */
export async function enqueue(restaurantId: string, operations: SyncOperationInput[], sale?: OfflineSale): Promise<void> {
  const db = offlineDb();
  if (!db) throw new Error('This browser cannot keep bills on the device.');
  const createdAt = new Date().toISOString();
  await db.transaction('rw', db.outbox, db.sales, async () => {
    await db.outbox.bulkAdd(operations.map((operation) => ({ id: operation.id, restaurantId, operation, createdAt })));
    if (sale) await db.sales.put(sale);
  });
  await refreshPending(restaurantId);
  requestUpload();
}

/** Sends one batch. Returns false when there is nothing left, or the rest has to wait. */
async function uploadBatch(user: AuthUser, deviceKey: string): Promise<boolean> {
  const db = offlineDb();
  if (!db) return false;
  // Entries of one restaurant, in the order they were added.
  const batch = await db.outbox.where('restaurantId').equals(user.restaurantId).limit(BATCH).toArray();
  if (batch.length === 0) return false;
  const total = await db.outbox.where('restaurantId').equals(user.restaurantId).count();
  const response = await api.sync.push({ deviceKey, pending: total - batch.length, operations: batch.map((entry) => entry.operation) });
  await mergeNumbers(user.restaurantId, response.numbers);

  const finished = new Set(response.results.filter((result) => result.outcome !== 'DEFERRED').map((result) => result.id));
  await db.outbox.bulkDelete(batch.filter((entry) => finished.has(entry.id)).map((entry) => entry.seq!));
  // Bills and tickets the server now has are printed and paid through it, like any other.
  for (const entry of batch) {
    if (!finished.has(entry.id)) continue;
    if (entry.operation.type === 'invoice.issue') madeOffline.delete(entry.operation.invoice.id);
    if (entry.operation.type === 'kot.print') madeOffline.delete(entry.operation.kot.id);
  }
  for (const result of response.results) {
    // Nothing is lost: the server keeps what it refused, for the owner, under Sales, Offline uploads.
    if (result.outcome === 'REJECTED') toast.error(`Something made offline could not be stored: ${result.message ?? result.code}. The owner can see it under Offline uploads.`, { duration: 15_000 });
  }
  await refreshPending(user.restaurantId);
  return finished.size === batch.length;
}

/** Drops sales made offline once they are uploaded and a week old. */
async function forgetOldSales(restaurantId: string): Promise<void> {
  const db = offlineDb();
  if (!db || (await db.outbox.where('restaurantId').equals(restaurantId).count()) > 0) return;
  const before = new Date(Date.now() - KEEP_SALES_DAYS * 86_400_000).toISOString().slice(0, 10);
  await db.sales.where('businessDate').below(before).delete();
}

/** Runs `work` in one tab of this browser at a time; another tab already uploading means this one need not. */
async function inOneTab(work: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return work();
  await locks.request('pos-upload', { ifAvailable: true }, async (lock) => {
    if (lock) await work();
  });
}

/**
 * Uploads the work done offline whenever the server can be reached: at once when the connection comes back or
 * something is added, and again every little while while anything is left. Use once, for the signed-in person.
 */
export function useOutboxUploader(user: AuthUser | null, confirmed: boolean): void {
  const online = useConnection((state) => state.online);

  useEffect(() => {
    void refreshPending(user?.restaurantId ?? null);
  }, [user?.restaurantId]);

  useEffect(() => {
    // Uploads need a sign-in the server has accepted, from the same restaurant as the work.
    if (!user || !confirmed || online !== true) return;
    const deviceKey = storedDeviceKey();
    if (!deviceKey) return;
    let stopped = false;
    let running = false;
    const run = async () => {
      if (running || stopped) return;
      running = true;
      useOutbox.setState({ uploading: true });
      try {
        await inOneTab(async () => {
          while (!stopped && (await uploadBatch(user, deviceKey)));
          await forgetOldSales(user.restaurantId);
        });
      } catch (error) {
        // The server went away again: the next check of the connection brings it back here.
        if (!isUnreachable(error)) toast.error(`Bills made offline could not be uploaded yet: ${error instanceof Error ? error.message : String(error)}`, { id: 'upload-failed' });
      } finally {
        running = false;
        useOutbox.setState({ uploading: false });
      }
    };
    wake = () => void run();
    void run();
    const timer = window.setInterval(() => {
      if (useOutbox.getState().pending > 0) void run();
    }, RETRY_MS);
    return () => {
      stopped = true;
      wake = null;
      window.clearInterval(timer);
    };
  }, [user, confirmed, online]);
}
