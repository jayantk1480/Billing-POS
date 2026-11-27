'use client';

import {
  Badge, Button, Card, ConfirmDialog, Dialog, EmptyState, ErrorState, errorMessage, InlineSwitch, LoadingState, PageHeader, Table, Td, TextField, Th, toast, useApi, useFormState, useSorted,
} from '@pos/ui';
import { type TaxGroupDto, taxGroupSchema } from '@pos/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Percent, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { bpsToInput, inputToBps } from '@/lib/format';

const percent = (bps: number) => `${bps / 100}%`;

function TaxGroupDialog({ group, onClose, onSaved }: { group: TaxGroupDto | null; onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const form = useFormState({
    name: group?.name ?? '',
    gstRate: group ? bpsToInput(group.gstRateBps) : '',
    cessRate: group ? bpsToInput(group.cessRateBps) : '0',
  });
  const { values, set, errors } = form;
  const gstBps = inputToBps(values.gstRate);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const payload = { name: values.name, gstRateBps: gstBps, cessRateBps: inputToBps(values.cessRate || '0'), isActive: group?.isActive ?? true };
    const saved = await form.submit(taxGroupSchema, payload, (data) => (group ? api.taxGroups.update(group.id, data) : api.taxGroups.create(data)));
    if (saved) {
      toast.success(group ? 'Tax group updated' : 'Tax group added');
      onSaved();
    }
  }

  return (
    <Dialog
      open onClose={onClose} size="sm" title={group ? `Edit ${group.name}` : 'Add tax group'}
      description="Enter the total GST rate. It is split into CGST and SGST for sales within your state, and charged as IGST across states."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>Cancel</Button>
          <Button type="submit" form="tax-form" loading={form.submitting}>{group ? 'Save changes' : 'Add tax group'}</Button>
        </>
      }
    >
      <form id="tax-form" onSubmit={onSubmit} noValidate className="space-y-4">
        <TextField label="Name" value={values.name} onChange={(v) => set('name', v)} error={errors.name} autoFocus placeholder="GST 5%" />
        <div className="grid grid-cols-2 gap-4">
          <TextField label="GST rate" suffix="%" inputMode="decimal" value={values.gstRate} onChange={(v) => set('gstRate', v)} error={errors.gstRateBps} />
          <TextField label="Cess rate" suffix="%" inputMode="decimal" value={values.cessRate} onChange={(v) => set('cessRate', v)} error={errors.cessRateBps} hint="Usually 0" />
        </div>
        {Number.isFinite(gstBps) && gstBps >= 0 && (
          <p className="rounded-lg bg-canvas px-3 py-2.5 text-sm text-ink-700">
            Within the state: CGST {percent(gstBps / 2)} + SGST {percent(gstBps / 2)}. Across states: IGST {percent(gstBps)}.
          </p>
        )}
        {group && group.productCount > 0 && (
          <p className="text-xs text-ink-500">
            {group.productCount} product(s) use this group. A new rate applies to new bills; bills already issued keep the rate they were issued with.
          </p>
        )}
      </form>
    </Dialog>
  );
}

export default function TaxGroupsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const groups = useQuery({ queryKey: ['tax-groups'], queryFn: api.taxGroups.list });
  const sorted = useSorted(groups.data, {
    name: (group) => group.name, gst: (group) => group.gstRateBps, across: (group) => group.gstRateBps + group.cessRateBps,
    products: (group) => group.productCount, active: (group) => group.isActive,
  });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings.get });
  const [editing, setEditing] = useState<TaxGroupDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<TaxGroupDto | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['tax-groups'] });
  const onError = (error: unknown) => toast.error(errorMessage(error));

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => api.taxGroups.update(id, { isActive }),
    onSuccess: () => refresh(),
    onError,
  });
  const remove = useMutation({
    mutationFn: (group: TaxGroupDto) => api.taxGroups.remove(group.id),
    onSuccess: (_result, group) => {
      toast.success(`${group.name} deleted`);
      setDeleting(null);
      void refresh();
    },
    onError: (error) => {
      setDeleting(null);
      onError(error);
    },
  });

  return (
    <>
      <PageHeader
        title="Tax groups"
        description="GST rates you can assign to products. Rates are yours to set and can be changed when the law changes."
        action={<Button onClick={() => setEditing('new')}><Plus className="size-4" /> Add tax group</Button>}
      />
      <Card>
        {groups.isPending ? (
          <LoadingState label="Loading tax groups" />
        ) : groups.isError ? (
          <ErrorState message={errorMessage(groups.error)} onRetry={() => void groups.refetch()} />
        ) : groups.data.length === 0 ? (
          <EmptyState icon={Percent} title="No tax groups yet" description="Add the GST rates that apply to what you sell." action={<Button onClick={() => setEditing('new')}><Plus className="size-4" /> Add tax group</Button>} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th sorter={sorted.sorter} sortKey="name">Name</Th>
                <Th sorter={sorted.sorter} sortKey="gst" className="text-right">GST</Th>
                <Th sorter={sorted.sorter} sortKey="gst">Within state</Th>
                <Th sorter={sorted.sorter} sortKey="across">Across states</Th>
                <Th sorter={sorted.sorter} sortKey="products" className="text-right">Products</Th>
                <Th sorter={sorted.sorter} sortKey="active">Active</Th>
                <Th className="w-0"><span className="sr-only">Actions</span></Th>
              </tr>
            </thead>
            <tbody>
              {sorted.rows.map((group) => (
                <tr key={group.id} className="hover:bg-canvas/50">
                  <Td>
                    <span className="font-medium text-ink-900">{group.name}</span>{' '}
                    {settings.data?.defaultTaxGroupId === group.id && <Badge tone="ok">Default</Badge>}
                  </Td>
                  <Td className="text-right tabular-nums">{percent(group.gstRateBps)}</Td>
                  <Td className="whitespace-nowrap">CGST {percent(group.gstRateBps / 2)} + SGST {percent(group.gstRateBps / 2)}</Td>
                  <Td className="whitespace-nowrap">
                    IGST {percent(group.gstRateBps)}
                    {group.cessRateBps > 0 && ` + Cess ${percent(group.cessRateBps)}`}
                  </Td>
                  <Td className="text-right tabular-nums">{group.productCount}</Td>
                  <Td>
                    <InlineSwitch label={`${group.name} active`} checked={group.isActive} disabled={setActive.isPending} onChange={(isActive) => setActive.mutate({ id: group.id, isActive })} />
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      <button type="button" aria-label={`Edit ${group.name}`} onClick={() => setEditing(group)} className="rounded-lg p-2 text-ink-500 hover:bg-canvas hover:text-ink-900">
                        <Pencil className="size-4" />
                      </button>
                      <button type="button" aria-label={`Delete ${group.name}`} onClick={() => setDeleting(group)} className="rounded-lg p-2 text-ink-500 hover:bg-red-50 hover:text-danger">
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {editing && (
        <TaxGroupDialog
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
        title="Delete tax group" confirmLabel="Delete" danger loading={remove.isPending}
        message={<>Delete <strong>{deleting?.name}</strong>? A tax group that products use cannot be deleted; switch it to inactive instead.</>}
      />
    </>
  );
}
