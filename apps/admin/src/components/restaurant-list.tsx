'use client';

import { formatINR } from '@pos/billing-core';
import { Button, Card, cn, EmptyState, ErrorState, errorMessage, formatDateTime, LoadingState, Table, Td, Th, useSorter } from '@pos/ui';
import type { PlatformRestaurantDto, PlatformRestaurantQuery, SubscriptionStatus } from '@pos/validation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Store } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { keys, platform } from '@/lib/api';
import { formatDayOf } from '@/lib/dates';
import { CREATED_VIA, endOf, STATUS_LABEL, STATUSES } from '@/lib/labels';
import { Pager } from './pager';
import { StatusBadge } from './status-badge';

const PAGE_SIZE = 25;
const CONTROL = 'h-10 rounded-lg border border-line bg-surface px-3 text-sm text-ink-700';

function Row({ restaurant }: { restaurant: PlatformRestaurantDto }) {
  const end = endOf(restaurant.subscription);
  return (
    <tr className="hover:bg-canvas/50">
      <Td>
        <Link href={`/restaurants/${restaurant.id}`} className="font-medium text-brand-700 hover:underline">{restaurant.name}</Link>
        <span className="block text-xs text-ink-500">{[restaurant.city, restaurant.stateName].filter(Boolean).join(', ')}</span>
      </Td>
      <Td>
        {restaurant.ownerName ?? <span className="text-ink-500">No owner account</span>}
        {restaurant.ownerEmail && <span className="block text-xs text-ink-500">{restaurant.ownerEmail}</span>}
        {restaurant.ownerEmail && !restaurant.ownerVerified && <span className="block text-xs font-medium text-amber-700">Email not confirmed</span>}
      </Td>
      <Td className="whitespace-nowrap"><StatusBadge subscription={restaurant.subscription} /></Td>
      <Td className="whitespace-nowrap">
        {end ? <>{end.day}<span className="block text-xs text-ink-500">{end.kind === 'Trial' ? 'Trial' : 'Paid until'}</span></> : <span className="text-ink-500">No limit</span>}
      </Td>
      <Td className="text-right tabular-nums">{restaurant.users}</Td>
      <Td className="text-right tabular-nums">{restaurant.billsLast30Days.toLocaleString('en-IN')}</Td>
      <Td className="whitespace-nowrap text-right font-medium tabular-nums text-ink-900">{formatINR(restaurant.salesLast30DaysPaise)}</Td>
      <Td className="whitespace-nowrap">{formatDateTime(restaurant.lastActiveAt)}</Td>
      <Td className="whitespace-nowrap">
        {formatDayOf(restaurant.createdAt)}
        <span className="block text-xs text-ink-500">{CREATED_VIA[restaurant.createdVia]}</span>
      </Td>
    </tr>
  );
}

interface Props {
  status: SubscriptionStatus | '';
  onStatus: (status: SubscriptionStatus | '') => void;
  page: number;
  /** Must be stable between renders (a state setter is). */
  onPage: (page: number) => void;
  /** Shown when there are no restaurants at all, e.g. the "Add restaurant" button. */
  emptyAction: ReactNode;
}

/** Every restaurant, a page at a time. The server searches, filters and sorts across all pages. */
export function RestaurantList({ status, onStatus, page, onPage, emptyAction }: Props) {
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  // A new sort, like a new filter, starts again from the first page.
  const sorter = useSorter({ key: 'created', direction: 'desc' }, () => onPage(1));

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const next = text.trim();
    if (next === search) return;
    const timer = setTimeout(() => {
      setSearch(next);
      onPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [text, search, onPage]);

  const filters: PlatformRestaurantQuery = {
    search: search || undefined, status: status || undefined, page, pageSize: PAGE_SIZE,
    sort: sorter.state?.key as PlatformRestaurantQuery['sort'], direction: sorter.state?.direction,
  };
  const list = useQuery({ queryKey: [...keys.restaurants, filters], queryFn: () => platform.restaurants.list(filters), placeholderData: keepPreviousData });

  // The list can shrink under the page being looked at (a restaurant changed status); step back to the last page that exists.
  const total = list.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const beyondEnd = Boolean(list.data) && !list.isPlaceholderData && page > lastPage;
  useEffect(() => {
    if (beyondEnd) onPage(lastPage);
  }, [beyondEnd, lastPage, onPage]);

  const filtered = Boolean(search || status);
  const clear = () => {
    setText('');
    setSearch('');
    onStatus('');
    onPage(1);
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
        <input
          type="search" value={text} onChange={(event) => setText(event.target.value)} maxLength={80}
          placeholder="Restaurant, owner, email or city" aria-label="Search restaurants" className={`${CONTROL} min-w-56 flex-1`}
        />
        <select aria-label="Filter by status" value={status} onChange={(event) => onStatus(event.target.value as SubscriptionStatus | '')} className={CONTROL}>
          <option value="">All statuses</option>
          {STATUSES.map((value) => <option key={value} value={value}>{STATUS_LABEL[value]}</option>)}
        </select>
      </div>

      {list.isPending ? (
        <LoadingState label="Loading restaurants" />
      ) : list.isError ? (
        <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        filtered ? (
          <EmptyState icon={Store} title="No restaurants match" description="Change the search or the status." action={<Button variant="secondary" onClick={clear}>Clear filters</Button>} />
        ) : (
          <EmptyState icon={Store} title="No restaurants yet" description="Restaurants appear here when they sign up, or when you add one." action={emptyAction} />
        )
      ) : (
        <>
          <Table className={cn('transition-opacity', list.isPlaceholderData && 'opacity-60')} aria-busy={list.isPlaceholderData || undefined}>
            <thead>
              <tr>
                <Th sorter={sorter} sortKey="name">Restaurant</Th>
                <Th>Owner</Th>
                <Th sorter={sorter} sortKey="status">Status</Th>
                <Th sorter={sorter} sortKey="ends">Ends</Th>
                <Th sorter={sorter} sortKey="users" className="text-right">Users</Th>
                <Th sorter={sorter} sortKey="bills" className="text-right">Bills (30 days)</Th>
                <Th sorter={sorter} sortKey="sales" className="text-right">Sales (30 days)</Th>
                <Th sorter={sorter} sortKey="lastActive">Last sign-in</Th>
                <Th sorter={sorter} sortKey="created">Created</Th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((restaurant) => <Row key={restaurant.id} restaurant={restaurant} />)}
            </tbody>
          </Table>
          <Pager page={page} pageSize={PAGE_SIZE} total={total} onChange={onPage} />
        </>
      )}
    </Card>
  );
}
