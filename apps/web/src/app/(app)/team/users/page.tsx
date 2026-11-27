'use client';

import {
  Badge, Button, Card, Checkbox, Dialog, ErrorState, errorMessage, LoadingState, PageHeader, SelectField, Switch, Table, Td, TextField, Th, toast, useApi, useAuth, useFormState, useSorted,
} from '@pos/ui';
import { createUserSchema, type RoleDto, updateUserSchema, type UserDto } from '@pos/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { formatDateTime } from '@/lib/format';

function UserDialog({ user, roles, isSelf, onClose, onSaved }: { user: UserDto | null; roles: RoleDto[]; isSelf: boolean; onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const form = useFormState({
    name: user?.name ?? '',
    email: user?.email ?? '',
    phone: user?.phone ?? '',
    roleId: user?.role.id ?? roles.find((r) => r.key === 'cashier')?.id ?? roles[0]?.id ?? '',
    password: '',
    pin: '',
    removePin: false,
    isActive: user?.isActive ?? true,
  });
  const { values, set, errors } = form;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const saved = user
      ? await form.submit(
          updateUserSchema,
          {
            name: values.name,
            phone: values.phone,
            // Your own role and status cannot be changed, so they are not sent.
            ...(isSelf ? {} : { roleId: values.roleId, isActive: values.isActive }),
            ...(values.password ? { password: values.password } : {}),
            ...(values.removePin ? { pin: null } : values.pin ? { pin: values.pin } : {}),
          },
          (data) => api.users.update(user.id, data),
        )
      : await form.submit(
          createUserSchema,
          { name: values.name, email: values.email, phone: values.phone, roleId: values.roleId, password: values.password, pin: values.pin || null },
          (data) => api.users.create(data),
        );
    if (saved) {
      toast.success(user ? 'User updated' : 'User added');
      onSaved();
    }
  }

  return (
    <Dialog
      open onClose={onClose} title={user ? `Edit ${user.name}` : 'Add user'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>Cancel</Button>
          <Button type="submit" form="user-form" loading={form.submitting}>{user ? 'Save changes' : 'Add user'}</Button>
        </>
      }
    >
      <form id="user-form" onSubmit={onSubmit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Name" value={values.name} onChange={(v) => set('name', v)} error={errors.name} autoFocus />
          <TextField label="Phone" type="tel" value={values.phone} onChange={(v) => set('phone', v)} error={errors.phone} />
        </div>
        <TextField
          label="Email" type="email" value={values.email} onChange={(v) => set('email', v)} error={errors.email}
          disabled={Boolean(user)} hint={user ? 'The sign-in email cannot be changed' : undefined} autoComplete="off"
        />
        <SelectField
          label="Role" value={values.roleId} onChange={(v) => set('roleId', v)} error={errors.roleId} disabled={isSelf}
          hint={isSelf ? 'You cannot change your own role' : undefined} options={roles.map((r) => ({ value: r.id, label: r.name }))}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={user ? 'New password' : 'Password'} type="password" autoComplete="new-password" value={values.password}
            onChange={(v) => set('password', v)} error={errors.password}
            hint={user ? 'Leave blank to keep the current one' : 'At least 10 characters'}
          />
          <div>
            <TextField
              label={user?.hasPin ? 'New billing PIN' : 'Billing PIN'} type="password" inputMode="numeric" autoComplete="off" maxLength={6}
              value={values.pin} onChange={(v) => set('pin', v.replace(/\D/g, ''))} error={errors.pin} disabled={values.removePin}
              hint={user?.hasPin ? 'Leave blank to keep the current one' : '4 to 6 digits, for fast switching at the counter'}
            />
            {user?.hasPin && (
              <div className="mt-2">
                <Checkbox label="Remove PIN" checked={values.removePin} onChange={(checked) => set('removePin', checked)} />
              </div>
            )}
          </div>
        </div>
        {user && !isSelf && (
          <div className="rounded-xl bg-canvas p-4">
            <Switch label="Active" description="Deactivating signs the user out everywhere and blocks sign-in" checked={values.isActive} onChange={(v) => set('isActive', v)} />
          </div>
        )}
      </form>
    </Dialog>
  );
}

export default function UsersPage() {
  const api = useApi();
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: api.users.list });
  const sorted = useSorted(users.data, {
    user: (user) => user.name, role: (user) => user.role.name, pin: (user) => (user.hasPin ? 'Set' : 'Not set'),
    status: (user) => (user.isActive ? 'Active' : 'Inactive'), lastSignIn: (user) => user.lastLoginAt,
  });
  const roles = useQuery({ queryKey: ['roles'], queryFn: api.roles.list });
  const [editing, setEditing] = useState<UserDto | 'new' | null>(null);

  return (
    <>
      <PageHeader
        title="Users"
        description="People who can sign in. A user's role decides what they can see and do."
        action={<Button onClick={() => setEditing('new')} disabled={!roles.data}><Plus className="size-4" /> Add user</Button>}
      />
      <Card>
        {users.isPending ? (
          <LoadingState label="Loading users" />
        ) : users.isError ? (
          <ErrorState message={errorMessage(users.error)} onRetry={() => void users.refetch()} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th sorter={sorted.sorter} sortKey="user">User</Th>
                <Th sorter={sorted.sorter} sortKey="role">Role</Th>
                <Th sorter={sorted.sorter} sortKey="pin">PIN</Th>
                <Th sorter={sorted.sorter} sortKey="status">Status</Th>
                <Th sorter={sorted.sorter} sortKey="lastSignIn">Last sign-in</Th>
                <Th className="w-0"><span className="sr-only">Actions</span></Th>
              </tr>
            </thead>
            <tbody>
              {sorted.rows.map((user) => (
                <tr key={user.id} className="hover:bg-canvas/50">
                  <Td>
                    <p className="font-medium text-ink-900">
                      {user.name} {user.id === me?.id && <span className="font-normal text-ink-500">(you)</span>}
                    </p>
                    <p className="text-xs text-ink-500">{user.email}</p>
                  </Td>
                  <Td>{user.role.name}</Td>
                  <Td>{user.hasPin ? 'Set' : <span className="text-ink-300">Not set</span>}</Td>
                  <Td><Badge tone={user.isActive ? 'ok' : 'neutral'}>{user.isActive ? 'Active' : 'Inactive'}</Badge></Td>
                  <Td className="whitespace-nowrap">{formatDateTime(user.lastLoginAt)}</Td>
                  <Td>
                    <button type="button" aria-label={`Edit ${user.name}`} onClick={() => setEditing(user)} disabled={!roles.data} className="rounded-lg p-2 text-ink-500 hover:bg-canvas hover:text-ink-900">
                      <Pencil className="size-4" />
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {editing && roles.data && (
        <UserDialog
          user={editing === 'new' ? null : editing}
          roles={roles.data}
          isSelf={editing !== 'new' && editing.id === me?.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void queryClient.invalidateQueries({ queryKey: ['users'] });
            void queryClient.invalidateQueries({ queryKey: ['roles'] });
          }}
        />
      )}
    </>
  );
}
