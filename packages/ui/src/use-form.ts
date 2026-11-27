'use client';

import { ApiRequestError } from '@pos/api-client';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';

export type FieldErrors = Record<string, string>;

/**
 * Form state for one object of values. `submit` validates with the same Zod schema the API uses,
 * shows field errors from either side next to the fields, and reports other failures as a toast.
 */
export function useFormState<V extends object>(initial: V) {
  const [values, setValues] = useState<V>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const set = useCallback(<K extends keyof V>(key: K, value: V[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!(key in current)) return current;
      const { [key as string]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const reset = useCallback((next: V) => {
    setValues(next);
    setErrors({});
  }, []);

  /** Returns true when the action ran without error. */
  async function submit<S extends z.ZodType>(schema: S, payload: unknown, action: (data: z.output<S>) => Promise<unknown>): Promise<boolean> {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) next[issue.path.join('.')] ??= issue.message;
      setErrors(next);
      return false;
    }
    setSubmitting(true);
    try {
      await action(parsed.data);
      setErrors({});
      return true;
    } catch (error) {
      if (!(error instanceof ApiRequestError)) throw error;
      setErrors(error.fieldErrors);
      toast.error(error.message);
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  return { values, set, setValues, reset, errors, setErrors, submitting, submit };
}

/** The message to show for any thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
