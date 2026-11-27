'use client';

import type { PermissionKey } from '@pos/types';
import {
  Badge, Button, Card, Checkbox, cn, ConfirmDialog, Dialog, ErrorState, errorMessage, LoadingState, PageHeader, TextField, toast,
  useApi, useAuth, useFormState,
} from '@pos/ui';
import { createRoleSchema, type PermissionDto, type RoleDto } from '@pos/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';

function NewRoleDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (role: RoleDto) => void }) {
  const api = useApi();
  const form = useFormState({ name: '' });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await form.submit(createRoleSchema, { name: form.values.name, permissions: [] }, async (data) => {
      const role = await api.roles.create(data);
      toast.success(`${role.name} created. Now choose what it can do.`);
      onCreated(role);
    });
  }

  return (
    <Dialog
      open onClose={onClose} size="sm" title="Add role"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>Cancel</Button>
          <Button type="submit" form="role-form" loading={form.submitting}>Add role</Button>
        </>
      }
    >
      <form id="role-form" onSubmit={onSubmit} noValidate>
        <TextField label="Role name" value={form.values.name} onChange={(v) => form.set('name', v)} error={form.errors.name} autoFocus placeholder="Shift supervisor" />
      </form>
    </Dialog>
  );
}

function RoleEditor({ role, permissions, onSaved, onDeleted }: { role: RoleDto; permissions: PermissionDto[]; onSaved: () => void; onDeleted: () => void }) {
  const api = useApi();
  const { can } = useAuth();
  const [selected, setSelected] = useState<Set<PermissionKey>>(new Set(role.permissions));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const locked = role.key === 'owner';

  useEffect(() => setSelected(new Set(role.permissions)), [role]);

  const groups = useMemo(() => {
    const map = new Map<string, PermissionDto[]>();
    for (const permission of permissions) map.set(permission.group, [...(map.get(permission.group) ?? []), permission]);
    return [...map.entries()];
  }, [permissions]);

  const changed = selected.size !== role.permissions.length || role.permissions.some((key) => !selected.has(key));

  const save = useMutation({
    mutationFn: () => api.roles.update(role.id, { permissions: [...selected] }),
    onSuccess: () => {
      toast.success(`${role.name} updated. The change applies immediately.`);
      onSaved();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: () => api.roles.remove(role.id),
    onSuccess: () => {
      toast.success(`${role.name} deleted`);
      onDeleted();
    },
    onError: (error) => {
      setConfirmDelete(false);
      toast.error(errorMessage(error));
    },
  });

  const toggle = (key: PermissionKey, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink-900">
            {role.name}
            {role.isSystem && <Badge tone="neutral">Built-in</Badge>}
          </h2>
          <p className="mt-0.5 text-sm text-ink-500">
            {role.userCount} {role.userCount === 1 ? 'user' : 'users'} · {selected.size} of {permissions.length} permissions
          </p>
        </div>
        <div className="flex gap-2">
          {!role.isSystem && (
            <Button variant="secondary" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-4" /> Delete
            </Button>
          )}
          {!locked && (
            <Button onClick={() => save.mutate()} disabled={!changed} loading={save.isPending}>
              Save permissions
            </Button>
          )}
        </div>
      </div>
      {locked && (
        <p className="flex items-center gap-2 border-b border-line bg-canvas px-5 py-3 text-sm text-ink-700">
          <Lock className="size-4 shrink-0" /> The Owner role always has every permission and cannot be changed.
        </p>
      )}
      <div className="grid gap-x-8 gap-y-6 p-5 sm:grid-cols-2">
        {groups.map(([group, items]) => (
          <fieldset key={group}>
            <legend className="text-xs font-medium uppercase tracking-wider text-ink-500">{group}</legend>
            <div className="mt-2.5 space-y-2">
              {items.map((permission) => (
                <Checkbox
                  key={permission.key}
                  label={permission.description}
                  checked={selected.has(permission.key)}
                  // You can only hand out permissions you hold yourself.
                  disabled={locked || !can(permission.key)}
                  onChange={(checked) => toggle(permission.key, checked)}
                />
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <ConfirmDialog
        open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={() => remove.mutate()}
        title="Delete role" confirmLabel="Delete" danger loading={remove.isPending}
        message={<>Delete the <strong>{role.name}</strong> role? A role can only be deleted when no users have it.</>}
      />
    </Card>
  );
}

export default function RolesPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: api.roles.list });
  const permissions = useQuery({ queryKey: ['permissions'], queryFn: api.roles.permissions, staleTime: Infinity });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['roles'] });

  const selected = roles.data?.find((role) => role.id === selectedId) ?? roles.data?.[0];

  return (
    <>
      <PageHeader
        title="Roles"
        description="A role is a set of permissions. Change a role and everyone who has it is affected straight away."
        action={<Button onClick={() => setCreating(true)}><Plus className="size-4" /> Add role</Button>}
      />
      {roles.isPending || permissions.isPending ? (
        <Card><LoadingState label="Loading roles" /></Card>
      ) : roles.isError || permissions.isError ? (
        <Card><ErrorState message={errorMessage(roles.error ?? permissions.error)} onRetry={() => { void roles.refetch(); void permissions.refetch(); }} /></Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
          <ul className="flex gap-2 overflow-x-auto lg:flex-col lg:gap-1" aria-label="Roles">
            {roles.data.map((role) => (
              <li key={role.id}>
                <button
                  type="button" onClick={() => setSelectedId(role.id)} aria-current={selected?.id === role.id ? 'true' : undefined}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 whitespace-nowrap rounded-lg px-3 py-2.5 text-left text-sm font-medium',
                    selected?.id === role.id ? 'bg-surface text-brand-700 shadow-(--shadow-card) ring-1 ring-line' : 'text-ink-700 hover:bg-surface',
                  )}
                >
                  {role.name}
                  <span className="text-xs font-normal text-ink-500">{role.userCount}</span>
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <RoleEditor
              key={selected.id} role={selected} permissions={permissions.data}
              onSaved={() => void refresh()}
              onDeleted={() => {
                setSelectedId(null);
                void refresh();
              }}
            />
          )}
        </div>
      )}
      {creating && (
        <NewRoleDialog
          onClose={() => setCreating(false)}
          onCreated={(role) => {
            setCreating(false);
            setSelectedId(role.id);
            void refresh();
          }}
        />
      )}
    </>
  );
}
