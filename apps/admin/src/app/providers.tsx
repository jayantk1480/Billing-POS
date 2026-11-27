'use client';

import { ApiRequestError } from '@pos/api-client';
import { errorMessage, toast, Toaster } from '@pos/ui';
import type { PlatformAdminDto, PlatformLoginInput } from '@pos/validation';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { listenForSignedOut, platform } from '@/lib/api';

type SessionState = { status: 'loading' } | { status: 'signedIn'; admin: PlatformAdminDto } | { status: 'signedOut'; expired: boolean };

export interface PlatformSession {
  admin: PlatformAdminDto | null;
  status: SessionState['status'];
  /** True when the session ended by itself (too old, or unused for too long) rather than by "Sign out". */
  expired: boolean;
  /** Set when the server could not be asked who is signed in; `retry` asks again. */
  error: string | null;
  retry: () => void;
  /** Rejects with the server's error when the email or password is wrong, or the account is locked. */
  signIn: (input: PlatformLoginInput) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<PlatformSession | null>(null);

export function usePlatformSession(): PlatformSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error('usePlatformSession must be used inside Providers');
  return session;
}

const isSignedOut = (error: unknown) => error instanceof ApiRequestError && error.status === 401;

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            // Retrying a "not found" or "signed out" answer will not change it; only retry transient failures.
            retry: (failures, error) => !(error instanceof ApiRequestError && error.status >= 400 && error.status < 500) && failures < 2,
          },
        },
      }),
  );
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const [error, setError] = useState<string | null>(null);

  // The cookie cannot be read from here, so the only way to know who is signed in is to ask.
  const check = useCallback(() => {
    setError(null);
    setState({ status: 'loading' });
    platform.me().then(
      (admin) => setState({ status: 'signedIn', admin }),
      (caught: unknown) => {
        if (isSignedOut(caught)) setState({ status: 'signedOut', expired: false });
        else setError(errorMessage(caught));
      },
    );
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  // Any request, from any screen, that the server answers with "not signed in" ends the session here.
  useEffect(() => {
    listenForSignedOut(() => setState((current) => (current.status === 'signedIn' ? { status: 'signedOut', expired: true } : current)));
    return () => listenForSignedOut(null);
  }, []);

  // Nothing one admin loaded stays in memory for whoever uses the browser next.
  useEffect(() => {
    if (state.status === 'signedOut') queryClient.clear();
  }, [state.status, queryClient]);

  const signIn = useCallback(async (input: PlatformLoginInput) => {
    const admin = await platform.login(input);
    setState({ status: 'signedIn', admin });
  }, []);

  const signOut = useCallback(async () => {
    try {
      await platform.logout();
    } catch (caught) {
      // Saying "signed out" while the server still holds the session would be untrue.
      if (!isSignedOut(caught)) {
        toast.error(`Could not sign out. ${errorMessage(caught)}`);
        return;
      }
    }
    setState({ status: 'signedOut', expired: false });
  }, []);

  const session = useMemo<PlatformSession>(
    () => ({
      admin: state.status === 'signedIn' ? state.admin : null,
      status: state.status,
      expired: state.status === 'signedOut' && state.expired,
      error,
      retry: check,
      signIn,
      signOut,
    }),
    [state, error, check, signIn, signOut],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
      <Toaster richColors closeButton position="top-right" />
    </QueryClientProvider>
  );
}
