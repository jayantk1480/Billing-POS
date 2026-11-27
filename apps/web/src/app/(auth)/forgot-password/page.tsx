'use client';

import { Button, TextField, useApi, useFormState } from '@pos/ui';
import { forgotPasswordSchema } from '@pos/validation';
import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';

export default function ForgotPasswordPage() {
  const api = useApi();
  const form = useFormState({ email: '' });
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await form.submit(forgotPasswordSchema, form.values, async (data) => {
      await api.auth.forgotPassword(data.email);
      setSentTo(data.email);
    });
  }

  if (sentTo) {
    return (
      <div>
        <span className="flex size-11 items-center justify-center rounded-full bg-green-50 text-ok">
          <MailCheck className="size-5" />
        </span>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink-900">Check your email</h1>
        <p className="mt-2 text-sm text-ink-500">
          If an account exists for <span className="font-medium text-ink-900">{sentTo}</span>, we have sent a link to reset the
          password. The link works once and expires in 30 minutes.
        </p>
        <Link href="/login" className="mt-6 inline-block text-sm font-medium text-brand-700 hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Reset your password</h1>
      <p className="mt-1.5 text-sm text-ink-500">Enter your account email and we will send you a reset link.</p>
      <TextField
        className="mt-8" label="Email" type="email" autoComplete="username" autoFocus
        value={form.values.email} onChange={(value) => form.set('email', value)} error={form.errors.email}
      />
      <Button type="submit" size="touch" className="mt-6 w-full" loading={form.submitting}>
        Send reset link
      </Button>
      <p className="mt-4 text-center text-sm">
        <Link href="/login" className="font-medium text-brand-700 hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
