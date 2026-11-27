'use client';

import { Card, cn, ErrorState, errorMessage, LoadingState } from '@pos/ui';
import type { SubscriptionStatus } from '@pos/validation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { keys, platform } from '@/lib/api';
import { formatDayOf } from '@/lib/dates';
import { daysLeftText, STATUS_LABEL, STATUSES } from '@/lib/labels';

const TILE = 'rounded-(--radius-card) border bg-surface px-4 py-3 text-left shadow-(--shadow-card)';

function Count({ label, value }: { label: string; value: number }) {
  return (
    <>
      <span className="block text-xs font-medium text-ink-500">{label}</span>
      <span className="mt-1 block text-2xl font-semibold tabular-nums text-ink-900">{value.toLocaleString('en-IN')}</span>
    </>
  );
}

/** How many restaurants there are in each state. Choosing a count filters the table below to that state. */
export function OverviewStrip({ status, onStatus }: { status: SubscriptionStatus | ''; onStatus: (status: SubscriptionStatus | '') => void }) {
  const overview = useQuery({ queryKey: keys.overview, queryFn: () => platform.overview() });

  if (overview.isPending) return <Card className="mb-6"><LoadingState label="Loading the overview" /></Card>;
  if (overview.isError) return <Card className="mb-6"><ErrorState message={errorMessage(overview.error)} onRetry={() => void overview.refetch()} /></Card>;

  const { restaurants, signupsLast30Days, trialsEndingSoon } = overview.data;
  const tiles: { value: SubscriptionStatus | ''; label: string; count: number }[] = [
    { value: '', label: 'Total', count: restaurants.total },
    ...STATUSES.map((value) => ({ value, label: STATUS_LABEL[value], count: restaurants[value] })),
  ];

  return (
    <section aria-label="Overview" className="mb-6 space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((tile) => {
          const chosen = status === tile.value;
          return (
            <button
              key={tile.value || 'all'} type="button" aria-pressed={chosen}
              title={tile.value ? `Show only ${tile.label.toLowerCase()} restaurants` : 'Show every restaurant'}
              // Choosing the status already in use goes back to every restaurant.
              onClick={() => onStatus(chosen ? '' : tile.value)}
              className={cn(TILE, 'transition-colors hover:border-ink-300', chosen ? 'border-brand-500 ring-1 ring-brand-500 hover:border-brand-500' : 'border-line')}
            >
              <Count label={tile.label} value={tile.count} />
            </button>
          );
        })}
        <div className={cn(TILE, 'border-line')}>
          <Count label="New in the last 30 days" value={signupsLast30Days} />
        </div>
      </div>

      {trialsEndingSoon.length > 0 && (
        <Card>
          <h2 className="border-b border-line px-5 py-3 text-sm font-semibold text-ink-900">Trials ending this week</h2>
          <ul className="divide-y divide-line">
            {trialsEndingSoon.map((trial) => (
              <li key={trial.id}>
                <Link href={`/restaurants/${trial.id}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-5 py-2.5 text-sm hover:bg-canvas/60">
                  <span className="min-w-0 truncate font-medium text-brand-700">{trial.name}</span>
                  <span className="text-ink-500">
                    <span className="font-medium text-ink-900">{trial.daysLeft <= 0 ? 'Ends today' : daysLeftText(trial.daysLeft)}</span> · {formatDayOf(trial.trialEndsAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
