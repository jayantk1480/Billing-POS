import type { Tone } from '@pos/ui';
import type { PlatformRestaurantDetailDto, PlatformRestaurantDto, SubscriptionDto, SubscriptionStatus } from '@pos/validation';
import { formatDay, formatDayOf } from './dates';

export const STATUS_LABEL: Record<SubscriptionStatus, string> = { TRIAL: 'On trial', ACTIVE: 'Active', EXPIRED: 'Expired', SUSPENDED: 'Suspended' };
export const STATUS_TONE: Record<SubscriptionStatus, Tone> = { TRIAL: 'warn', ACTIVE: 'ok', EXPIRED: 'danger', SUSPENDED: 'neutral' };
/** The order the statuses are listed in, in the filter and the overview. */
export const STATUSES: SubscriptionStatus[] = ['TRIAL', 'ACTIVE', 'EXPIRED', 'SUSPENDED'];

export const CREATED_VIA: Record<PlatformRestaurantDto['createdVia'], string> = { SIGNUP: 'Signed up', PLATFORM: 'Added by us', SEED: 'Set up at install' };

export const GST_REGISTRATION: Record<PlatformRestaurantDetailDto['gstRegistration'], string> = {
  REGULAR: 'Registered for GST', COMPOSITION: 'Composition scheme', UNREGISTERED: 'Not registered for GST',
};

export function daysLeftText(days: number): string {
  return days <= 0 ? 'ends today' : days === 1 ? '1 day left' : `${days} days left`;
}

/** The short text of the status badge: "On trial · 9 days left", "Active until 12 Nov 2027". */
export function statusText(subscription: SubscriptionDto): string {
  if (subscription.status === 'TRIAL') return subscription.daysLeft === null ? 'On trial' : `On trial · ${daysLeftText(subscription.daysLeft)}`;
  if (subscription.status === 'ACTIVE' && subscription.paidUntil) return `Active until ${formatDay(subscription.paidUntil)}`;
  return STATUS_LABEL[subscription.status];
}

/** The day a restaurant's time runs out (or ran out), and which kind of time it is. Null when there is no limit. */
export function endOf(subscription: SubscriptionDto): { day: string; kind: 'Trial' | 'Paid' } | null {
  if (subscription.status === 'TRIAL' && subscription.trialEndsAt) return { day: formatDayOf(subscription.trialEndsAt), kind: 'Trial' };
  if (subscription.paidUntil) return { day: formatDay(subscription.paidUntil), kind: 'Paid' };
  if (subscription.trialEndsAt) return { day: formatDayOf(subscription.trialEndsAt), kind: 'Trial' };
  return null;
}

const sentence = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** "invoice.cancelled" becomes "Invoice cancelled"; what the platform did reads as "Suspended", "Trial changed". */
export function activityLabel(action: string): string {
  const name = action.startsWith('platform.') ? action.slice('platform.'.length) : action;
  return sentence(name.replace(/[._]+/g, ' ').trim()) || action;
}

export function activityActor(entry: { action: string; userName: string | null }): string {
  return entry.userName ?? (entry.action.startsWith('platform.') ? 'Platform' : 'System');
}
