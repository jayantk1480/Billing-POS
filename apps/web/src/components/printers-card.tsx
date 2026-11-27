'use client';

import {
  Badge, Button, Card, CardHeader, ConfirmDialog, Dialog, EmptyState, ErrorState, errorMessage, LoadingState, SelectField, Switch, Table, Td, TextField, Th, toast,
  useApi, useFormState, useSorted,
} from '@pos/ui';
import { type PrinterDto, printerSchema } from '@pos/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Printer, Send, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';

export const PRINTER_ROLES: Record<PrinterDto['role'], string> = { RECEIPT: 'Bills', KOT: 'Kitchen tickets' };
const CONNECTIONS: Record<PrinterDto['connection'], string> = { NETWORK: 'Network', USB: 'USB', BLUETOOTH: 'Bluetooth', BROWSER: 'Browser' };
const PAPER: Record<PrinterDto['paperWidth'], string> = { MM58: '58 mm', MM80: '80 mm' };
const DEFAULT_PORT = '9100';

/** Where the printer is reached: its network address, its device, or the browser's print dialog. */
const addressOf = (printer: PrinterDto) =>
  printer.connection === 'NETWORK' ? `${printer.host ?? ''}${printer.port ? `:${printer.port}` : ''}` : printer.connection === 'BROWSER' ? 'Print dialog at the counter' : printer.devicePath ?? '';

function PrinterDialog({ printer, onClose, onSaved }: { printer: PrinterDto | null; onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const form = useFormState({
    name: printer?.name ?? '',
    role: (printer?.role ?? 'RECEIPT') as string,
    connection: (printer?.connection ?? 'NETWORK') as string,
    paperWidth: (printer?.paperWidth ?? 'MM80') as string,
    host: printer?.host ?? '',
    port: printer?.port ? String(printer.port) : DEFAULT_PORT,
    devicePath: printer?.devicePath ?? '',
    isDefault: printer?.isDefault ?? false,
    isActive: printer?.isActive ?? true,
  });
  const { values, set, errors } = form;
  const network = values.connection === 'NETWORK';
  const device = values.connection === 'USB' || values.connection === 'BLUETOOTH';

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    // Only the fields that belong to the chosen connection are sent; the rest are cleared.
    const payload = {
      name: values.name, role: values.role, connection: values.connection, paperWidth: values.paperWidth,
      host: network ? values.host : null,
      port: network ? (values.port.trim() === '' ? Number(DEFAULT_PORT) : Number(values.port)) : null,
      devicePath: device ? values.devicePath : null,
      isDefault: values.isDefault, isActive: values.isActive,
    };
    const saved = await form.submit(printerSchema, payload, (data) => (printer ? api.printing.updatePrinter(printer.id, data) : api.printing.createPrinter(data)));
    if (saved) {
      toast.success(printer ? 'Printer updated' : 'Printer added');
      onSaved();
    }
  }

  return (
    <Dialog
      open onClose={onClose} title={printer ? `Edit ${printer.name}` : 'Add printer'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>Cancel</Button>
          <Button type="submit" form="printer-form" loading={form.submitting}>{printer ? 'Save changes' : 'Add printer'}</Button>
        </>
      }
    >
      <form id="printer-form" onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
        <TextField label="Name" value={values.name} onChange={(v) => set('name', v)} error={errors.name} autoFocus placeholder="Counter printer" maxLength={40} className="sm:col-span-2" />
        <SelectField
          label="Used for" value={values.role} onChange={(v) => set('role', v)} error={errors.role}
          options={Object.entries(PRINTER_ROLES).map(([value, label]) => ({ value, label }))}
        />
        <SelectField
          label="Paper width" value={values.paperWidth} onChange={(v) => set('paperWidth', v)} error={errors.paperWidth}
          options={Object.entries(PAPER).map(([value, label]) => ({ value, label }))}
        />
        <SelectField
          label="Connection" value={values.connection} onChange={(v) => set('connection', v)} error={errors.connection} className="sm:col-span-2"
          options={[
            { value: 'NETWORK', label: 'Network (LAN cable or Wi-Fi)' },
            { value: 'USB', label: 'USB' },
            { value: 'BLUETOOTH', label: 'Bluetooth' },
            { value: 'BROWSER', label: "The browser's print dialog at the counter" },
          ]}
          hint={values.connection === 'BROWSER' ? 'The billing screen opens the print dialog, and the cashier picks the printer there. No print bridge is needed.' : 'Printed through the print bridge on the counter computer.'}
        />
        {network && (
          <>
            <TextField label="IP address or host name" value={values.host} onChange={(v) => set('host', v)} error={errors.host} placeholder="192.168.1.50" autoCapitalize="none" spellCheck={false} />
            <TextField label="Port" inputMode="numeric" value={values.port} onChange={(v) => set('port', v)} error={errors.port} hint="Almost always 9100" />
          </>
        )}
        {device && (
          <TextField
            label="Device or printer name" value={values.devicePath} onChange={(v) => set('devicePath', v)} error={errors.devicePath} className="sm:col-span-2" autoCapitalize="none" spellCheck={false}
            placeholder={values.connection === 'USB' ? '/dev/usb/lp0' : 'COM5'} maxLength={200}
            hint="A device such as /dev/usb/lp0 or COM5, or the name of a printer installed on the computer that runs the print bridge."
          />
        )}
        <div className="space-y-4 sm:col-span-2">
          <Switch
            label={values.role === 'KOT' ? 'Default printer for kitchen tickets' : 'Default printer for bills'} checked={values.isDefault} onChange={(v) => set('isDefault', v)}
            description={values.role === 'KOT' ? 'Used by every kitchen station that has not chosen its own printer. Only one printer can be the default.' : 'Bills print here unless another printer is picked. Only one printer can be the default.'}
          />
          <Switch label="In use" checked={values.isActive} onChange={(v) => set('isActive', v)} description="Switch off to stop printing here without deleting the printer." />
        </div>
      </form>
    </Dialog>
  );
}

function PrinterStatus({ printer }: { printer: PrinterDto }) {
  if (!printer.isActive) return <Badge tone="neutral">Switched off</Badge>;
  if (printer.connection === 'BROWSER') return <Badge tone="neutral">Prints from the browser</Badge>;
  if (printer.lastStatus === 'ok') return <Badge tone="ok">Working</Badge>;
  if (printer.lastStatus === 'error') {
    return (
      <>
        <Badge tone="danger">Last print failed</Badge>
        {printer.lastError && <span className="mt-1 block max-w-56 text-xs text-danger">{printer.lastError}</span>}
      </>
    );
  }
  return <Badge tone="neutral">Not used yet</Badge>;
}

export function PrintersCard() {
  const api = useApi();
  const queryClient = useQueryClient();
  const printers = useQuery({ queryKey: ['printers'], queryFn: api.printing.printers });
  const sorted = useSorted(printers.data, {
    name: (printer) => printer.name, role: (printer) => PRINTER_ROLES[printer.role], connection: (printer) => `${CONNECTIONS[printer.connection]} ${addressOf(printer)}`,
    paper: (printer) => printer.paperWidth, isDefault: (printer) => printer.isDefault, status: (printer) => (printer.isActive ? printer.lastStatus : 'off'),
    stations: (printer) => printer.stations.join(', '),
  });
  const [editing, setEditing] = useState<PrinterDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<PrinterDto | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['printers'] });
    // Deleting a printer also takes it off the kitchen stations that used it.
    void queryClient.invalidateQueries({ queryKey: ['stations'] });
  };

  const test = useMutation({
    mutationFn: (printer: PrinterDto) => api.printing.test(printer.id),
    onSuccess: (_job, printer) => {
      toast.success(`Test page sent to ${printer.name}. Check the print queue below if nothing comes out.`);
      void queryClient.invalidateQueries({ queryKey: ['print-jobs'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (printer: PrinterDto) => api.printing.removePrinter(printer.id),
    onSuccess: (_result, printer) => {
      toast.success(`${printer.name} deleted`);
      setDeleting(null);
      refresh();
    },
    onError: (error) => {
      setDeleting(null);
      toast.error(errorMessage(error));
    },
  });
  const addButton = <Button className="shrink-0 whitespace-nowrap" onClick={() => setEditing('new')}><Plus className="size-4" /> Add printer</Button>;

  return (
    <Card>
      <CardHeader
        title="Printers" description="Where bills and kitchen tickets are printed. Each kitchen station can have its own printer, chosen under Kitchen stations."
        action={printers.data && printers.data.length > 0 ? addButton : undefined}
      />
      {printers.isPending ? (
        <LoadingState label="Loading printers" />
      ) : printers.isError ? (
        <ErrorState message={errorMessage(printers.error)} onRetry={() => void printers.refetch()} />
      ) : printers.data.length === 0 ? (
        <EmptyState icon={Printer} title="No printers yet" description="Add the bill printer at the counter first, then a printer for the kitchen." action={addButton} />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th sorter={sorted.sorter} sortKey="name">Name</Th><Th sorter={sorted.sorter} sortKey="role">Used for</Th><Th sorter={sorted.sorter} sortKey="connection">Connection</Th>
              <Th sorter={sorted.sorter} sortKey="paper">Paper</Th><Th sorter={sorted.sorter} sortKey="isDefault">Default</Th><Th sorter={sorted.sorter} sortKey="status">Status</Th>
              <Th sorter={sorted.sorter} sortKey="stations">Stations</Th><Th className="w-0"><span className="sr-only">Actions</span></Th>
            </tr>
          </thead>
          <tbody>
            {sorted.rows.map((printer) => (
              <tr key={printer.id} className="hover:bg-canvas/50">
                <Td className="font-medium text-ink-900">{printer.name}</Td>
                <Td className="whitespace-nowrap">{PRINTER_ROLES[printer.role]}</Td>
                <Td>
                  {CONNECTIONS[printer.connection]}
                  <span className="block break-all text-xs text-ink-500">{addressOf(printer)}</span>
                </Td>
                <Td className="whitespace-nowrap">{PAPER[printer.paperWidth]}</Td>
                <Td>{printer.isDefault ? <Badge tone="ok">Default</Badge> : <span className="text-ink-300">—</span>}</Td>
                <Td><PrinterStatus printer={printer} /></Td>
                <Td>{printer.stations.length > 0 ? printer.stations.join(', ') : <span className="text-ink-300">—</span>}</Td>
                <Td>
                  <div className="flex justify-end">
                    {/* A browser printer has nothing to send a test page to from here. */}
                    {printer.connection !== 'BROWSER' && (
                      <button
                        type="button" aria-label={`Print a test page on ${printer.name}`} title="Test print" disabled={test.isPending || !printer.isActive} onClick={() => test.mutate(printer)}
                        className="rounded-lg p-2 text-ink-500 hover:bg-canvas hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Send className="size-4" />
                      </button>
                    )}
                    <button type="button" aria-label={`Edit ${printer.name}`} title="Edit" onClick={() => setEditing(printer)} className="rounded-lg p-2 text-ink-500 hover:bg-canvas hover:text-ink-900">
                      <Pencil className="size-4" />
                    </button>
                    <button type="button" aria-label={`Delete ${printer.name}`} title="Delete" onClick={() => setDeleting(printer)} className="rounded-lg p-2 text-ink-500 hover:bg-red-50 hover:text-danger">
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {editing && (
        <PrinterDialog
          printer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting)}
        title="Delete printer" confirmLabel="Delete" danger loading={remove.isPending}
        message={<>Delete <strong>{deleting?.name}</strong>? Kitchen stations that print on it go back to the default kitchen printer.</>}
      />
    </Card>
  );
}
