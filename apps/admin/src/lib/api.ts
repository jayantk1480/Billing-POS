import { ApiRequestError, createPlatformClient } from '@pos/api-client';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? 'Rasoi POS';

let onSignedOut: (() => void) | null = null;

/** The session provider registers here to hear when the server says nobody is signed in any more. */
export function listenForSignedOut(listener: (() => void) | null) {
  onSignedOut = listener;
}

/**
 * Every call of the client passes through here, so a session that ended (12 hours, or 2 hours unused) is
 * noticed in one place whichever screen made the request. The error still reaches the caller.
 */
function watched<T>(node: T): T {
  if (typeof node === 'function') {
    const call = node as (...args: unknown[]) => Promise<unknown>;
    return (async (...args: unknown[]) => {
      try {
        return await call(...args);
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 401) onSignedOut?.();
        throw error;
      }
    }) as T;
  }
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, watched(value)])) as T;
  }
  return node;
}

/** The admin app's single client. The session is an HttpOnly cookie, so there is no token here to hold. */
export const platform = watched(createPlatformClient({ baseUrl: API_URL }));

/** Query keys, so a change made on one screen can refresh what another shows. */
export const keys = {
  overview: ['platform', 'overview'] as const,
  restaurants: ['platform', 'restaurants'] as const,
  restaurant: (id: string) => ['platform', 'restaurant', id] as const,
};
