'use client';

import type { AuthUser, PosBootstrap } from '@pos/validation';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { isUnreachable } from './connection';
import { recall, remember } from './offline-store';

export interface LoadedBootstrap {
  boot: PosBootstrap;
  /** Set when the server could not be reached and this is the copy kept on the device: when that copy was saved. */
  savedAt: string | null;
}

/**
 * The menu, taxes, tables and settings for the signed-in till. Every answer is kept on the device; when the server
 * cannot be reached, the copy kept last is used instead, so the POS opens offline with the menu it last had.
 */
export function useBootstrap(user: AuthUser | null) {
  const restaurantId = user?.restaurantId ?? null;
  const terminalId = user?.terminalId ?? null;
  const key = `bootstrap:${restaurantId}:${terminalId}`;
  return useQuery({
    // Other screens refetch it by its first part alone.
    queryKey: ['pos-bootstrap', restaurantId, terminalId],
    enabled: restaurantId !== null && terminalId !== null,
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async (): Promise<LoadedBootstrap> => {
      try {
        const boot = await api.pos.bootstrap();
        await remember(key, boot);
        return { boot, savedAt: null };
      } catch (error) {
        if (!isUnreachable(error)) throw error;
        const saved = await recall<PosBootstrap>(key);
        if (!saved) throw error;
        return { boot: saved.value, savedAt: saved.savedAt };
      }
    },
  });
}
