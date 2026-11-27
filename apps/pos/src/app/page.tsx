'use client';

import { LoadingState, useAuth } from '@pos/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { LockScreen, SignInScreen, TerminalScreen, UnreachableScreen } from '@/components/auth-screens';
import { BillingScreen } from '@/components/billing-screen';
import { useConnectionWatch } from '@/lib/connection';
import { useOutboxUploader } from '@/lib/outbox';

/** The POS is one screen that changes with the sign-in state, so it keeps working as an installed app. */
export default function PosPage() {
  const { state, user } = useAuth();
  const queryClient = useQueryClient();
  useConnectionWatch();
  // Work done offline goes up once the server has accepted this sign-in again.
  useOutboxUploader(user, state.status === 'signedIn' && !state.offline);

  // Never show one user's cached lists to the next person at the terminal.
  useEffect(() => {
    if (state.status !== 'signedIn') queryClient.clear();
  }, [state.status, queryClient]);

  if (state.status === 'loading') return <main className="flex min-h-dvh items-center justify-center"><LoadingState /></main>;
  if (state.status === 'locked') return <LockScreen />;
  if (state.status === 'unreachable') return <UnreachableScreen />;
  if (!user) return <SignInScreen />;
  if (!user.terminalId) return <TerminalScreen />;
  return <BillingScreen />;
}
