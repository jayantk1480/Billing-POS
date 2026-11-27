'use client';

import { Button, PageHeader, toast } from '@pos/ui';
import type { PlatformRestaurantDetailDto, SubscriptionStatus } from '@pos/validation';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AddRestaurantDialog } from '@/components/add-restaurant-dialog';
import { OverviewStrip } from '@/components/overview-strip';
import { RestaurantList } from '@/components/restaurant-list';
import { keys } from '@/lib/api';

export default function RestaurantsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SubscriptionStatus | ''>('');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);

  // The counts above the table and the select inside it set the same filter; a new filter starts from page one.
  const changeStatus = (next: SubscriptionStatus | '') => {
    setStatus(next);
    setPage(1);
  };

  const onCreated = (restaurant: PlatformRestaurantDetailDto) => {
    // The answer is the restaurant's full page, so opening it does not need a second request.
    queryClient.setQueryData(keys.restaurant(restaurant.id), restaurant);
    void queryClient.invalidateQueries({ queryKey: keys.restaurants });
    void queryClient.invalidateQueries({ queryKey: keys.overview });
    toast.success(`${restaurant.name} is set up. ${restaurant.ownerEmail ?? 'The owner'} was emailed a link to choose a password.`);
    router.push(`/restaurants/${restaurant.id}`);
  };

  const addButton = <Button onClick={() => setAdding(true)}><Plus className="size-4" /> Add restaurant</Button>;

  return (
    <>
      <PageHeader title="Restaurants" description="Every restaurant that uses the product: who owns it, where its subscription stands and how much it is used." action={addButton} />
      <OverviewStrip status={status} onStatus={changeStatus} />
      <RestaurantList status={status} onStatus={changeStatus} page={page} onPage={setPage} emptyAction={addButton} />
      {adding && <AddRestaurantDialog onClose={() => setAdding(false)} onCreated={onCreated} />}
    </>
  );
}
