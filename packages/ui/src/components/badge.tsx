import type { ReactNode } from 'react';
import { cn } from '../cn';

export type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

const TONES: Record<Tone, string> = {
  ok: 'bg-green-50 text-green-700 ring-green-600/20',
  warn: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  danger: 'bg-red-50 text-red-700 ring-red-600/20',
  neutral: 'bg-slate-100 text-slate-600 ring-slate-500/20',
};

const DOTS: Record<Tone, string> = { ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger', neutral: 'bg-ink-300' };

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset', TONES[tone])}>
      <span className={cn('size-1.5 rounded-full', DOTS[tone])} aria-hidden />
      {children}
    </span>
  );
}
