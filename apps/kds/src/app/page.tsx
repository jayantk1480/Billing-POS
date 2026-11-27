'use client';

import { ApiRequestError } from '@pos/api-client';
import { Button, LoadingState, TextField, useApi, useAuth } from '@pos/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ChefHat } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Board, NoAccess } from '@/components/board';

function SignIn() {
  const api = useApi();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) return setError('Enter your email and password.');
    setLoading(true);
    setError(null);
    try {
      await api.auth.login(email, password);
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not sign in. Please try again.');
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-900 px-4 py-10">
      <form onSubmit={onSubmit} noValidate className="w-full max-w-sm rounded-2xl bg-surface p-7 shadow-2xl">
        <div className="mb-6 flex items-center gap-2.5 text-base font-semibold text-ink-900">
          <span className="flex size-9 items-center justify-center rounded-xl bg-brand-600 text-white"><ChefHat className="size-5" /></span>
          Kitchen display
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">Sign in</h1>
        <p className="mt-1 text-sm text-ink-500">Use a kitchen account. This screen stays signed in.</p>
        <div className="mt-6 space-y-4">
          <TextField label="Email" type="email" autoComplete="username" autoFocus value={email} onChange={setEmail} />
          <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={setPassword} />
          {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">{error}</p>}
          <Button type="submit" size="touch" className="w-full" loading={loading}>Sign in</Button>
        </div>
      </form>
    </main>
  );
}

export default function KitchenPage() {
  const { state, user, can } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (state.status !== 'signedIn') queryClient.clear();
  }, [state.status, queryClient]);

  if (state.status === 'loading') return <main className="flex min-h-dvh items-center justify-center bg-slate-900"><LoadingState /></main>;
  if (!user) return <SignIn />;
  if (!can('kot.update_status') && !can('kot.fire')) return <NoAccess />;
  return <Board />;
}
