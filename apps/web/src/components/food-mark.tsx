import type { FoodType } from '@pos/validation';
import { cn } from '@pos/ui';

const STYLES: Record<FoodType, { box: string; dot: string; label: string }> = {
  VEG: { box: 'border-green-700', dot: 'bg-green-700', label: 'Vegetarian' },
  NON_VEG: { box: 'border-red-700', dot: 'bg-red-700', label: 'Non-vegetarian' },
  EGG: { box: 'border-amber-500', dot: 'bg-amber-500', label: 'Contains egg' },
};

/** The square-and-dot mark used on Indian menus. */
export function FoodMark({ type }: { type: FoodType }) {
  const style = STYLES[type];
  return (
    <span role="img" aria-label={style.label} title={style.label} className={cn('inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border-[1.5px]', style.box)}>
      <span className={cn('size-1.5 rounded-full', style.dot)} />
    </span>
  );
}
