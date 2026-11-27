'use client';

import { ApiRequestError } from '@pos/api-client';
import { AuthProvider, Toaster } from '@pos/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { api } from '@/lib/api';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            // Retrying a "not found" or "forbidden" answer will not change it; only retry transient failures.
            retry: (failures, error) => !(error instanceof ApiRequestError && error.status >= 400 && error.status < 500) && failures < 2,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider api={api}>{children}</AuthProvider>
      <Toaster richColors closeButton position="top-right" />
    </QueryClientProvider>
  );
}
