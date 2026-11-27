'use client';

import { ApiRequestError } from '@pos/api-client';
import { Button, cn, ErrorState, errorMessage, LoadingState, TextField, useApi } from '@pos/ui';
import type { PinUser } from '@pos/validation';
import { useQuery } from '@tanstack/react-query';
import { ChefHat, MonitorSmartphone } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { APP_NAME, OFFLINE_DAYS } from '@/lib/api';
import { checkConnection, isUnreachable } from '@/lib/connection';
import { PinPad } from './pin-pad';

const TERMINAL_KEY = 'pos.terminalId';
const remembered = () => (typeof window === 'undefined' ? null : window.localStorage.getItem(TERMINAL_KEY));

function Frame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-900 px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl bg-surface p-7 shadow-2xl">
        <div className="mb-6 flex items-center gap-2.5 text-base font-semibold text-ink-900">
          <span className="flex size-9 items-center justify-center rounded-xl bg-brand-600 text-white">
            <ChefHat className="size-5" />
          </span>
          {APP_NAME}
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-500">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}

export function SignInScreen() {
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
      await api.auth.login(email, password, remembered() ?? undefined);
    } catch (caught) {
      // A terminal that was deleted or deactivated must not block sign-in: forget it and choose again.
      if (caught instanceof ApiRequestError && caught.code === 'TERMINAL_NOT_FOUND') {
        window.localStorage.removeItem(TERMINAL_KEY);
        return onSubmit(event);
      }
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not sign in. Please try again.');
      setLoading(false);
    }
  }

  return (
    <Frame title="Sign in to bill" subtitle="Use your own account. You can switch users with a PIN afterwards.">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <TextField label="Email" type="email" autoComplete="username" autoFocus value={email} onChange={setEmail} />
        <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={setPassword} />
        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">{error}</p>}
        <Button type="submit" size="touch" className="w-full" loading={loading}>Sign in</Button>
      </form>
    </Frame>
  );
}

/** Shown once per device: which billing counter is this? The answer decides the invoice number series. */
export function TerminalScreen() {
  const api = useApi();
  const terminals = useQuery({ queryKey: ['terminals'], queryFn: api.terminals.list });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(id: string) {
    setBusy(id);
    setError(null);
    try {
      await api.auth.selectTerminal(id);
      window.localStorage.setItem(TERMINAL_KEY, id);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(null);
    }
  }

  const active = terminals.data?.filter((terminal) => terminal.isActive) ?? [];
  return (
    <Frame title="Which terminal is this?" subtitle="Each billing counter has its own invoice numbers. This device will remember your choice.">
      {terminals.isPending ? (
        <LoadingState />
      ) : terminals.isError ? (
        <ErrorState message={errorMessage(terminals.error)} onRetry={() => void terminals.refetch()} />
      ) : active.length === 0 ? (
        <p className="text-sm text-ink-500">No terminals are set up. Ask the owner to add one under Settings → Terminals in the back office.</p>
      ) : (
        <ul className="space-y-2">
          {active.map((terminal) => (
            <li key={terminal.id}>
              <button
                type="button" onClick={() => void choose(terminal.id)} disabled={busy !== null}
                className="flex h-14 w-full items-center gap-3 rounded-xl border border-line px-4 text-left hover:border-brand-500 hover:bg-brand-50 disabled:opacity-60"
              >
                <MonitorSmartphone className="size-5 text-ink-500" />
                <span className="flex-1 font-medium text-ink-900">{terminal.name}</span>
                <span className="rounded bg-canvas px-2 py-1 font-mono text-xs text-ink-700">{terminal.code}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <Button variant="ghost" className="mt-4 w-full" onClick={() => void api.auth.logout()}>Sign out</Button>
    </Frame>
  );
}

/** The terminal is locked: anyone with a PIN can take over without the previous user's password. */
export function LockScreen() {
  const api = useApi();
  const [users, setUsers] = useState<PinUser[] | null>(null);
  const [selected, setSelected] = useState<PinUser | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setUnreachable(false);
    api.auth.pinUsers().then(setUsers, (caught: unknown) => {
      // No connection: unlocking needs the server, so wait for it. Otherwise the terminal's session is gone entirely,
      // and a full sign-in is the way back.
      if (isUnreachable(caught)) setUnreachable(true);
      else void api.auth.logout();
    });
  }, [api, attempt]);

  async function unlock() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.pinLogin(selected.id, pin);
    } catch (caught) {
      setError(errorMessage(caught));
      setPin('');
      setBusy(false);
    }
  }

  return (
    <Frame title="Terminal locked" subtitle={selected ? `Enter the PIN for ${selected.name}.` : 'Choose your name to continue.'}>
      {unreachable && !users ? (
        <ErrorState message="Cannot reach the server. Unlocking needs the connection." onRetry={() => setAttempt((count) => count + 1)} />
      ) : !users ? (
        <LoadingState />
      ) : !selected ? (
        <ul className="space-y-2">
          {users.map((user) => (
            <li key={user.id}>
              <button
                type="button" onClick={() => setSelected(user)}
                className={cn('flex h-14 w-full items-center justify-between rounded-xl border border-line px-4 text-left hover:border-brand-500 hover:bg-brand-50')}
              >
                <span className="font-medium text-ink-900">{user.name}</span>
                <span className="text-sm text-ink-500">{user.roleName}</span>
              </button>
            </li>
          ))}
          {users.length === 0 && <li className="text-sm text-ink-500">Nobody has a billing PIN yet. Sign in with a password instead.</li>}
        </ul>
      ) : (
        <>
          <PinPad value={pin} onChange={setPin} label="PIN" error={error} />
          <Button size="touch" className="mt-4 w-full" disabled={pin.length < 4} loading={busy} onClick={() => void unlock()}>Unlock</Button>
          <Button variant="ghost" className="mt-2 w-full" onClick={() => { setSelected(null); setPin(''); setError(null); }}>Choose someone else</Button>
        </>
      )}
      <Button variant="ghost" className="mt-2 w-full" onClick={() => void api.auth.logout()}>Sign in with a password</Button>
    </Frame>
  );
}

/**
 * The app opened without the server, and nobody signed in on this device recently enough to carry on offline. The
 * connection is checked every few seconds; this screen gives way by itself once the server answers.
 */
export function UnreachableScreen() {
  const api = useApi();
  const [busy, setBusy] = useState(false);

  async function retry() {
    setBusy(true);
    if (await checkConnection()) await api.auth.restore();
    setBusy(false);
  }

  return (
    <Frame title="Cannot reach the server" subtitle="Check the internet connection. This screen moves on by itself once the server answers.">
      <Button size="touch" className="w-full" loading={busy} onClick={() => void retry()}>Try again</Button>
      <p className="mt-4 text-sm text-ink-500">
        To open without the internet, someone must have signed in on this device while it was online, in the last {OFFLINE_DAYS} days.
      </p>
    </Frame>
  );
}
