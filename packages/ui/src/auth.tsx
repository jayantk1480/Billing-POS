'use client';

import type { ApiClient, AuthState } from '@pos/api-client';
import type { PermissionKey } from '@pos/types';
import type { AuthUser } from '@pos/validation';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';

const ApiContext = createContext<ApiClient | null>(null);

/** Provides the API client and restores the session from the refresh cookie on first load. */
export function AuthProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  useEffect(() => {
    if (api.auth.getState().status === 'loading') void api.auth.restore();
  }, [api]);
  return <ApiContext value={api}>{children}</ApiContext>;
}

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi must be used inside AuthProvider');
  return api;
}

export interface Auth {
  state: AuthState;
  user: AuthUser | null;
  /** True when the signed-in user's role holds every listed permission. */
  can: (...permissions: PermissionKey[]) => boolean;
}

export function useAuth(): Auth {
  const api = useApi();
  const state = useSyncExternalStore(api.auth.subscribe, api.auth.getState, api.auth.getState);
  return useMemo(() => {
    const user = state.status === 'signedIn' ? state.user : null;
    return { state, user, can: (...permissions) => permissions.every((p) => user?.permissions.includes(p) ?? false) };
  }, [state]);
}
