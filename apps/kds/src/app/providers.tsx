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
            staleTime: 5_000,
            refetchOnWindowFocus: true,
            retry: (failures, error) => !(error instanceof ApiRequestError && error.status >= 400 && error.status < 500) && failures < 2,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider api={api}>{children}</AuthProvider>
      <Toaster richColors closeButton position="top-center" />
    </QueryClientProvider>
  );
}
