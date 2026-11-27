'use client';

import { Badge, Button, Card, CardHeader, ErrorState, errorMessage, LoadingState, PageHeader, TextField, toast, useApi, useAuth, useFormState } from '@pos/ui';
import { changePasswordSchema } from '@pos/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { formatDateTime } from '@/lib/format';

const CLIENT_NAMES: Record<string, string> = { web: 'Back office', pos: 'POS terminal', kds: 'Kitchen display', mobile: 'Mobile app' };

function describeBrowser(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'Browser';
  const system = /Windows/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Mac OS X/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : '';
  return system ? `${browser} on ${system}` : browser;
}

export default function AccountPage() {
  const api = useApi();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.auth.sessions });
  const form = useFormState({ currentPassword: '', newPassword: '', confirm: '' });
  const { values, set, errors } = form;

  const revoke = useMutation({
    mutationFn: (id: string) => api.auth.revokeSession(id),
    onSuccess: () => {
      toast.success('Signed out of that device');
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (values.newPassword !== values.confirm) {
      form.setErrors({ confirm: 'The two passwords do not match' });
      return;
    }
    const saved = await form.submit(changePasswordSchema, values, (data) => api.auth.changePassword(data));
    if (saved) {
      toast.success('Password changed. Other devices have been signed out.');
      form.reset({ currentPassword: '', newPassword: '', confirm: '' });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    }
  }

  return (
    <>
      <PageHeader title="Your account" description={user ? `${user.name} · ${user.email} · ${user.role.name}` : undefined} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Change password" description="Changing it signs you out on your other devices." />
          <form onSubmit={onSubmit} noValidate className="space-y-4 p-5">
            <TextField label="Current password" type="password" autoComplete="current-password" value={values.currentPassword} onChange={(v) => set('currentPassword', v)} error={errors.currentPassword} />
            <TextField label="New password" type="password" autoComplete="new-password" value={values.newPassword} onChange={(v) => set('newPassword', v)} error={errors.newPassword} hint="At least 10 characters" />
            <TextField label="Repeat new password" type="password" autoComplete="new-password" value={values.confirm} onChange={(v) => set('confirm', v)} error={errors.confirm} />
            <div className="flex justify-end">
              <Button type="submit" loading={form.submitting}>Change password</Button>
            </div>
          </form>
        </Card>
        <Card>
          <CardHeader title="Where you are signed in" description="Sign out any device you do not recognise." />
          {sessions.isPending ? (
            <LoadingState />
          ) : sessions.isError ? (
            <ErrorState message={errorMessage(sessions.error)} onRetry={() => void sessions.refetch()} />
          ) : (
            <ul className="divide-y divide-line">
              {sessions.data.map((session) => (
                <li key={session.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-ink-900">
                      {describeBrowser(session.userAgent)}
                      {session.current && <Badge tone="ok">This device</Badge>}
                    </p>
                    <p className="truncate text-xs text-ink-500">
                      {CLIENT_NAMES[session.client ?? ''] ?? 'App'}
                      {session.terminalName && ` · ${session.terminalName}`} · signed in {formatDateTime(session.createdAt)}
                      {session.ip && ` · ${session.ip}`}
                    </p>
                  </div>
                  {!session.current && (
                    <Button variant="secondary" size="sm" onClick={() => revoke.mutate(session.id)} loading={revoke.isPending && revoke.variables === session.id}>
                      Sign out
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
