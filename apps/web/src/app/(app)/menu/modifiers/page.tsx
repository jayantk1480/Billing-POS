'use client';

import { formatINR } from '@pos/billing-core';
import {
  Badge, Button, Card, Checkbox, ConfirmDialog, Dialog, EmptyState, ErrorState, errorMessage, LoadingState, PageHeader, TextField,
  toast, useApi, useAuth, useFormState,
} from '@pos/ui';
import { type ModifierGroupDto, modifierGroupSchema } from '@pos/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { inputToPaise, paiseToInput } from '@/lib/format';

interface OptionRow {
  key: string;
  id?: string;
  name: string;
  price: string;
  isAvailable: boolean;
}

let counter = 0;
const blankOption = (): OptionRow => ({ key: `new-${(counter += 1)}`, name: '', price: '0', isAvailable: true });

function selectionRule(group: Pick<ModifierGroupDto, 'minSelect' | 'maxSelect'>): string {
  if (group.minSelect === 0) return group.maxSelect === 1 ? 'Optional, choose one' : `Optional, up to ${group.maxSelect}`;
  if (group.minSelect === group.maxSelect) return `Required, choose ${group.minSelect}`;
  return `Required, choose ${group.minSelect} to ${group.maxSelect}`;
}

function ModifierGroupDialog({ group, onClose, onSaved }: { group: ModifierGroupDto | null; onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const form = useFormState({
    name: group?.name ?? '',
    minSelect: String(group?.minSelect ?? 0),
    maxSelect: String(group?.maxSelect ?? 1),
    isActive: group?.isActive ?? true,
    options: group ? group.modifiers.map<OptionRow>((m) => ({ key: m.id, id: m.id, name: m.name, price: paiseToInput(m.pricePaise), isAvailable: m.isAvailable })) : [blankOption()],
  });
  const { values, set, errors } = form;
  const setOption = (key: string, patch: Partial<OptionRow>) => set('options', values.options.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const payload = {
      name: values.name,
      minSelect: Number(values.minSelect),
      maxSelect: Number(values.maxSelect),
      isActive: values.isActive,
      modifiers: values.options.map((row) => ({ id: row.id, name: row.name, pricePaise: inputToPaise(row.price), isAvailable: row.isAvailable })),
    };
    const saved = await form.submit(modifierGroupSchema, payload, (data) =>
      group ? api.modifierGroups.update(group.id, data) : api.modifierGroups.create(data),
    );
    if (saved) {
      toast.success(group ? 'Modifier group updated' : 'Modifier group added');
      onSaved();
    }
  }

  return (
    <Dialog
      open onClose={onClose} title={group ? `Edit ${group.name}` : 'Add modifier group'}
      description="Choices offered when the item is added to a bill, such as add-ons or spice level."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>Cancel</Button>
          <Button type="submit" form="modifier-form" loading={form.submitting}>{group ? 'Save changes' : 'Add group'}</Button>
        </>
      }
    >
      <form id="modifier-form" onSubmit={onSubmit} noValidate className="space-y-5">
        <TextField label="Name" value={values.name} onChange={(v) => set('name', v)} error={errors.name} autoFocus placeholder="Add-ons" />
        <div className="grid grid-cols-2 gap-4">
          <TextField label="Minimum choices" type="number" min={0} max={20} value={values.minSelect} onChange={(v) => set('minSelect', v)} error={errors.minSelect} hint="0 makes the group optional" />
          <TextField label="Maximum choices" type="number" min={1} max={20} value={values.maxSelect} onChange={(v) => set('maxSelect', v)} error={errors.maxSelect} />
        </div>
        <fieldset>
          <div className="flex items-center justify-between">
            <legend className="text-sm font-semibold text-ink-900">Options</legend>
            <Button variant="secondary" size="sm" onClick={() => set('options', [...values.options, blankOption()])}>
              <Plus className="size-4" /> Add option
            </Button>
          </div>
          {errors.modifiers && <p role="alert" className="mt-2 text-xs text-danger">{errors.modifiers}</p>}
          <ul className="mt-3 space-y-2">
            {values.options.map((row, index) => (
              <li key={row.key} className="grid grid-cols-[1fr_7rem_auto_auto] items-start gap-2">
                <TextField label="Option" value={row.name} onChange={(v) => setOption(row.key, { name: v })} error={errors[`modifiers.${index}.name`]} placeholder="Extra cheese" />
                <TextField label="Extra price" prefix="₹" inputMode="decimal" value={row.price} onChange={(v) => setOption(row.key, { price: v })} error={errors[`modifiers.${index}.pricePaise`]} />
                <div className="pt-8">
                  <Checkbox label="Available" checked={row.isAvailable} onChange={(checked) => setOption(row.key, { isAvailable: checked })} />
                </div>
                <button
                  type="button" aria-label={`Remove option ${row.name || index + 1}`} disabled={values.options.length === 1}
                  onClick={() => set('options', values.options.filter((other) => other.key !== row.key))}
                  className="mt-7 rounded-lg p-2 text-ink-500 hover:bg-red-50 hover:text-danger disabled:opacity-30"
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        </fieldset>
      </form>
    </Dialog>
  );
}

export default function ModifiersPage() {
  const api = useApi();
  const canManage = useAuth().can('menu.manage');
  const queryClient = useQueryClient();
  const groups = useQuery({ queryKey: ['modifier-groups'], queryFn: api.modifierGroups.list });
  const [editing, setEditing] = useState<ModifierGroupDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ModifierGroupDto | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['modifier-groups'] });

  const remove = useMutation({
    mutationFn: (group: ModifierGroupDto) => api.modifierGroups.remove(group.id),
    onSuccess: (_result, group) => {
      toast.success(`${group.name} deleted`);
      setDeleting(null);
      void refresh();
      void queryClient.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <>
      <PageHeader
        title="Modifiers"
        description="Add-ons and choices that can be attached to products."
        action={canManage && <Button onClick={() => setEditing('new')}><Plus className="size-4" /> Add group</Button>}
      />
      {groups.isPending ? (
        <Card><LoadingState label="Loading modifiers" /></Card>
      ) : groups.isError ? (
        <Card><ErrorState message={errorMessage(groups.error)} onRetry={() => void groups.refetch()} /></Card>
      ) : groups.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={SlidersHorizontal} title="No modifier groups yet" description="Create a group such as Add-ons or Spice Level, then attach it to products."
            action={canManage && <Button onClick={() => setEditing('new')}><Plus className="size-4" /> Add group</Button>}
          />
        </Card>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2" aria-label="Modifier groups">
          {groups.data.map((group) => (
            <li key={group.id}>
            <Card className="h-full p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-ink-900">{group.name}</h2>
                  <p className="mt-0.5 text-xs text-ink-500">
                    {selectionRule(group)} · used by {group.productCount} {group.productCount === 1 ? 'product' : 'products'}
                  </p>
                </div>
                {canManage && (
                  <div className="flex gap-1">
                    <button type="button" aria-label={`Edit ${group.name}`} onClick={() => setEditing(group)} className="rounded-lg p-2 text-ink-500 hover:bg-canvas hover:text-ink-900">
                      <Pencil className="size-4" />
                    </button>
                    <button type="button" aria-label={`Delete ${group.name}`} onClick={() => setDeleting(group)} className="rounded-lg p-2 text-ink-500 hover:bg-red-50 hover:text-danger">
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                )}
              </div>
              <ul className="mt-4 space-y-1.5">
                {group.modifiers.map((option) => (
                  <li key={option.id} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 text-ink-700">
                      {option.name}
                      {!option.isAvailable && <Badge tone="warn">Unavailable</Badge>}
                    </span>
                    <span className="tabular-nums text-ink-500">{option.pricePaise ? `+ ${formatINR(option.pricePaise)}` : 'Free'}</span>
                  </li>
                ))}
              </ul>
            </Card>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <ModifierGroupDialog
          group={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting)}
        title="Delete modifier group" confirmLabel="Delete" danger loading={remove.isPending}
        message={<>Delete <strong>{deleting?.name}</strong>? It will be removed from the {deleting?.productCount ?? 0} product(s) that use it.</>}
      />
    </>
  );
}
