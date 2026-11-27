'use client';

import { ApiRequestError } from '@pos/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from './api';

/**
 * Whether an error means the server could not be reached: no connection, or the server down behind its proxy. Any
 * other answer, even a refusal, means it is there.
 */
export function isUnreachable(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.code === 'NETWORK' || error.status >= 500);
}

/** How far the device's clock is from the server's, as last measured. */
export interface Clock {
  /** Server time minus device time. Positive: the device is slow. */
  offsetMs: number;
  checkedAt: string;
}

const CLOCK_KEY = 'pos.clock';
/** How often the server is checked while it answers, and while it does not. */
const ONLINE_EVERY = 30_000;
const OFFLINE_EVERY = 5_000;
/** A measurement over a slower round trip than this says too little about the clock. */
const CLOCK_ROUND_TRIP_LIMIT = 5_000;
/** A device clock further off than this is shown as wrong. */
export const CLOCK_TOLERANCE_MS = 5 * 60_000;

function readClock(): Clock | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(CLOCK_KEY) ?? 'null') as Clock | null;
    return saved && Number.isFinite(saved.offsetMs) ? saved : null;
  } catch {
    return null;
  }
}

interface ConnectionState {
  /** Whether the server answers, as last checked; null before the first check. */
  online: boolean | null;
  clock: Clock | null;
}

/**
 * Whether this device can reach the server. Decided by asking the server itself (its health check), not by the
 * browser's online flag, which says only that some network is there.
 */
export const useConnection = create<ConnectionState>(() => ({ online: null, clock: typeof window === 'undefined' ? null : readClock() }));

let checking: Promise<boolean> | null = null;

/** Asks the server whether it is there, and measures the device's clock against its time. Concurrent callers share one. */
export function checkConnection(): Promise<boolean> {
  checking ??= (async () => {
    const sent = Date.now();
    try {
      const health = await api.health();
      const received = Date.now();
      // The database or Redis being down makes every other request fail: as good as unreachable.
      const online = health.status === 'ok';
      let clock = useConnection.getState().clock;
      if (online && received - sent < CLOCK_ROUND_TRIP_LIMIT && Number.isFinite(Date.parse(health.time))) {
        clock = { offsetMs: Date.parse(health.time) - Math.round((sent + received) / 2), checkedAt: new Date(received).toISOString() };
        try {
          window.localStorage.setItem(CLOCK_KEY, JSON.stringify(clock));
        } catch {
          // Kept for this session only.
        }
      }
      useConnection.setState({ online, clock });
      return online;
    } catch (error) {
      const online = !isUnreachable(error);
      useConnection.setState({ online });
      return online;
    } finally {
      checking = null;
    }
  })();
  return checking;
}

/** Whether the app opened without the server and has not yet confirmed its sign-in with it. */
function waitingForServer(): boolean {
  const state = api.auth.getState();
  return state.status === 'unreachable' || (state.status === 'signedIn' && state.offline === true);
}

/**
 * Keeps checking whether the server can be reached: every few seconds while it cannot, now and then while it can, and
 * at once when the browser says the network came back or a request finds the server gone. When the server is back,
 * a sign-in remembered offline is confirmed with it and every list is fetched again. Use once, at the top of the app.
 */
export function useConnectionWatch(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const schedule = () => {
      clearTimeout(timer);
      if (stopped) return;
      const steady = useConnection.getState().online === true && !waitingForServer();
      timer = setTimeout(() => void tick(), steady ? ONLINE_EVERY : OFFLINE_EVERY);
    };
    const tick = async () => {
      const wasOnline = useConnection.getState().online;
      const online = await checkConnection();
      if (online && waitingForServer()) await api.auth.restore();
      if (online && wasOnline === false) void queryClient.invalidateQueries();
      schedule();
    };

    const onOnline = () => void tick();
    // The browser is sure there is no network at all; whether there is a working one is for the server to say.
    const onOffline = () => {
      useConnection.setState({ online: false });
      schedule();
    };
    // A list that could not be fetched because the server was gone: check now rather than at the next turn.
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error' && isUnreachable(event.action.error) && useConnection.getState().online !== false) {
        void tick();
      }
    });

    void tick();
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      stopped = true;
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [queryClient]);
}
