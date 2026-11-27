import { formatINR } from '@pos/billing-core';
import { Card, CardHeader, formatDateTime } from '@pos/ui';
import type { PlatformRestaurantDetailDto, SubscriptionDto } from '@pos/validation';
import type { ReactNode } from 'react';
import { formatDay, formatDayOf } from '@/lib/dates';
import { CREATED_VIA, daysLeftText, GST_REGISTRATION } from '@/lib/labels';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 px-5 py-2.5 text-sm">
      <dt className="shrink-0 text-ink-500">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-ink-900">{children}</dd>
    </div>
  );
}

const missing = (text: string) => <span className="font-normal text-ink-500">{text}</span>;
const count = (value: number) => value.toLocaleString('en-IN');

export function DetailsCard({ restaurant }: { restaurant: PlatformRestaurantDetailDto }) {
  return (
    <Card>
      <CardHeader title="Details" />
      <dl className="divide-y divide-line">
        <Field label="Legal name">{restaurant.legalName ?? missing('Not given')}</Field>
        <Field label="GSTIN">{restaurant.gstin ?? missing('None')}</Field>
        <Field label="GST registration">{GST_REGISTRATION[restaurant.gstRegistration]}</Field>
        <Field label="Phone">{restaurant.phone ?? missing('Not given')}</Field>
        <Field label="City and state">{[restaurant.city, restaurant.stateName].filter(Boolean).join(', ')}</Field>
        <Field label="Created">
          {formatDayOf(restaurant.createdAt)}
          <span className="block text-xs font-normal text-ink-500">{CREATED_VIA[restaurant.createdVia]}</span>
        </Field>
        <Field label="Owner">
          {restaurant.ownerName ?? missing('No owner account')}
          {restaurant.ownerEmail && <span className="block text-xs font-normal text-ink-500">{restaurant.ownerEmail}</span>}
          {restaurant.ownerEmail && (
            <span className={`block text-xs font-medium ${restaurant.ownerVerified ? 'text-green-700' : 'text-amber-700'}`}>
              {restaurant.ownerVerified ? 'Email confirmed' : 'Email not confirmed'}
            </span>
          )}
        </Field>
      </dl>
    </Card>
  );
}

export function UseCard({ restaurant }: { restaurant: PlatformRestaurantDetailDto }) {
  return (
    <Card>
      <CardHeader title="Use" description="How much the restaurant uses the product." />
      <dl className="divide-y divide-line">
        <Field label="Users">{count(restaurant.users)}</Field>
        <Field label="Terminals">{count(restaurant.terminals)}</Field>
        <Field label="Products">{count(restaurant.products)}</Field>
        <Field label="Bills in total">{count(restaurant.billsTotal)}</Field>
        <Field label="Bills in the last 30 days">{count(restaurant.billsLast30Days)}</Field>
        <Field label="Sales in the last 30 days"><span className="tabular-nums">{formatINR(restaurant.salesLast30DaysPaise)}</span></Field>
        <Field label="Last sign-in">{formatDateTime(restaurant.lastActiveAt)}</Field>
      </dl>
    </Card>
  );
}

/** The status said in full: what it means for the people at the restaurant. */
function inWords(subscription: SubscriptionDto): string {
  switch (subscription.status) {
    case 'TRIAL': return 'On a free trial. Everything works until the trial ends.';
    case 'ACTIVE': return subscription.paidUntil ? 'Active and paid for. Everything works.' : 'Active, with no time limit. Everything works.';
    case 'EXPIRED': return 'Expired: the trial or the paid period is over. People there can view and export, but cannot change anything.';
    case 'SUSPENDED': return 'Suspended. Nobody at this restaurant can sign in. Its data is kept.';
  }
}

/** `actions` is the row of buttons that change the trial end and the paid period. */
export function SubscriptionCard({ restaurant, actions }: { restaurant: PlatformRestaurantDetailDto; actions: ReactNode }) {
  const { subscription } = restaurant;
  const trialOver = subscription.trialEndsAt !== null && subscription.status !== 'TRIAL' && Date.parse(subscription.trialEndsAt) <= Date.now();
  return (
    <Card>
      <CardHeader title="Subscription" />
      <p className="border-b border-line px-5 py-3 text-sm text-ink-700">{inWords(subscription)}</p>
      <dl className="divide-y divide-line">
        {subscription.status === 'SUSPENDED' && <Field label="Reason for suspending">{restaurant.suspendReason ?? missing('None given')}</Field>}
        <Field label={trialOver ? 'Trial ended' : 'Trial ends'}>{subscription.trialEndsAt ? formatDayOf(subscription.trialEndsAt) : missing('No trial')}</Field>
        <Field label="Paid until">{subscription.paidUntil ? formatDay(subscription.paidUntil) : missing('No paid period')}</Field>
        {/* Time is not counted for a suspended restaurant. */}
        {subscription.status !== 'SUSPENDED' && (
          <Field label="Days left">
            {subscription.status === 'EXPIRED' ? 'None' : subscription.daysLeft === null ? 'No time limit' : subscription.daysLeft <= 0 ? 'Ends today' : daysLeftText(subscription.daysLeft)}
          </Field>
        )}
      </dl>
      {actions}
    </Card>
  );
}
