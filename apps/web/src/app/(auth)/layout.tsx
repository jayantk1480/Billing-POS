'use client';

import { useAuth } from '@pos/ui';
import { ChefHat } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { APP_NAME } from '@/lib/api';
import { homePath } from '@/lib/nav';

export default function AuthLayout({ children }: { children: ReactNode }) {
  const { state, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (state.status === 'signedIn') router.replace(homePath(user));
  }, [state.status, user, router]);

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden bg-ink-900 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="absolute -right-24 -top-24 size-96 rounded-full bg-brand-600/30 blur-3xl" aria-hidden />
        <div className="absolute -bottom-32 -left-16 size-96 rounded-full bg-brand-500/20 blur-3xl" aria-hidden />
        <div className="relative flex items-center gap-2.5 text-lg font-semibold">
          <span className="flex size-9 items-center justify-center rounded-xl bg-brand-600">
            <ChefHat className="size-5" />
          </span>
          {APP_NAME}
        </div>
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">Billing, tables and kitchen tickets in one place.</h2>
          <p className="mt-4 text-sm leading-relaxed text-slate-300">
            Manage your menu, taxes and team from the back office. Changes reach every billing counter straight away.
          </p>
        </div>
        <p className="relative text-xs text-slate-400">GST-ready invoices · Works when the internet drops</p>
      </section>
      <section className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 text-lg font-semibold text-ink-900 lg:hidden">
            <span className="flex size-9 items-center justify-center rounded-xl bg-brand-600 text-white">
              <ChefHat className="size-5" />
            </span>
            {APP_NAME}
          </div>
          {children}
        </div>
      </section>
    </main>
  );
}
