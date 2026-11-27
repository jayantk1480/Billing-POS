'use client';

import { cn, LoadingState, useApi, useAuth } from '@pos/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ChefHat, LogOut, Menu, UserRound, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { APP_NAME } from '@/lib/api';
import { SubscriptionBanner } from '@/components/subscription-banner';
import { canOpen, NAV } from '@/lib/nav';

export default function AppLayout({ children }: { children: ReactNode }) {
  const api = useApi();
  const { state, user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (state.status === 'signedOut' || state.status === 'locked') {
      queryClient.clear();
      router.replace('/login');
    }
  }, [state.status, router, queryClient]);

  useEffect(() => setMenuOpen(false), [pathname]);

  if (!user) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <LoadingState />
      </main>
    );
  }

  const current = NAV.flatMap((section) => section.items).find((item) => pathname.startsWith(item.href));
  const allowed = !current || canOpen(current, user);
  const sections = NAV.map((section) => ({ ...section, items: section.items.filter((item) => canOpen(item, user)) })).filter(
    (section) => section.items.length > 0,
  );

  const sidebar = (
    <nav className="flex h-full flex-col" aria-label="Main">
      <div className="flex h-16 items-center gap-2.5 px-5 text-base font-semibold text-ink-900">
        <span className="flex size-8 items-center justify-center rounded-lg bg-brand-600 text-white">
          <ChefHat className="size-4.5" />
        </span>
        <span className="truncate">{APP_NAME}</span>
      </div>
      <div className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        {sections.map((section) => (
          <div key={section.title}>
            <p className="px-3 text-xs font-medium uppercase tracking-wider text-ink-500">{section.title}</p>
            <ul className="mt-2 space-y-0.5">
              {section.items.map((item) => {
                const active = pathname.startsWith(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                        active ? 'bg-brand-50 text-brand-700' : 'text-ink-700 hover:bg-canvas hover:text-ink-900',
                      )}
                    >
                      <item.icon className="size-4.5 shrink-0" />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-line p-3">
        <Link
          href="/account"
          className={cn('flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-canvas', pathname.startsWith('/account') && 'bg-brand-50')}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink-900 text-white">
            <UserRound className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-ink-900">{user.name}</span>
            <span className="block truncate text-xs text-ink-500">
              {user.role.name} · {user.restaurantName}
            </span>
          </span>
        </Link>
        <button
          type="button"
          onClick={() => void api.auth.logout()}
          className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-ink-700 hover:bg-canvas hover:text-ink-900"
        >
          <LogOut className="size-4.5" /> Sign out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line bg-surface lg:block">{sidebar}</aside>

      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface px-4 lg:hidden">
        <button type="button" onClick={() => setMenuOpen(true)} aria-label="Open menu" className="rounded-lg p-2 text-ink-700 hover:bg-canvas">
          <Menu className="size-5" />
        </button>
        <span className="text-sm font-semibold text-ink-900">{current?.label ?? APP_NAME}</span>
      </header>
      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-ink-900/40" onClick={() => setMenuOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-surface shadow-xl">
            <button type="button" onClick={() => setMenuOpen(false)} aria-label="Close menu" className="absolute right-3 top-4 rounded-lg p-1.5 text-ink-500 hover:bg-canvas">
              <X className="size-4" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <SubscriptionBanner />
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {allowed ? (
          children
        ) : (
          <div role="alert" className="rounded-(--radius-card) border border-line bg-surface px-6 py-14 text-center">
            <p className="text-sm font-medium text-ink-900">You do not have access to this page</p>
            <p className="mt-1 text-sm text-ink-500">Ask the restaurant owner to change your role if you need it.</p>
          </div>
        )}
      </main>
    </div>
  );
}
