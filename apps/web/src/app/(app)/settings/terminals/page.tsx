'use client';

import {
  Badge, Button, Card, Dialog, EmptyState, ErrorState, errorMessage, InlineSwitch, LoadingState, PageHeader, Table, Td, TextField, Th, toast, useApi, useFormState, useSorted,
} from '@pos/ui';
import { createTerminalSchema, type TerminalDto, updateTerminalSchema } from '@pos/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MonitorSmartphone, Pencil, Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { formatDateTime } from '@/lib/format';

function TerminalDialog({ terminal, onClose, onSaved }: { terminal: TerminalDto | null; onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const form = useFormState({ name: terminal?.name ?? '', code: terminal?.code ?? '' });
  const { values, set, errors } = form;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const saved = terminal
      ? await form.submit(updateTerminalSchema, { name: values.name }, (data) => api.terminals.update(terminal.id, data))
      : await form.submit(createTerminalSchema, values, (data) => api.terminals.create(data));
    if (saved) {
      toast.success(terminal ? 'Terminal renamed' : 'Terminal added');
      onSaved();
    }
  }

  return (
    <Dialog
      open onClose={onClose} size="sm" title={terminal ? 'Rename terminal' : 'Add terminal'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>Cancel</Button>
          <Button type="submit" form="terminal-form" loading={form.submitting}>{terminal ? 'Save changes' : 'Add terminal'}</Button>
        </>
      }
    >
      <form id="terminal-form" onSubmit={onSubmit} noValidate className="space-y-4">
        <TextField label="Name" value={values.name} onChange={(v) => set('name', v)} error={errors.name} autoFocus placeholder="Counter 2" />
        <TextField
          label="Code" value={values.code} onChange={(v) => set('code', v.toUpperCase())} error={errors.code} maxLength={4} disabled={Boolean(terminal)}
          placeholder="B1" hint={terminal ? 'The code is part of issued invoice numbers and cannot change' : 'Up to 4 letters or digits. It starts every invoice number from this terminal, for example B1/2627/000001.'}
        />
      </form>
    </Dialog>
  );
}

export default function TerminalsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const terminals = useQuery({ queryKey: ['terminals'], queryFn: api.terminals.list });
  const sorted = useSorted(terminals.data, {
    code: (terminal) => terminal.code, name: (terminal) => terminal.name, lastSeen: (terminal) => terminal.lastSeenAt, active: (terminal) => terminal.isActive,
  });
  const [editing, setEditing] = useState<TerminalDto | 'new' | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['terminals'] });

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => api.terminals.update(id, { isActive }),
    onSuccess: () => refresh(),
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <>
      <PageHeader
        title="Terminals"
        description="Each billing counter is a terminal with its own invoice number series, so two counters can never issue the same number, even offline."
        action={<Button onClick={() => setEditing('new')}><Plus className="size-4" /> Add terminal</Button>}
      />
      <Card>
        {terminals.isPending ? (
          <LoadingState label="Loading terminals" />
        ) : terminals.isError ? (
          <ErrorState message={errorMessage(terminals.error)} onRetry={() => void terminals.refetch()} />
        ) : terminals.data.length === 0 ? (
          <EmptyState icon={MonitorSmartphone} title="No terminals yet" description="Add one for each billing counter." action={<Button onClick={() => setEditing('new')}><Plus className="size-4" /> Add terminal</Button>} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th sorter={sorted.sorter} sortKey="code">Code</Th>
                <Th sorter={sorted.sorter} sortKey="name">Name</Th>
                <Th sorter={sorted.sorter} sortKey="lastSeen">Last sign-in</Th>
                <Th sorter={sorted.sorter} sortKey="active">Active</Th>
                <Th className="w-0"><span className="sr-only">Actions</span></Th>
              </tr>
            </thead>
            <tbody>
              {sorted.rows.map((terminal) => (
                <tr key={terminal.id} className="hover:bg-canvas/50">
                  <Td><span className="rounded bg-canvas px-2 py-1 font-mono text-xs font-medium text-ink-900">{terminal.code}</span></Td>
                  <Td className="font-medium text-ink-900">
                    {terminal.name} {!terminal.isActive && <Badge tone="neutral">Inactive</Badge>}
                  </Td>
                  <Td className="whitespace-nowrap">{formatDateTime(terminal.lastSeenAt)}</Td>
                  <Td>
                    <InlineSwitch label={`${terminal.name} active`} checked={terminal.isActive} disabled={setActive.isPending} onChange={(isActive) => setActive.mutate({ id: terminal.id, isActive })} />
                  </Td>
                  <Td>
                    <button type="button" aria-label={`Rename ${terminal.name}`} onClick={() => setEditing(terminal)} className="rounded-lg p-2 text-ink-500 hover:bg-canvas hover:text-ink-900">
                      <Pencil className="size-4" />
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {editing && (
        <TerminalDialog
          terminal={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}
