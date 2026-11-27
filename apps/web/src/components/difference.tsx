import { formatINR } from '@pos/billing-core';
import { cn } from '@pos/ui';

/** How far a counted or settled amount is from the amount expected. Negative means money is short. */
export const differenceText = (paise: number): string => (paise < 0 ? `Short ${formatINR(-paise)}` : paise > 0 ? `Over ${formatINR(paise)}` : formatINR(0));

export function Difference({ paise, className }: { paise: number; className?: string }) {
  return (
    <span className={cn('whitespace-nowrap tabular-nums', paise < 0 ? 'font-medium text-danger' : paise > 0 ? 'font-medium text-amber-700' : undefined, className)}>
      {differenceText(paise)}
    </span>
  );
}
