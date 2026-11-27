'use client';

import {
  Button, Card, cn, ConfirmDialog, Dialog, EmptyState, ErrorState, errorMessage, LoadingState, PageHeader, SelectField, Switch, TextField, toast,
  useApi, useFormState, useRealtime,
} from '@pos/ui';
import { type AreaDto, areaSchema, createTableSchema, type TableDto, updateTableSchema } from '@pos/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Armchair, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react';

const SNAP = 8;
const snap = (value: number) => Math.max(0, Math.round(value / SNAP) * SNAP);
const STATUS_STYLE: Record<TableDto['status'], string> = {
  FREE: 'border-green-600/50 bg-green-50 text-green-900',
  OCCUPIED: 'border-amber-500/60 bg-amber-50 text-amber-900',
  BILL_PRINTED: 'border-blue-500/60 bg-blue-50 text-blue-900',
  BLOCKED: 'border-ink-300 bg-slate-100 text-ink-500',
};
const SIZES = [{ value: '80', label: 'Small' }, { value: '96', label: 'Medium' }, { value: '128', label: 'Large' }, { value: '176', label: 'Extra large' }];

function AreaDialog({ area, onClose, onSaved }: { area: AreaDto | null; onClose: () => void; onSaved: (area: AreaDto) => void }) {
  const api = useApi();
  const form = useFormState({ name: area?.name ?? '' });
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await form.submit(areaSchema, form.values, async (data) => {
      const saved = area ? await api.floor.updateArea(area.id, data) : await api.floor.createArea(data);
      toast.success(area ? 'Area renamed' : 'Area added');
      onSaved(saved);
    });
  }
  return (
    <Dialog
      open onClose={onClose} size="sm" title={area ? 'Rename area' : 'Add area'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>Cancel</Button>
          <Button type="submit" form="area-form" loading={form.submitting}>{area ? 'Save changes' : 'Add area'}</Button>
        </>
      }
    >
      <form id="area-form" onSubmit={onSubmit} noValidate>
        <TextField label="Name" value={form.values.name} onChange={(value) => form.set('name', value)} error={form.errors.name} autoFocus placeholder="Terrace" />
      </form>
    </Dialog>
  );
}

function TableDialog({ table, areas, areaId, onClose, onSaved }: { table: TableDto | null; areas: AreaDto[]; areaId: string; onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const form = useFormState({
    name: table?.name ?? '', seats: String(table?.seats ?? 4), shape: (table?.shape ?? 'SQUARE') as string, areaId: table?.areaId ?? areaId,
    width: String(table?.width ?? 96), height: String(table?.height ?? 96), blocked: table?.status === 'BLOCKED',
  });
  const { values, set, errors } = form;
  const inUse = table?.orderId != null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const shared = { areaId: values.areaId, name: values.name, seats: Number(values.seats), shape: values.shape, width: Number(values.width), height: values.shape === 'RECTANGLE' ? Number(values.height) : Number(values.width) };
    const saved = table
      ? await form.submit(updateTableSchema, { ...shared, ...(inUse ? {} : { blocked: values.blocked }) }, (data) => api.floor.updateTable(table.id, data))
      : await form.submit(createTableSchema, shared, (data) => api.floor.createTable(data));
    if (saved) {
      toast.success(table ? 'Table updated' : 'Table added');
      onSaved();
    }
  }
  const remove = useMutation({
    mutationFn: () => api.floor.removeTable(table!.id),
    onSuccess: () => {
      toast.success('Table ' + table!.name + ' removed');
      onSaved();
    },
    onError: (error) => {
      setConfirmDelete(false);
      toast.error(errorMessage(error));
    },
  });

  return (
    <Dialog
      open onClose={onClose} size="sm" title={table ? 'Table ' + table.name : 'Add table'}
      footer={
        <>
          {table && <Button variant="ghost" className="mr-auto" onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" /> Remove</Button>}
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>Cancel</Button>
          <Button type="submit" form="table-form" loading={form.submitting}>{table ? 'Save changes' : 'Add table'}</Button>
        </>
      }
    >
      <form id="table-form" onSubmit={onSubmit} noValidate className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <TextField label="Name" value={values.name} onChange={(value) => set('name', value)} error={errors.name} autoFocus placeholder="T9" maxLength={12} />
          <TextField label="Seats" type="number" min={1} max={50} value={values.seats} onChange={(value) => set('seats', value)} error={errors.seats} />
        </div>
        <SelectField label="Area" value={values.areaId} onChange={(value) => set('areaId', value)} error={errors.areaId} options={areas.map((area) => ({ value: area.id, label: area.name }))} />
        <div className="grid grid-cols-2 gap-4">
          <SelectField
            label="Shape" value={values.shape} onChange={(value) => set('shape', value)}
            options={[{ value: 'SQUARE', label: 'Square' }, { value: 'ROUND', label: 'Round' }, { value: 'RECTANGLE', label: 'Rectangle' }]}
          />
          <SelectField label={values.shape === 'RECTANGLE' ? 'Length' : 'Size'} value={values.width} onChange={(value) => set('width', value)} options={SIZES} />
          {values.shape === 'RECTANGLE' && <SelectField label="Depth" value={values.height} onChange={(value) => set('height', value)} options={SIZES} />}
        </div>
        {table && (
          <div className="rounded-xl bg-canvas p-4">
            <Switch
              label="Blocked" checked={values.blocked} onChange={(value) => set('blocked', value)} disabled={inUse}
              description={inUse ? 'This table has a running order, so it cannot be blocked now.' : 'A blocked table cannot take orders, for example while reserved or under repair.'}
            />
          </div>
        )}
      </form>
      <ConfirmDialog
        open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={() => remove.mutate()} loading={remove.isPending}
        title="Remove table" confirmLabel="Remove" danger
        message={<>Remove table <strong>{table?.name}</strong> from the floor? Past orders at this table are kept.</>}
      />
    </Dialog>
  );
}

export default function FloorPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const areas = useQuery({ queryKey: ['areas'], queryFn: api.floor.areas });
  const tables = useQuery({ queryKey: ['tables'], queryFn: api.pos.tables });
  const [areaId, setAreaId] = useState('');
  const [editingArea, setEditingArea] = useState<AreaDto | 'new' | null>(null);
  const [deletingArea, setDeletingArea] = useState<AreaDto | null>(null);
  const [editingTable, setEditingTable] = useState<TableDto | 'new' | null>(null);
  // Positions changed by dragging but not yet saved.
  const [moved, setMoved] = useState<Record<string, { posX: number; posY: number }>>({});
  const drag = useRef<{ id: string; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['areas'] });
    void queryClient.invalidateQueries({ queryKey: ['tables'] });
  };
  // Table states change as orders are taken on the POS.
  useRealtime((event) => {
    if (event === 'table.updated') void queryClient.invalidateQueries({ queryKey: ['tables'] });
  });
  useEffect(() => {
    if (areas.data && !areas.data.some((area) => area.id === areaId)) setAreaId(areas.data[0]?.id ?? '');
  }, [areas.data, areaId]);

  const save = useMutation({
    mutationFn: () => api.floor.saveLayout({ tables: Object.entries(moved).map(([id, position]) => ({ id, ...position })) }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['tables'], saved);
      setMoved({});
      toast.success('Layout saved. Billing counters show it straight away.');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const removeArea = useMutation({
    mutationFn: (area: AreaDto) => api.floor.removeArea(area.id),
    onSuccess: (_result, area) => {
      toast.success(area.name + ' deleted');
      setDeletingArea(null);
      refresh();
    },
    onError: (error) => {
      setDeletingArea(null);
      toast.error(errorMessage(error));
    },
  });

  const area = areas.data?.find((entry) => entry.id === areaId) ?? null;
  const shown = (tables.data ?? []).filter((table) => table.areaId === areaId).map((table) => ({ ...table, ...moved[table.id] }));
  const dirty = Object.keys(moved).length > 0;
  const place = (id: string, posX: number, posY: number) => setMoved((current) => ({ ...current, [id]: { posX: snap(posX), posY: snap(posY) } }));

  function onPointerDown(event: PointerEvent<HTMLButtonElement>, table: TableDto) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: table.id, startX: event.clientX, startY: event.clientY, originX: table.posX, originY: table.posY, moved: false };
  }
  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    // A few pixels of wobble is still a click, not a drag.
    if (!current.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    current.moved = true;
    place(current.id, current.originX + dx, current.originY + dy);
  }
  function onPointerUp(table: TableDto) {
    const current = drag.current;
    drag.current = null;
    if (current && !current.moved) setEditingTable(table);
  }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, table: TableDto) {
    const step = event.shiftKey ? 40 : SNAP;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = delta[event.key];
    if (move) {
      event.preventDefault();
      place(table.id, table.posX + move[0], table.posY + move[1]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setEditingTable(table);
    }
  }

  const planWidth = Math.max(...shown.map((table) => table.posX + table.width), 0) + 120;
  const planHeight = Math.max(...shown.map((table) => table.posY + table.height), 440) + 120;

  return (
    <>
      <PageHeader
        title="Floor"
        description="Lay out your dining areas the way the room looks. Drag tables into place, then save. The POS shows this plan when a table is chosen."
        action={
          <div className="flex gap-2">
            {dirty && <Button variant="secondary" onClick={() => setMoved({})} disabled={save.isPending}>Discard moves</Button>}
            <Button onClick={() => save.mutate()} disabled={!dirty} loading={save.isPending}>Save layout</Button>
          </div>
        }
      />
      {areas.isPending || tables.isPending ? (
        <Card><LoadingState label="Loading the floor" /></Card>
      ) : areas.isError || tables.isError ? (
        <Card><ErrorState message={errorMessage(areas.error ?? tables.error)} onRetry={refresh} /></Card>
      ) : (
        <Card>
          <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
            <div className="flex gap-1.5 overflow-x-auto" role="tablist" aria-label="Areas">
              {areas.data.map((entry) => (
                <button
                  key={entry.id} type="button" role="tab" aria-selected={entry.id === areaId} onClick={() => setAreaId(entry.id)}
                  className={cn('h-10 shrink-0 rounded-lg px-3.5 text-sm font-medium', entry.id === areaId ? 'bg-brand-50 text-brand-700' : 'text-ink-700 hover:bg-canvas')}
                >
                  {entry.name} <span className="text-xs font-normal text-ink-500">{entry.tableCount}</span>
                </button>
              ))}
            </div>
            <Button variant="ghost" size="sm" onClick={() => setEditingArea('new')}><Plus className="size-4" /> Add area</Button>
            {area && (
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => setEditingArea(area)} aria-label={'Rename ' + area.name}><Pencil className="size-4" /> Rename</Button>
                <Button variant="ghost" size="sm" onClick={() => setDeletingArea(area)} aria-label={'Delete ' + area.name}><Trash2 className="size-4" /> Delete</Button>
                <Button variant="secondary" onClick={() => setEditingTable('new')}><Plus className="size-4" /> Add table</Button>
              </div>
            )}
          </div>

          {!area ? (
            <EmptyState icon={Armchair} title="No dining areas yet" description="Start with an area such as Ground Floor, then add its tables." action={<Button onClick={() => setEditingArea('new')}><Plus className="size-4" /> Add area</Button>} />
          ) : shown.length === 0 ? (
            <EmptyState icon={Armchair} title={'No tables in ' + area.name} description="Add the first table, then drag it to where it stands." action={<Button onClick={() => setEditingTable('new')}><Plus className="size-4" /> Add table</Button>} />
          ) : (
            <div className="overflow-auto" style={{ maxHeight: '68vh' }}>
              <div
                className="relative" aria-label={'Floor plan of ' + area.name}
                style={{ width: planWidth, height: planHeight, minWidth: '100%', backgroundImage: 'radial-gradient(circle, #cbd5e1 1px, transparent 1px)', backgroundSize: '16px 16px' }}
              >
                {shown.map((table) => (
                  <button
                    key={table.id} type="button"
                    aria-label={'Table ' + table.name + ', ' + table.seats + ' seats. Drag or use arrow keys to move; press Enter to edit.'}
                    onPointerDown={(event) => onPointerDown(event, table)} onPointerMove={onPointerMove} onPointerUp={() => onPointerUp(table)}
                    onKeyDown={(event) => onKeyDown(event, table)}
                    className={cn(
                      'absolute flex cursor-grab touch-none select-none flex-col items-center justify-center border-2 shadow-(--shadow-card) active:cursor-grabbing',
                      table.shape === 'ROUND' ? 'rounded-full' : 'rounded-xl', STATUS_STYLE[table.status], moved[table.id] && 'ring-2 ring-brand-500 ring-offset-1',
                    )}
                    style={{ left: table.posX, top: table.posY, width: table.width, height: table.height }}
                  >
                    <span className="text-base font-semibold">{table.name}</span>
                    <span className="text-[11px]">{table.status === 'BLOCKED' ? 'Blocked' : table.seats + ' seats'}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <p className="border-t border-line px-4 py-2.5 text-xs text-ink-500">
            Green is free, amber has a running order, blue has a bill printed, grey is blocked. Click a table to edit it.
            {dirty && <span className="ml-1 font-medium text-brand-700">{Object.keys(moved).length} table(s) moved, not saved yet.</span>}
          </p>
        </Card>
      )}

      {editingArea && (
        <AreaDialog
          area={editingArea === 'new' ? null : editingArea} onClose={() => setEditingArea(null)}
          onSaved={(saved) => {
            setEditingArea(null);
            // Put the area in the list before selecting it, or the selection would fall back to the first area.
            queryClient.setQueryData<AreaDto[]>(['areas'], (current = []) => [...current.filter((entry) => entry.id !== saved.id), saved].sort((x, y) => x.sortOrder - y.sortOrder));
            setAreaId(saved.id);
            refresh();
          }}
        />
      )}
      {editingTable && areas.data && (
        <TableDialog
          table={editingTable === 'new' ? null : editingTable} areas={areas.data} areaId={areaId} onClose={() => setEditingTable(null)}
          onSaved={() => { setEditingTable(null); refresh(); }}
        />
      )}
      <ConfirmDialog
        open={deletingArea !== null} onClose={() => setDeletingArea(null)} onConfirm={() => deletingArea && removeArea.mutate(deletingArea)} loading={removeArea.isPending}
        title="Delete area" confirmLabel="Delete" danger
        message={<>Delete <strong>{deletingArea?.name}</strong>? An area can only be deleted when it has no tables.</>}
      />
    </>
  );
}
