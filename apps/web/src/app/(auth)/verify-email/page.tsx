'use client';

import { type ApiClient, ApiRequestError } from '@pos/api-client';
import { Button, errorMessage, LoadingState, TextField, toast, useApi } from '@pos/ui';
import { CircleCheck } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useEffect, useState } from 'react';

type Outcome = { ok: true; email: string } | { ok: false; message: string };

// A link works once, and React may run an effect twice while developing. One request per token, shared.
const attempts = new Map<string, Promise<Outcome>>();
function confirm(api: ApiClient, token: string): Promise<Outcome> {
  let attempt = attempts.get(token);
  if (!attempt) {
    attempt = api.signup.verify(token).then(
      ({ email }): Outcome => ({ ok: true, email }),
      (error: unknown): Outcome => ({
        ok: false,
        message: error instanceof ApiRequestError && error.code !== 'VERIFY_LINK_INVALID' ? error.message : 'A link works once and for 24 hours, and only the most recent one works.',
      }),
    );
    attempts.set(token, attempt);
  }
  return attempt;
}

/** Asks for a fresh link when the one that was opened no longer works. */
function AskAgain({ message }: { message: string }) {
  const api = useApi();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim()) return;
    setSending(true);
    try {
      await api.signup.resend(email.trim().toLowerCase());
      setSent(true);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">This link no longer works</h1>
      <p role="alert" className="mt-2 text-sm leading-relaxed text-ink-500">{message}</p>
      {sent ? (
        <p role="status" className="mt-6 rounded-lg bg-green-50 px-3 py-2.5 text-sm text-green-700">
          If that address is waiting to be confirmed, a new link is on its way. If you have already confirmed it, just sign in.
        </p>
      ) : (
        <>
          <div className="mt-6"><TextField label="Email you registered with" type="email" autoComplete="email" value={email} onChange={setEmail} autoFocus /></div>
          <Button type="submit" size="touch" className="mt-4 w-full" loading={sending} disabled={!email.trim()}>Send a new link</Button>
        </>
      )}
      <p className="mt-4 text-center text-sm"><Link href="/login" className="font-medium text-brand-700 hover:underline">Back to sign in</Link></p>
    </form>
  );
}

function VerifyEmail() {
  const api = useApi();
  const token = useSearchParams().get('token') ?? '';
  const [outcome, setOutcome] = useState<Outcome | null>(token.length < 20 ? { ok: false, message: 'The link is incomplete. Open it from the email again, or ask for a new one.' } : null);

  useEffect(() => {
    if (token.length < 20) return;
    let current = true;
    void confirm(api, token).then((result) => {
      if (current) setOutcome(result);
    });
    return () => {
      current = false;
    };
  }, [api, token]);

  if (!outcome) return <LoadingState label="Confirming your email" />;
  if (!outcome.ok) return <AskAgain message={outcome.message} />;
  return (
    <div>
      <span className="flex size-12 items-center justify-center rounded-2xl bg-green-50 text-green-700"><CircleCheck className="size-6" /></span>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight text-ink-900">Email confirmed</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-500">Your free trial has started. Sign in with <span className="font-medium text-ink-900">{outcome.email}</span> and the password you chose.</p>
      <Link href={'/login?email=' + encodeURIComponent(outcome.email)} className="mt-6 flex h-12 items-center justify-center rounded-lg bg-brand-600 px-5 text-base font-medium text-white hover:bg-brand-700">
        Sign in
      </Link>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <VerifyEmail />
    </Suspense>
  );
}
