'use client';

import { LoadingState, useAuth } from '@pos/ui';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { homePath } from '@/lib/nav';

/** Sends the visitor to sign-in or to their first permitted page. */
export default function IndexPage() {
  const { state, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (state.status === 'signedIn') router.replace(homePath(user));
    else if (state.status !== 'loading') router.replace('/login');
  }, [state.status, user, router]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <LoadingState />
    </main>
  );
}
