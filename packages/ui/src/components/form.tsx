'use client';

import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useId } from 'react';
import { cn } from '../cn';

const CONTROL =
  'block w-full rounded-lg border bg-surface px-3 text-sm text-ink-900 placeholder:text-ink-300 ' +
  'transition-colors disabled:cursor-not-allowed disabled:bg-canvas disabled:text-ink-500';
const tone = (error?: string) => (error ? 'border-danger' : 'border-line hover:border-ink-300');

interface FieldShell {
  label: string;
  hint?: string;
  error?: string;
  className?: string;
}

function Shell({ id, label, hint, error, className, children }: FieldShell & { id: string; children: ReactNode }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink-700">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : (
        hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>
      )}
    </div>
  );
}

type TextProps = FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'className'> & {
  value: string;
  onChange: (value: string) => void;
  /** Shown inside the field before the text, e.g. "₹". */
  prefix?: string;
  suffix?: string;
};

export function TextField({ label, hint, error, className, value, onChange, prefix, suffix, ...rest }: TextProps) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error} className={className}>
      <div className="relative">
        {prefix && <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-ink-500">{prefix}</span>}
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={cn(CONTROL, 'h-10', tone(error), prefix && 'pl-7', suffix && 'pr-8')}
          {...rest}
        />
        {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-ink-500">{suffix}</span>}
      </div>
    </Shell>
  );
}

type SelectProps = FieldShell & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value' | 'className'> & {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
};

export function SelectField({ label, hint, error, className, value, onChange, options, placeholder, ...rest }: SelectProps) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error} className={className}>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL, 'h-10 pr-8', tone(error))}
        {...rest}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Shell>
  );
}

type AreaProps = FieldShell & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value' | 'className'> & {
  value: string;
  onChange: (value: string) => void;
};

export function TextAreaField({ label, hint, error, className, value, onChange, ...rest }: AreaProps) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error} className={className}>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        className={cn(CONTROL, 'py-2', tone(error))}
        {...rest}
      />
    </Shell>
  );
}

/** An on/off switch with its label; the whole row is clickable. */
export function Switch({
  label, description, checked, onChange, disabled,
}: { label: string; description?: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <label htmlFor={id} className={cn('flex items-start justify-between gap-4', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
      <span>
        <span className="block text-sm font-medium text-ink-900">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-ink-500">{description}</span>}
      </span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="peer sr-only"
        />
        <span className="h-6 w-11 rounded-full bg-ink-300 transition-colors peer-checked:bg-brand-600 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-500" />
        <span className="absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
      </span>
    </label>
  );
}

/** A compact switch without a visible label, for table rows. */
export function InlineSwitch({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cn('relative inline-flex', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="peer sr-only" />
      <span className="h-6 w-11 rounded-full bg-ink-300 transition-colors peer-checked:bg-ok peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-500" />
      <span className="absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
    </label>
  );
}

export function Checkbox({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cn('flex items-start gap-2.5 text-sm', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 rounded border-ink-300 accent-brand-600"
      />
      <span className="text-ink-700">{label}</span>
    </label>
  );
}
