'use client';

import type { RealtimeEvent } from '@pos/types';
import { useEffect, useRef, useState } from 'react';
import { useApi } from './auth';

/**
 * Listens for live "something changed" notices while the component is mounted.
 * Returns whether the live connection is currently up, for a status indicator.
 */
export function useRealtime(onEvent: (event: RealtimeEvent, payload: Record<string, unknown>) => void, enabled = true): boolean {
  const api = useApi();
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const close = api.realtime.connect((event, payload) => handler.current(event, payload), setConnected);
    return () => {
      close();
      setConnected(false);
    };
  }, [api, enabled]);

  return connected;
}
