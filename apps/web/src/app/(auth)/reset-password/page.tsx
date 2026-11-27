'use client';

import { ApiRequestError } from '@pos/api-client';
import { Button, LoadingState, TextField, toast, useApi, useFormState } from '@pos/ui';
import { resetPasswordSchema } from '@pos/validation';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';

function ResetPasswordForm() {
  const api = useApi();
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  // Someone whose restaurant was set up for them arrives here to choose their first password.
  const welcome = params.get('welcome') === '1';
  const form = useFormState({ password: '', confirm: '' });

  // 'incomplete': the address has no usable token. 'rejected': the server no longer accepts it.
  const [problem, setProblem] = useState<'incomplete' | 'rejected' | null>(token.length < 20 ? 'incomplete' : null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (form.values.password !== form.values.confirm) {
      form.setErrors({ confirm: 'The two passwords do not match' });
      return;
    }
    let rejected = false;
    const done = await form.submit(resetPasswordSchema, { token, password: form.values.password }, async (data) => {
      try {
        await api.auth.resetPassword(data.token, data.password);
      } catch (error) {
        if (!(error instanceof ApiRequestError && error.code === 'RESET_LINK_INVALID')) throw error;
        rejected = true;
      }
    });
    if (rejected) {
      setProblem('rejected');
    } else if (done) {
      toast.success(welcome ? 'Password saved. Sign in to get started.' : 'Password changed. Sign in with your new password.');
      router.replace('/login');
    }
  }

  if (problem) {
    return (
      <div role="alert">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">This link no longer works</h1>
        <p className="mt-2 text-sm text-ink-500">
          {problem === 'incomplete'
            ? 'The link is incomplete. Open it from the email again, or request a new one.'
            : 'A link works once and then expires. Asking for a new link also cancels older ones, so use the most recent email.'}
        </p>
        <Link href="/forgot-password" className="mt-6 inline-flex h-12 items-center rounded-lg bg-brand-600 px-5 text-base font-medium text-white hover:bg-brand-700">
          Request a new link
        </Link>
        <p className="mt-4 text-sm">
          <Link href="/login" className="font-medium text-brand-700 hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">{welcome ? 'Welcome. Choose your password' : 'Choose a new password'}</h1>
      <p className="mt-1.5 text-sm text-ink-500">Use at least 10 characters. A short sentence works well.</p>
      <div className="mt-8 space-y-4">
        <TextField
          label={welcome ? 'Password' : 'New password'} type="password" autoComplete="new-password" autoFocus
          value={form.values.password} onChange={(value) => form.set('password', value)} error={form.errors.password}
        />
        <TextField
          label={welcome ? 'Repeat password' : 'Repeat new password'} type="password" autoComplete="new-password"
          value={form.values.confirm} onChange={(value) => form.set('confirm', value)} error={form.errors.confirm}
        />
      </div>
      <Button type="submit" size="touch" className="mt-6 w-full" loading={form.submitting}>
        {welcome ? 'Save password' : 'Change password'}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <ResetPasswordForm />
    </Suspense>
  );
}
