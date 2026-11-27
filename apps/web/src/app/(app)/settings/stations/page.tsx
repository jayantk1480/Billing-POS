'use client';

import {
  Button, Card, ConfirmDialog, Dialog, EmptyState, ErrorState, errorMessage, InlineSwitch, LoadingState, PageHeader, SelectField, TextField, toast,
  useApi, useFormState,
} from '@pos/ui';
import { type PrinterDto, type StationDto, stationSchema } from '@pos/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Soup, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';

/** The printers a station can use; undefined while they load, null when they could not be read. */
type Printers = PrinterDto[] | null | undefined;

function StationDialog({ station, printers, onClose, onSaved }: { station: StationDto | null; printers: Printers; onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const form = useFormState({ name: station?.name ?? '', printerId: station?.printerId ?? '', fallbackPrinterId: station?.fallbackPrinterId ?? '' });
  const { values, set, errors } = form;
  // A printer that is switched off is offered only where it is already the choice, so it can be seen and changed.
  const options = (chosen: string) =>
    (printers ?? []).filter((printer) => printer.isActive || printer.id === chosen)
      .map((printer) => ({ value: printer.id, label: `${printer.name}${printer.role === 'RECEIPT' ? ' (bill printer)' : ''}${printer.isActive ? '' : ' (switched off)'}` }));
  const printersHint = printers === undefined ? 'Loading printers…' : printers === null ? 'The printers could not be loaded. Close this and try again.' : undefined;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const payload = {
      name: values.name, isActive: station?.isActive ?? true,
      // Left alone when the printers could not be read, so a failed load never clears a station's printer.
      ...(printers ? { printerId: values.printerId || null, fallbackPrinterId: values.fallbackPrinterId || null } : {}),
    };
    const saved = await form.submit(stationSchema, payload, (data) => (station ? api.stations.update(station.id, data) : api.stations.create(data)));
    if (saved) {
      toast.success(station ? 'Station updated' : 'Station added');
      onSaved();
    }
  }

  return (
    <Dialog
      open onClose={onClose} size="sm" title={station ? 'Edit kitchen station' : 'Add kitchen station'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>Cancel</Button>
          <Button type="submit" form="station-form" loading={form.submitting}>{station ? 'Save changes' : 'Add station'}</Button>
        </>
      }
    >
      <form id="station-form" onSubmit={onSubmit} noValidate className="space-y-4">
        <TextField label="Name" value={values.name} onChange={(v) => set('name', v)} error={errors.name} autoFocus placeholder="Tandoor" />
        <SelectField
          label="Printer" value={values.printerId} onChange={(v) => set('printerId', v)} error={errors.printerId} disabled={!printers}
          placeholder="Default kitchen printer" options={options(values.printerId)} hint={printersHint ?? "Where this station's kitchen tickets print"}
        />
        <SelectField
          label="Fallback printer" value={values.fallbackPrinterId} onChange={(v) => set('fallbackPrinterId', v)} error={errors.fallbackPrinterId} disabled={!printers}
          placeholder="Default kitchen printer" options={options(values.fallbackPrinterId)} hint={printersHint ?? 'Used when the printer above cannot print'}
        />
      </form>
    </Dialog>
  );
}

export default function StationsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const stations = useQuery({ queryKey: ['stations'], queryFn: api.stations.list });
  const printers = useQuery({ queryKey: ['printers'], queryFn: api.printing.printers });
  const printerName = (id: string | null) => printers.data?.find((printer) => printer.id === id)?.name;
  const [editing, setEditing] = useState<StationDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<StationDto | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['stations'] });
    // The printers list shows which stations print on each printer.
    void queryClient.invalidateQueries({ queryKey: ['printers'] });
  };
  const onError = (error: unknown) => toast.error(errorMessage(error));

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => api.stations.update(id, { isActive }),
    onSuccess: () => refresh(),
    onError,
  });
  const remove = useMutation({
    mutationFn: (station: StationDto) => api.stations.remove(station.id),
    onSuccess: (_result, station) => {
      toast.success(`${station.name} deleted`);
      setDeleting(null);
      refresh();
    },
    onError: (error) => {
      setDeleting(null);
      onError(error);
    },
  });

  return (
    <>
      <PageHeader
        title="Kitchen stations"
        description="Where items are prepared. Each product is sent to one station, and each station gets its own kitchen ticket."
        action={<Button onClick={() => setEditing('new')}><Plus className="size-4" /> Add station</Button>}
      />
      <Card>
        {stations.isPending ? (
          <LoadingState label="Loading stations" />
        ) : stations.isError ? (
          <ErrorState message={errorMessage(stations.error)} onRetry={() => void stations.refetch()} />
        ) : stations.data.length === 0 ? (
          <EmptyState icon={Soup} title="No kitchen stations yet" description="Add at least one, such as Main Kitchen, so orders can reach the kitchen." action={<Button onClick={() => setEditing('new')}><Plus className="size-4" /> Add station</Button>} />
        ) : (
          <ul className="divide-y divide-line">
            {stations.data.map((station) => (
              <li key={station.id} className="flex items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-900">{station.name}</p>
                  <p className="text-xs text-ink-500">
                    {station.productCount} {station.productCount === 1 ? 'product' : 'products'}
                    {printers.data && (
                      <>
                        {' · '}prints on {station.printerId ? printerName(station.printerId) ?? 'a deleted printer' : 'the default kitchen printer'}
                        {station.fallbackPrinterId && printerName(station.fallbackPrinterId) && `, then ${printerName(station.fallbackPrinterId)} if that fails`}
                      </>
                    )}
                  </p>
                </div>
                <InlineSwitch label={`${station.name} active`} checked={station.isActive} disabled={setActive.isPending} onChange={(isActive) => setActive.mutate({ id: station.id, isActive })} />
                <button type="button" aria-label={`Edit ${station.name}`} onClick={() => setEditing(station)} className="rounded-lg p-2 text-ink-500 hover:bg-canvas hover:text-ink-900">
                  <Pencil className="size-4" />
                </button>
                <button type="button" aria-label={`Delete ${station.name}`} onClick={() => setDeleting(station)} className="rounded-lg p-2 text-ink-500 hover:bg-red-50 hover:text-danger">
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing && (
        <StationDialog
          station={editing === 'new' ? null : editing}
          printers={printers.isPending ? undefined : printers.data ?? null}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting)}
        title="Delete kitchen station" confirmLabel="Delete" danger loading={remove.isPending}
        message={<>Delete <strong>{deleting?.name}</strong>? A station can only be deleted when no products are sent to it.</>}
      />
    </>
  );
}
