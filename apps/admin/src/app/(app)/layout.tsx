'use client';

import { Button, cn, ErrorState, LoadingState } from '@pos/ui';
import { LogOut, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { APP_NAME } from '@/lib/api';
import { usePlatformSession } from '../providers';

export default function AppLayout({ children }: { children: ReactNode }) {
  const session = usePlatformSession();
  const router = useRouter();
  const pathname = usePathname();
  const [signingOut, setSigningOut] = useState(false);

  // Covers "Sign out", a first visit without a session, and a session that ended while the app was open.
  useEffect(() => {
    if (session.status === 'signedOut') router.replace('/login');
  }, [session.status, router]);

  if (session.error) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <ErrorState message={session.error} onRetry={session.retry} />
      </main>
    );
  }
  if (!session.admin) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <LoadingState />
      </main>
    );
  }

  async function signOut() {
    setSigningOut(true);
    await session.signOut();
    setSigningOut(false);
  }

  // Restaurants is the only destination: the list is home and a restaurant's page sits under it.
  const onRestaurants = pathname === '/' || pathname.startsWith('/restaurants');

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:gap-5 sm:px-6 lg:px-8">
          <Link href="/" className="flex min-w-0 items-center gap-2.5" aria-label={`${APP_NAME} platform admin, restaurants`}>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink-900 text-white">
              <ShieldCheck className="size-4.5" aria-hidden />
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-sm font-semibold text-ink-900">{APP_NAME}</span>
              <span className="block truncate text-xs text-ink-500">Platform admin</span>
            </span>
          </Link>
          {/* On a phone the name above is the way home, so the bar keeps room for who is signed in. */}
          <nav aria-label="Main" className="hidden sm:block">
            <Link
              href="/"
              aria-current={onRestaurants ? 'page' : undefined}
              className={cn(
                'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                onRestaurants ? 'bg-brand-50 text-brand-700' : 'text-ink-700 hover:bg-canvas hover:text-ink-900',
              )}
            >
              Restaurants
            </Link>
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
            <span className="min-w-0 max-w-32 truncate text-sm text-ink-700 sm:max-w-56" title={session.admin.email}>
              {session.admin.name}
            </span>
            <Button variant="ghost" size="sm" className="shrink-0 px-2 sm:px-3" onClick={() => void signOut()} loading={signingOut} aria-label="Sign out">
              {!signingOut && <LogOut className="size-4" aria-hidden />}
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
    </div>
  );
}
