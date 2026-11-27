import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  // min-w-0: inside a grid or flex row a card shrinks to the screen instead of growing to its longest line.
  return <div className={cn('min-w-0 rounded-(--radius-card) border border-line bg-surface shadow-(--shadow-card)', className)} {...rest} />;
}

export function CardHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div>
        <h2 className="text-base font-semibold text-ink-900">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-ink-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}
