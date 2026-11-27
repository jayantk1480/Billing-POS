import { Badge } from '@pos/ui';
import type { SubscriptionDto } from '@pos/validation';
import { STATUS_TONE, statusText } from '@/lib/labels';

/** Where a restaurant stands: "On trial · 9 days left", "Active until 12 Nov 2027", "Expired", "Suspended". */
export function StatusBadge({ subscription }: { subscription: SubscriptionDto }) {
  return <Badge tone={STATUS_TONE[subscription.status]}>{statusText(subscription)}</Badge>;
}
