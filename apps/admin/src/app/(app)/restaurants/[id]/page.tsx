'use client';

import { ApiRequestError } from '@pos/api-client';
import { Card, EmptyState, ErrorState, errorMessage, LoadingState } from '@pos/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Store } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ActivityCard, PeopleCard } from '@/components/people-and-activity';
import { AccessActions, SubscriptionActions } from '@/components/restaurant-actions';
import { DetailsCard, SubscriptionCard, UseCard } from '@/components/restaurant-cards';
import { StatusBadge } from '@/components/status-badge';
import { keys, platform } from '@/lib/api';

// 404: no restaurant has this id. 400: the address does not hold an id at all. Either way there is nothing to show.
const notFound = (error: unknown) => error instanceof ApiRequestError && (error.status === 404 || error.status === 400);

function BackLink() {
  return (
    <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline">
      <ArrowLeft className="size-4" aria-hidden /> All restaurants
    </Link>
  );
}

export default function RestaurantPage() {
  const { id } = useParams<{ id: string }>();
  const detail = useQuery({ queryKey: keys.restaurant(id), queryFn: () => platform.restaurants.get(id) });
  const restaurant = detail.data;

  if (!restaurant) {
    return (
      <>
        <div className="mb-4"><BackLink /></div>
        <Card>
          {detail.isPending ? (
            <LoadingState label="Loading the restaurant" />
          ) : notFound(detail.error) ? (
            <EmptyState icon={Store} title="This restaurant does not exist" description="It may have been removed, or the link is wrong." action={<BackLink />} />
          ) : (
            <ErrorState message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />
          )}
        </Card>
      </>
    );
  }

  return (
    <>
      <div className="mb-4"><BackLink /></div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight text-ink-900">{restaurant.name}</h1>
            <StatusBadge subscription={restaurant.subscription} />
          </div>
          <p className="mt-1 text-sm text-ink-500">{[restaurant.city, restaurant.stateName].filter(Boolean).join(', ')}</p>
          <p className="mt-1 text-xs text-ink-500">Opening this page is recorded in the restaurant's audit log.</p>
        </div>
        <AccessActions restaurant={restaurant} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <DetailsCard restaurant={restaurant} />
        <UseCard restaurant={restaurant} />
        <SubscriptionCard restaurant={restaurant} actions={<SubscriptionActions restaurant={restaurant} />} />
      </div>
      <div className="mt-6 space-y-6">
        <PeopleCard people={restaurant.people} />
        <ActivityCard activity={restaurant.activity} />
      </div>
    </>
  );
}
