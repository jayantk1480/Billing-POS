'use client';

import { ApiRequestError } from '@pos/api-client';
import { Button, errorMessage, LoadingState, TextField, toast, useApi } from '@pos/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';

function LoginForm() {
  const api = useApi();
  // Filled in when arriving from the email confirmation page.
  const [email, setEmail] = useState(useSearchParams().get('email') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Set when the password was right but the address has not been confirmed yet.
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const [resending, setResending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setLoading(true);
    setError(null);
    setUnconfirmed(null);
    try {
      // On success the auth layout notices the signed-in state and redirects.
      await api.auth.login(email, password);
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not sign in. Please try again.');
      if (caught instanceof ApiRequestError && caught.code === 'EMAIL_NOT_VERIFIED') setUnconfirmed(email.trim().toLowerCase());
      setLoading(false);
    }
  }

  async function resend() {
    if (!unconfirmed) return;
    setResending(true);
    try {
      await api.signup.resend(unconfirmed);
      toast.success('We have sent the link again. It works for 24 hours.');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setResending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Sign in</h1>
      <p className="mt-1.5 text-sm text-ink-500">Use your back-office account.</p>

      <div className="mt-8 space-y-4">
        <TextField label="Email" type="email" autoComplete="username" autoFocus={!email} value={email} onChange={setEmail} />
        <TextField label="Password" type="password" autoComplete="current-password" autoFocus={Boolean(email)} value={password} onChange={setPassword} />
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">
          {error}
        </p>
      )}
      {unconfirmed && (
        <Button variant="secondary" className="mt-3 w-full" loading={resending} onClick={() => void resend()}>Send the confirmation link again</Button>
      )}

      <Button type="submit" size="touch" className="mt-6 w-full" loading={loading}>
        Sign in
      </Button>
      <p className="mt-4 text-center text-sm">
        <Link href="/forgot-password" className="font-medium text-brand-700 hover:underline">
          Forgot your password?
        </Link>
      </p>
      <p className="mt-6 border-t border-line pt-5 text-center text-sm text-ink-500">
        New here? <Link href="/signup" className="font-medium text-brand-700 hover:underline">Register your restaurant</Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <LoginForm />
    </Suspense>
  );
}
