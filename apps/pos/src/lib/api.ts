import { createApiClient, type SessionStore } from '@pos/api-client';
import type { AuthUser } from '@pos/validation';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? 'Rasoi POS';

/** Payment methods as they are shown to people. */
export const METHOD_LABEL: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', OTHER: 'Other' };

const SESSION_KEY = 'pos.session';
/** How long after its last contact with the server a device may still open offline as the person signed in on it. */
export const OFFLINE_DAYS = 5;

/**
 * Who was last signed in on this device, as the server described them, so that the POS opens offline as them when the
 * internet is down. Never a token: nothing here lets anyone reach the server. Renewed on every contact with the
 * server; forgotten on signing out, on locking, and after OFFLINE_DAYS without contact.
 */
const sessionStore: SessionStore = {
  get() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(SESSION_KEY) ?? 'null') as { user?: AuthUser; savedAt?: string } | null;
      const user = saved?.user;
      if (!user || typeof user.id !== 'string' || typeof user.restaurantId !== 'string' || !Array.isArray(user.permissions)) return null;
      const age = Date.now() - Date.parse(saved.savedAt ?? '');
      return age >= 0 && age < OFFLINE_DAYS * 86_400_000 ? user : null;
    } catch {
      return null;
    }
  },
  set(user) {
    try {
      if (user) window.localStorage.setItem(SESSION_KEY, JSON.stringify({ user, savedAt: new Date().toISOString() }));
      else window.localStorage.removeItem(SESSION_KEY);
    } catch {
      // Storage is blocked (a private window, say): the POS then cannot open offline, and works as before online.
    }
  },
};

/** The POS terminal's single API client. */
export const api = createApiClient({ baseUrl: API_URL, client: 'pos', sessionStore });
