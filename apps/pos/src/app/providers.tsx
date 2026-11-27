'use client';

import { ApiRequestError } from '@pos/api-client';
import { AuthProvider, Toaster } from '@pos/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ApprovalProvider } from '@/lib/approval';
import { registerServiceWorker } from '@/lib/service-worker';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: false,
            retry: (failures, error) => !(error instanceof ApiRequestError && error.status >= 400 && error.status < 500) && failures < 2,
          },
        },
      }),
  );
  // Keeps the app on the device so it opens without the internet.
  useEffect(registerServiceWorker, []);
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider api={api}>
        <ApprovalProvider>{children}</ApprovalProvider>
      </AuthProvider>
      <Toaster richColors closeButton position="top-center" />
    </QueryClientProvider>
  );
}
