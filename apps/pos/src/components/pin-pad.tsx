'use client';

import { cn } from '@pos/ui';
import { Delete } from 'lucide-react';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'] as const;

/** A touch keypad for a 4 to 6 digit PIN. The digits are also accepted from a keyboard. */
export function PinPad({ value, onChange, label, error }: { value: string; onChange: (value: string) => void; label: string; error?: string | null }) {
  const press = (key: (typeof KEYS)[number]) => {
    if (key === 'clear') onChange('');
    else if (key === 'back') onChange(value.slice(0, -1));
    else if (value.length < 6) onChange(value + key);
  };
  return (
    <div>
      <label className="block text-sm font-medium text-ink-700">
        {label}
        <input
          type="password" inputMode="numeric" autoComplete="off" value={value} maxLength={6} aria-invalid={error ? true : undefined}
          onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
          className={cn('mt-1.5 block h-12 w-full rounded-lg border bg-surface text-center text-2xl tracking-[0.5em]', error ? 'border-danger' : 'border-line')}
        />
      </label>
      {error && <p role="alert" className="mt-1.5 text-sm text-danger">{error}</p>}
      <div className="mt-3 grid grid-cols-3 gap-2">
        {KEYS.map((key) => (
          <button
            key={key} type="button" onClick={() => press(key)} aria-label={key === 'back' ? 'Delete last digit' : key === 'clear' ? 'Clear' : key}
            className="flex h-14 items-center justify-center rounded-xl border border-line bg-surface text-xl font-semibold text-ink-900 hover:bg-canvas active:bg-brand-50"
          >
            {key === 'back' ? <Delete className="size-5" /> : key === 'clear' ? <span className="text-sm font-medium text-ink-500">Clear</span> : key}
          </button>
        ))}
      </div>
    </div>
  );
}
