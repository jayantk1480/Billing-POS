import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '../cn';
import type { Sorter } from '../sorting';
import { Button } from './button';

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span role="status" aria-label="Loading" className={cn('inline-block size-5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent', className)} />;
}

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-sm text-ink-500">
      <Spinner /> {label}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description, action }: { icon?: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {Icon && (
        <span className="mb-3 flex size-11 items-center justify-center rounded-full bg-brand-50 text-brand-600">
          <Icon className="size-5" />
        </span>
      )}
      <p className="text-sm font-medium text-ink-900">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-ink-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-14 text-center">
      <p className="text-sm font-medium text-danger">Could not load this</p>
      <p className="mt-1 max-w-sm text-sm text-ink-500">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Table({ className, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return (
    // "relative" keeps screen-reader-only header text inside the scroller; without it the page itself scrolls sideways on a phone.
    <div className="relative overflow-x-auto">
      <table className={cn('w-full text-left text-sm', className)} {...rest} />
    </div>
  );
}

interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  /** With `sortKey`, makes the heading a button that sorts the table by this column. */
  sorter?: Sorter;
  sortKey?: string;
}

/**
 * A column heading. Given a sorter and a key it sorts: the first click ascending, the next descending.
 * The arrow shows the direction in use, and appears faintly on the other columns when they are pointed at.
 */
export function Th({ className, sorter, sortKey, children, ...rest }: ThProps) {
  const base = 'border-b border-line bg-canvas/60 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-ink-500';
  if (!sorter || !sortKey) return <th scope="col" className={cn(base, className)} {...rest}>{children}</th>;
  const direction = sorter.state?.key === sortKey ? sorter.state.direction : null;
  const Icon = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ArrowUpDown;
  const right = className?.includes('text-right');
  return (
    // The padding is on the button, so the whole cell is the click target and the label lines up with the cells below.
    <th scope="col" aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'} className={cn('border-b border-line bg-canvas/60 p-0', className)} {...rest}>
      <button
        type="button" onClick={() => sorter.toggle(sortKey)}
        title={direction === 'asc' ? 'Sorted ascending. Click for descending.' : direction === 'desc' ? 'Sorted descending. Click for ascending.' : 'Click to sort'}
        className={cn(
          // Long headings may wrap, as plain ones do, so sorting does not make a table wider than its page.
          'group relative block w-full px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide hover:bg-canvas hover:text-ink-900',
          right && 'text-right', direction ? 'text-ink-900' : 'text-ink-500',
        )}
      >
        {children}
        {/* The arrow sits in the cell's padding, so a sortable column is no wider than a plain one. */}
        <Icon className={cn('absolute top-1/2 size-3 -translate-y-1/2', right ? 'left-0.5' : 'right-0.5', direction ? 'text-brand-600' : 'opacity-30 group-hover:opacity-100 group-focus-visible:opacity-100')} aria-hidden="true" />
      </button>
    </th>
  );
}

export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('border-b border-line px-4 py-3 align-middle text-ink-700', className)} {...rest} />;
}
