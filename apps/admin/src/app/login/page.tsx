'use client';

import { ApiRequestError } from '@pos/api-client';
import { Button, ErrorState, LoadingState, TextField } from '@pos/ui';
import { platformLoginSchema } from '@pos/validation';
import { ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { APP_NAME } from '@/lib/api';
import { usePlatformSession } from '../providers';

export default function LoginPage() {
  const session = usePlatformSession();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (session.status === 'signedIn') router.replace('/');
  }, [session.status, router]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = platformLoginSchema.safeParse({ email, password });
    if (!parsed.success) {
      const next: { email?: string; password?: string } = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'email') next.email ??= issue.message;
        if (issue.path[0] === 'password') next.password ??= issue.message;
      }
      setFieldErrors(next);
      setError(null);
      return;
    }
    setFieldErrors({});
    setError(null);
    setLoading(true);
    try {
      // On success the effect above notices the signed-in state and leaves this page.
      await session.signIn(parsed.data);
    } catch (caught) {
      // Wrong email or password, a locked account and "too many attempts" each come with their own message.
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not sign in. Please try again.');
      setLoading(false);
    }
  }

  const checking = session.status === 'loading' && !session.error;

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-ink-900 text-white">
            <ShieldCheck className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold tracking-tight text-ink-900">{APP_NAME} · Platform admin</p>
            <p className="text-sm text-ink-500">For our own staff only</p>
          </div>
        </div>

        <div className="rounded-(--radius-card) border border-line bg-surface p-6 shadow-(--shadow-card)">
          {session.error ? (
            <ErrorState message={session.error} onRetry={session.retry} />
          ) : checking || session.status === 'signedIn' ? (
            <LoadingState label={checking ? 'Checking whether you are signed in' : 'Signing you in'} />
          ) : (
            <form onSubmit={onSubmit} noValidate>
              <h1 className="text-xl font-semibold tracking-tight text-ink-900">Sign in</h1>
              <p className="mt-1 text-sm text-ink-500">Use your platform admin account.</p>

              {session.expired && !error && (
                <p role="status" className="mt-4 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
                  You were signed out because your session ended. Sign in again to carry on.
                </p>
              )}

              <div className="mt-6 space-y-4">
                <TextField
                  label="Email" type="email" autoComplete="username" autoFocus value={email} error={fieldErrors.email}
                  onChange={(value) => { setEmail(value); setFieldErrors((current) => ({ ...current, email: undefined })); }}
                />
                <TextField
                  label="Password" type="password" autoComplete="current-password" value={password} error={fieldErrors.password}
                  onChange={(value) => { setPassword(value); setFieldErrors((current) => ({ ...current, password: undefined })); }}
                />
              </div>

              {error && (
                <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">
                  {error}
                </p>
              )}

              <Button type="submit" size="touch" className="mt-6 w-full" loading={loading}>
                Sign in
              </Button>
            </form>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-ink-500">
          This is not the restaurant sign-in. Restaurant owners and staff sign in to the back office or the billing screen.
        </p>
      </div>
    </main>
  );
}
