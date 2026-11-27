'use client';

import { cn, useApi } from '@pos/ui';
import { useQuery } from '@tanstack/react-query';
import { SUPPORT_EMAIL } from '@/lib/api';

const day = (iso: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(new Date(iso));
const days = (count: number) => (count === 0 ? 'today is the last day' : count === 1 ? '1 day left' : count + ' days left');

/**
 * Tells the restaurant where it stands: on trial and for how long, paid up to a date that is coming close,
 * or past either, when everything can still be seen and exported but nothing changed.
 */
export function SubscriptionBanner() {
  const api = useApi();
  const restaurant = useQuery({ queryKey: ['restaurant'], queryFn: api.restaurant.get, staleTime: 60_000 });
  const subscription = restaurant.data?.subscription;
  if (!subscription) return null;

  const contact = SUPPORT_EMAIL ? <a href={'mailto:' + SUPPORT_EMAIL} className="font-semibold underline">{SUPPORT_EMAIL}</a> : 'us';
  let tone: 'info' | 'warn' = 'info';
  let message;
  if (subscription.status === 'EXPIRED') {
    tone = 'warn';
    message = <>Your {subscription.paidUntil ? 'paid period' : 'free trial'} has ended. You can still view and export everything, but nothing can be changed and no bills can be made. Contact {contact} to continue.</>;
  } else if (subscription.status === 'TRIAL' && subscription.trialEndsAt) {
    tone = (subscription.daysLeft ?? 99) <= 3 ? 'warn' : 'info';
    message = <>Free trial: {days(subscription.daysLeft ?? 0)}, until {day(subscription.trialEndsAt)}. Contact {contact} to carry on after that.</>;
  } else if (subscription.status === 'ACTIVE' && subscription.paidUntil && (subscription.daysLeft ?? 99) <= 14) {
    tone = (subscription.daysLeft ?? 99) <= 3 ? 'warn' : 'info';
    message = <>Paid until {day(subscription.paidUntil)}: {days(subscription.daysLeft ?? 0)}. Contact {contact} to renew.</>;
  } else {
    return null;
  }

  return (
    <p role="status" className={cn('border-b px-4 py-2.5 text-center text-sm', tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-brand-100 bg-brand-50 text-brand-700')}>
      {message}
    </p>
  );
}
