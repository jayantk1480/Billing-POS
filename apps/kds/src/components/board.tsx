'use client';

import { Button, cn, ErrorState, errorMessage, LoadingState, toast, useApi, useAuth, useRealtime } from '@pos/ui';
import type { KotDto, KotStatus } from '@pos/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChefHat, LogOut, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

const STATION_KEY = 'kds.stationId';

/** What the one big button on a ticket does next, and how to step back. */
const NEXT: Record<string, { label: string; to: KotStatus } | undefined> = {
  PENDING: { label: 'Start preparing', to: 'PREPARING' },
  PREPARING: { label: 'Mark ready', to: 'READY' },
  READY: { label: 'Done', to: 'COMPLETED' },
};
const BACK: Record<string, KotStatus | undefined> = { PREPARING: 'PENDING', READY: 'PREPARING', COMPLETED: 'READY' };
const STATUS_LABEL: Record<string, string> = { PENDING: 'New', PREPARING: 'Preparing', READY: 'Ready', COMPLETED: 'Done', CANCELLED: 'Cancelled' };
const STATUS_STYLE: Record<string, string> = {
  PENDING: 'bg-amber-400 text-ink-900', PREPARING: 'bg-sky-400 text-ink-900', READY: 'bg-green-400 text-ink-900', COMPLETED: 'bg-slate-500 text-white',
};

/** Whole minutes since the ticket reached the kitchen. */
const waited = (kot: KotDto, now: number) => Math.max(0, Math.floor((now - Date.parse(kot.createdAt)) / 60_000));
const where = (kot: KotDto) => (kot.tableName ? 'Table ' + kot.tableName : kot.orderType === 'DELIVERY' ? 'Delivery' : 'Takeaway') + (kot.tokenNumber ? ' · Token ' + kot.tokenNumber : '');

function Ticket({ kot, now, showStation, onMove, busy }: { kot: KotDto; now: number; showStation: boolean; onMove: (status: KotStatus) => void; busy: boolean }) {
  const cancel = kot.type === 'CANCEL';
  const minutes = waited(kot, now);
  const next = cancel ? { label: 'Acknowledge', to: 'COMPLETED' as KotStatus } : NEXT[kot.status];
  const back = cancel ? undefined : BACK[kot.status];
  // A ticket still waiting after ten minutes, or twenty, calls for attention.
  const late = !cancel && kot.status !== 'COMPLETED' && kot.status !== 'READY' ? (minutes >= 20 ? 'very' : minutes >= 10 ? 'yes' : 'no') : 'no';

  return (
    <article
      aria-label={(cancel ? 'Cancellation ' : 'Ticket ') + kot.kotNumber + ', ' + where(kot)}
      className={cn('flex flex-col overflow-hidden rounded-xl border-2 bg-slate-800', cancel ? 'border-red-500' : late === 'very' ? 'border-red-400' : late === 'yes' ? 'border-amber-400' : 'border-slate-700')}
    >
      <header className={cn('flex items-center justify-between gap-2 px-3 py-2', cancel ? 'bg-red-600 text-white' : STATUS_STYLE[kot.status])}>
        <span className="text-lg font-bold">{cancel ? 'CANCEL' : '#' + kot.kotNumber}</span>
        <span className="text-sm font-semibold">{cancel ? '#' + kot.kotNumber : STATUS_LABEL[kot.status]}</span>
        <span className="text-sm font-semibold tabular-nums" aria-label={'Waiting ' + minutes + ' minutes'}>{minutes} min</span>
      </header>
      <div className="border-b border-slate-700 px-3 py-2 text-sm text-slate-300">
        <p className="font-semibold text-white">{where(kot)}</p>
        <p>Order {kot.orderDisplayNumber}{showStation && kot.stationName ? ' · ' + kot.stationName : ''}</p>
      </div>
      <ul className="flex-1 space-y-2 px-3 py-3">
        {kot.items.map((item) => {
          // On a ticket to cook, what was cancelled since is no longer to be made.
          const left = cancel ? item.quantity : item.quantity - item.cancelledQuantity;
          return (
            <li key={item.id}>
              <p className={cn('text-lg font-semibold leading-snug text-white', (cancel || left === 0) && 'line-through decoration-red-400', left === 0 && 'text-slate-400')}>
                <span className="tabular-nums">{left === 0 ? item.quantity : left} ×</span> {item.name}
              </p>
              {!cancel && item.cancelledQuantity > 0 && (
                <p className="text-sm font-semibold text-red-300">{left === 0 ? 'Cancelled' : `${item.cancelledQuantity} cancelled, make ${left}`}</p>
              )}
              {item.notes && <p className="text-sm font-medium text-amber-300">{item.notes}</p>}
            </li>
          );
        })}
        {kot.notes && <li className="rounded-lg bg-red-950 px-2 py-1.5 text-sm font-medium text-red-200">{cancel ? 'Reason: ' : 'Note: '}{kot.notes}</li>}
      </ul>
      <footer className="flex gap-2 p-2">
        {back && (
          <button type="button" onClick={() => onMove(back)} disabled={busy} aria-label={'Move ticket ' + kot.kotNumber + ' back'} className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-slate-700 text-slate-200 hover:bg-slate-600 disabled:opacity-50">
            <Undo2 className="size-5" />
          </button>
        )}
        {next && (
          <button type="button" onClick={() => onMove(next.to)} disabled={busy} className={cn('h-12 flex-1 rounded-lg text-base font-bold disabled:opacity-50', cancel ? 'bg-red-600 text-white hover:bg-red-500' : 'bg-white text-ink-900 hover:bg-slate-200')}>
            {next.label}
          </button>
        )}
      </footer>
    </article>
  );
}

/** The kitchen's screen: every ticket still to be dealt with, oldest first, updating as orders come in. */
export function Board() {
  const api = useApi();
  const { user, can } = useAuth();
  const queryClient = useQueryClient();
  const [stationId, setStationId] = useState<string>(() => (typeof window === 'undefined' ? '' : (window.localStorage.getItem(STATION_KEY) ?? '')));
  const [scope, setScope] = useState<'active' | 'today'>('active');
  const [now, setNow] = useState(() => Date.now());

  const stations = useQuery({ queryKey: ['stations'], queryFn: api.stations.list });
  const kots = useQuery({
    queryKey: ['kots', stationId, scope],
    queryFn: () => api.kots.list({ stationId: stationId || undefined, scope }),
    // The live connection is the fast path; this catches anything it missed.
    refetchInterval: 15_000,
  });
  const live = useRealtime((event) => {
    if (event.startsWith('kot.') || event === 'order.deleted') void queryClient.invalidateQueries({ queryKey: ['kots'] });
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  // Forget a remembered station that has since been removed.
  useEffect(() => {
    if (stationId && stations.data && !stations.data.some((station) => station.id === stationId)) setStationId('');
  }, [stationId, stations.data]);

  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: KotStatus }) => api.kots.setStatus(id, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kots'] }),
    onError: (error) => toast.error(errorMessage(error)),
  });

  function chooseStation(id: string) {
    setStationId(id);
    window.localStorage.setItem(STATION_KEY, id);
  }

  const tickets = useMemo(() => {
    const list = kots.data ?? [];
    return scope === 'today' ? list.filter((kot) => kot.status === 'COMPLETED').reverse() : list;
  }, [kots.data, scope]);

  // What is still to be cooked, added up across tickets: "6 Butter Naan" beats reading six tickets.
  const toMake = useMemo(() => {
    const totals = new Map<string, number>();
    for (const kot of kots.data ?? []) {
      if (kot.type !== 'NEW' || (kot.status !== 'PENDING' && kot.status !== 'PREPARING')) continue;
      for (const item of kot.items) totals.set(item.name, (totals.get(item.name) ?? 0) + item.quantity - item.cancelledQuantity);
    }
    return [...totals.entries()].filter(([, quantity]) => quantity > 0).sort((a, b) => b[1] - a[1]);
  }, [kots.data]);

  const canAct = can('kot.update_status');
  const tab = (active: boolean) => cn('h-11 shrink-0 rounded-lg px-4 text-sm font-semibold', active ? 'bg-white text-ink-900' : 'bg-slate-800 text-slate-200 hover:bg-slate-700');

  return (
    <div className="flex h-dvh flex-col bg-slate-900 text-white">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-700 px-3 py-2">
        <span className="flex size-9 items-center justify-center rounded-lg bg-brand-600"><ChefHat className="size-5" /></span>
        <div className="mr-2 hidden sm:block">
          <p className="text-sm font-semibold leading-tight">Kitchen display</p>
          <p className="text-xs leading-tight text-slate-400">{user?.restaurantName}</p>
        </div>
        <div className="flex gap-1.5 overflow-x-auto" role="tablist" aria-label="Kitchen station">
          <button type="button" role="tab" aria-selected={stationId === ''} onClick={() => chooseStation('')} className={tab(stationId === '')}>All stations</button>
          {stations.data?.filter((station) => station.isActive).map((station) => (
            <button key={station.id} type="button" role="tab" aria-selected={stationId === station.id} onClick={() => chooseStation(station.id)} className={tab(stationId === station.id)}>
              {station.name}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className={cn('flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', live ? 'bg-green-900 text-green-200' : 'bg-amber-900 text-amber-200')}>
            <span className={cn('size-2 rounded-full', live ? 'bg-green-400' : 'bg-amber-400')} /> {live ? 'Live' : 'Reconnecting'}
          </span>
          <button type="button" onClick={() => setScope(scope === 'active' ? 'today' : 'active')} aria-pressed={scope === 'today'} className={tab(scope === 'today')}>
            {scope === 'today' ? 'Back to open tickets' : 'Done today'}
          </button>
          <button type="button" onClick={() => void api.auth.logout()} aria-label="Sign out" className="flex size-11 items-center justify-center rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700"><LogOut className="size-5" /></button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-y-auto p-3">
          {kots.isPending ? (
            <LoadingState label="Loading tickets" />
          ) : kots.isError ? (
            <ErrorState message={errorMessage(kots.error)} onRetry={() => void kots.refetch()} />
          ) : tickets.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center text-slate-400">
              <ChefHat className="size-12 text-slate-600" />
              <p className="mt-3 text-lg font-semibold text-slate-200">{scope === 'today' ? 'Nothing finished yet today' : 'All caught up'}</p>
              <p className="text-sm">{scope === 'today' ? 'Finished tickets appear here.' : 'New orders appear here the moment they are sent.'}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" aria-label="Kitchen tickets">
              {tickets.map((kot) => (
                <Ticket
                  key={kot.id} kot={kot} now={now} showStation={stationId === ''} busy={!canAct || (move.isPending && move.variables?.id === kot.id)}
                  onMove={(status) => move.mutate({ id: kot.id, status })}
                />
              ))}
            </div>
          )}
        </main>
        {scope === 'active' && (
          <aside className="hidden w-64 shrink-0 overflow-y-auto border-l border-slate-700 p-3 lg:block" aria-label="To make">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">To make</h2>
            {toMake.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">Nothing waiting.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {toMake.map(([name, quantity]) => (
                  <li key={name} className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="text-slate-200">{name}</span>
                    <span className="text-lg font-bold tabular-nums">{quantity}</span>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}
      </div>
      {!canAct && <p role="alert" className="shrink-0 bg-amber-900 px-4 py-2 text-center text-sm text-amber-100">You can see tickets but your role cannot update them.</p>}
    </div>
  );
}

export function NoAccess() {
  const api = useApi();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-slate-900 px-4 text-center text-white">
      <p className="text-lg font-semibold">Your role does not include the kitchen display</p>
      <p className="max-w-sm text-sm text-slate-400">Ask the owner to give your role "Update ticket status on the kitchen display", or sign in with a kitchen account.</p>
      <Button variant="secondary" size="touch" onClick={() => void api.auth.logout()}>Sign out</Button>
    </main>
  );
}
