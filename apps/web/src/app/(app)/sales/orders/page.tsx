'use client';

import { formatINR } from '@pos/billing-core';
import {
  Badge, Button, Card, ConfirmDialog, customerLabel, Dialog, EmptyState, ErrorState, errorMessage, formatDateTime, LoadingState, PageHeader, Table, Td,
  TextField, Th, toast, type Tone, useApi, useAuth, useSorter,
} from '@pos/ui';
import type { OrderQuery, OrderStatus, OrderSummaryDto } from '@pos/validation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ClipboardList, ListOrdered, PencilLine, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { EditOrderDialog } from '@/components/edit-order-dialog';

const PAGE_SIZE = 25;
const STATUS: Record<OrderStatus, { label: string; tone: Tone }> = {
  OPEN: { label: 'Open', tone: 'warn' }, HELD: { label: 'On hold', tone: 'neutral' }, BILLED: { label: 'Awaiting payment', tone: 'danger' },
  SETTLED: { label: 'Settled', tone: 'ok' }, CANCELLED: { label: 'Cancelled', tone: 'neutral' }, MERGED: { label: 'Merged', tone: 'neutral' },
};
const TYPES = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' };
const METHODS = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', OTHER: 'Other' };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

function OrderDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const api = useApi();
  const order = useQuery({ queryKey: ['order', id], queryFn: () => api.orders.get(id) });
  const data = order.data;
  return (
    <Dialog open onClose={onClose} title={data ? `Order ${data.displayNumber}` : 'Order'} description={data ? `${TYPES[data.type]}${data.tableName ? ` · Table ${data.tableName}` : ''} · taken by ${data.createdByName} · ${formatDateTime(data.createdAt)}` : undefined}>
      {order.isPending ? <LoadingState /> : order.isError || !data ? <ErrorState message={errorMessage(order.error)} onRetry={() => void order.refetch()} /> : (
        <div className="space-y-4 text-sm">
          {data.cancelReason && <p className="rounded-lg bg-red-50 px-3 py-2.5 text-red-700">Cancelled: {data.cancelReason}</p>}
          {data.customer && <p className="text-ink-700">Customer: <span className="font-medium text-ink-900">{customerLabel(data.customer.phone, data.customer.name)}</span></p>}
          {data.items.length === 0 ? <p className="text-ink-500">This order has no items.</p> : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {data.items.map((item) => (
                <li key={item.id} className="flex justify-between gap-3 px-3 py-2">
                  <span className="text-ink-700">
                    {item.quantity} × {item.name}{item.variantName && ` (${item.variantName})`}
                    {item.modifiers.length > 0 && <span className="text-ink-500"> + {item.modifiers.map((m) => m.name).join(', ')}</span>}
                    {item.notes && <span className="block text-xs italic text-amber-700">{item.notes}</span>}
                  </span>
                  <span className="tabular-nums text-ink-900">{formatINR(item.totalPaise)}</span>
                </li>
              ))}
            </ul>
          )}
          <dl className="space-y-1">
            <div className="flex justify-between"><dt className="text-ink-500">Subtotal</dt><dd className="tabular-nums">{formatINR(data.totals.grossPaise)}</dd></div>
            {data.totals.discountPaise > 0 && <div className="flex justify-between"><dt className="text-ink-500">Discount{data.discount?.reason && ` · ${data.discount.reason}`}</dt><dd className="tabular-nums">− {formatINR(data.totals.discountPaise)}</dd></div>}
            <div className="flex justify-between"><dt className="text-ink-500">GST</dt><dd className="tabular-nums">{formatINR(data.totals.taxPaise)}</dd></div>
            <div className="flex justify-between border-t border-line pt-2 text-base font-semibold text-ink-900"><dt>Total</dt><dd className="tabular-nums">{formatINR(data.totals.totalPaise)}</dd></div>
          </dl>
          {data.invoices.length > 0 && (
            <p className="text-ink-700">
              Bills: {data.invoices.map((invoice) => `${invoice.invoiceNumber}${invoice.status === 'CANCELLED' ? ' (cancelled)' : ''}`).join(', ')}
              {data.paymentMethods.length > 0 && ` · paid by ${data.paymentMethods.map((method) => METHODS[method]).join(' + ')}`}
            </p>
          )}
          <p className="text-xs text-ink-500">Token number {data.tokenNumber ?? '—'} was given to the customer and does not change if orders are renumbered.</p>
        </div>
      )}
    </Dialog>
  );
}

const billNumbers = (order: OrderSummaryDto) => order.invoices.map((invoice) => invoice.invoiceNumber).join(', ');

function DeleteDialog({ order, onDone, onClose }: { order: OrderSummaryDto; onDone: () => void; onClose: () => void }) {
  const api = useApi();
  const [reason, setReason] = useState('');
  const billed = order.invoices.length > 0;
  const remove = useMutation({
    mutationFn: () => api.orders.remove(order.id, { reason: reason.trim() }),
    onSuccess: (result) => {
      const what = billed ? 'Order and its bill deleted' : 'Order deleted';
      const moved = [
        result.changes.length > 0 ? `${result.changes.length} later order(s)` : '',
        result.bills > 0 ? `${result.bills} later bill(s)` : '',
      ].filter(Boolean).join(' and ');
      toast.success(moved ? `${what}. ${moved} renumbered.` : what);
      onDone();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <Dialog
      open onClose={onClose} size="sm" title={`Delete order ${order.displayNumber}`}
      description={billed
        ? 'The order is removed for good, together with its bill and the payments and refunds recorded against it. They leave every list and report.'
        : 'The order is removed for good. Depending on your billing settings, later order numbers move up to close the gap.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={remove.isPending}>Cancel</Button>
          <Button variant="danger" onClick={() => remove.mutate()} disabled={!reason.trim()} loading={remove.isPending}>{billed ? 'Delete order and bill' : 'Delete order'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {billed && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">
            This erases bill {billNumbers(order)} ({formatINR(order.totals.totalPaise)}) and cannot be undone. With automatic renumbering switched on in billing settings, the bills after it move up to close the gap, so their numbers change; copies already printed keep the old numbers.
          </p>
        )}
        <TextField label="Reason" value={reason} onChange={setReason} autoFocus placeholder="Required, and kept in the audit log" />
      </div>
    </Dialog>
  );
}

/** Sends a billed order back to the billing screen to be changed. Its bill does not survive that. */
function ReopenDialog({ order, onDone, onClose }: { order: OrderSummaryDto; onDone: () => void; onClose: () => void }) {
  const api = useApi();
  const [reason, setReason] = useState('');
  const reopen = useMutation({
    mutationFn: () => api.orders.reopen(order.id, { reason: reason.trim() }),
    onSuccess: () => {
      toast.success(`Order ${order.displayNumber} is open again. Change it under Running orders on the billing screen, then bill it again.`);
      onDone();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <Dialog
      open onClose={onClose} size="sm" title={`Reopen order ${order.displayNumber}`}
      description="The order goes back to Running orders on the billing screen, where its items, discount, customer and table can be changed. Bill it again there when it is right."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={reopen.isPending}>Cancel</Button>
          <Button variant="danger" onClick={() => reopen.mutate()} disabled={!reason.trim()} loading={reopen.isPending}>Reopen order</Button>
        </>
      }
    >
      <div className="space-y-4">
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">
          Bill {billNumbers(order)} and the payments recorded against it are erased, and this cannot be undone. Billing the order again issues a new bill, and payment is taken again.
        </p>
        <TextField label="Reason" value={reason} onChange={setReason} autoFocus placeholder="Required, and kept in the audit log" />
      </div>
    </Dialog>
  );
}

export default function OrdersPage() {
  const api = useApi();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [status, setStatus] = useState<OrderStatus | ''>('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<OrderSummaryDto | null>(null);
  const [reopening, setReopening] = useState<OrderSummaryDto | null>(null);
  const [editing, setEditing] = useState<OrderSummaryDto | null>(null);
  const [confirm, setConfirm] = useState<'renumber' | 'restart' | null>(null);

  // Sorting is done by the server, across every page of the list, so a new sort starts again from page one.
  const sorter = useSorter(null, () => setPage(1));
  const filters = {
    from: from || undefined, to: to || undefined, status: status || undefined, search: search.trim() || undefined, page, pageSize: PAGE_SIZE,
    sort: sorter.state?.key as OrderQuery['sort'], direction: sorter.state?.direction,
  };
  const orders = useQuery({ queryKey: ['orders', filters], queryFn: () => api.orders.list(filters), placeholderData: keepPreviousData });
  // Deleting or reopening a billed order also changes bills, the dashboard and reports.
  const refresh = () => queryClient.invalidateQueries();
  const onError = (error: unknown) => toast.error(errorMessage(error));

  const renumber = useMutation({
    mutationFn: api.orders.renumber,
    onSuccess: (result) => {
      const moved = [result.changes.length > 0 ? `${result.changes.length} order(s)` : '', result.bills > 0 ? `${result.bills} bill(s)` : ''].filter(Boolean).join(' and ');
      toast.success(moved ? `${moved} renumbered. There are no gaps now.` : 'There were no gaps to close.');
      setConfirm(null);
      void refresh();
    },
    onError: (error) => { setConfirm(null); onError(error); },
  });
  const restart = useMutation({
    mutationFn: api.orders.restartNumbering,
    onSuccess: () => {
      toast.success('The next order will be number 1.');
      setConfirm(null);
    },
    onError: (error) => { setConfirm(null); onError(error); },
  });

  const total = orders.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const control = 'h-10 rounded-lg border border-line bg-surface px-3 text-sm text-ink-700';

  return (
    <>
      <PageHeader
        title="Orders"
        description="Every order taken at the counters. Order numbers are for the floor; the legal number is the bill number."
        action={can('order.renumber') && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setConfirm('renumber')}><ListOrdered className="size-4" /> {can('invoice.delete') ? 'Reset order and bill numbers' : 'Reset order numbers'}</Button>
            <Button variant="secondary" onClick={() => setConfirm('restart')}><RotateCcw className="size-4" /> Restart from 1</Button>
          </div>
        )}
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <label className="flex items-center gap-2 text-sm text-ink-500">From <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className={control} /></label>
          <label className="flex items-center gap-2 text-sm text-ink-500">To <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className={control} /></label>
          <select aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value as OrderStatus | ''); setPage(1); }} className={control}>
            <option value="">Any status</option>
            {Object.entries(STATUS).map(([value, { label }]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <input type="search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Order number, customer or table" aria-label="Search orders" className={`${control} min-w-56 flex-1`} />
        </div>
        {orders.isPending ? <LoadingState label="Loading orders" /> : orders.isError ? <ErrorState message={errorMessage(orders.error)} onRetry={() => void orders.refetch()} /> : orders.data.items.length === 0 ? (
          <EmptyState icon={ClipboardList} title="No orders match" description="Change the dates or filters. Orders are taken on the POS." />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th sorter={sorter} sortKey="order">Order</Th><Th sorter={sorter} sortKey="date">Date</Th><Th sorter={sorter} sortKey="type">Type</Th>
                  <Th sorter={sorter} sortKey="takenBy">Taken by</Th><Th sorter={sorter} sortKey="bill">Bill</Th><Th sorter={sorter} sortKey="billingType">Billing type</Th>
                  <Th sorter={sorter} sortKey="total" className="text-right">Total</Th><Th sorter={sorter} sortKey="status">Status</Th><Th className="w-0"><span className="sr-only">Actions</span></Th>
                </tr>
              </thead>
              <tbody>
                {orders.data.items.map((order) => (
                  <tr key={order.id} className="hover:bg-canvas/50">
                    <Td>
                      <button type="button" onClick={() => setViewing(order.id)} className="font-medium text-brand-700 hover:underline">{order.displayNumber}</button>
                      <span className="block text-xs text-ink-500">{order.itemCount} {order.itemCount === 1 ? 'item' : 'items'}{(order.customerPhone || order.customerName) && ` · ${customerLabel(order.customerPhone, order.customerName)}`}</span>
                    </Td>
                    <Td className="whitespace-nowrap">{formatDateTime(order.createdAt)}</Td>
                    <Td>{TYPES[order.type]}{order.tableName && ` · ${order.tableName}`}</Td>
                    <Td>{order.createdByName}</Td>
                    <Td className="whitespace-nowrap">{order.invoices.map((invoice) => invoice.invoiceNumber).join(', ') || <span className="text-ink-300">Not billed</span>}</Td>
                    <Td className="whitespace-nowrap">{order.paymentMethods.map((method) => METHODS[method]).join(' + ') || <span className="text-ink-300">Not paid</span>}</Td>
                    <Td className="text-right font-medium tabular-nums text-ink-900">{formatINR(order.totals.totalPaise)}</Td>
                    <Td><Badge tone={STATUS[order.status].tone}>{STATUS[order.status].label}</Badge></Td>
                    <Td>
                      <div className="flex justify-end">
                        {/* An open order can be changed by anyone who takes orders; a billed one only by someone who may replace its bill. */}
                        {can('menu.view') && (order.status === 'OPEN' || order.status === 'HELD' ? can('order.create') : (order.status === 'BILLED' || order.status === 'SETTLED') && can('invoice.delete')) && (
                          <button type="button" aria-label={`Change order ${order.displayNumber}`} title="Change items" onClick={() => setEditing(order)} className="rounded-lg p-2 text-ink-500 hover:bg-canvas hover:text-ink-900"><PencilLine className="size-4" /></button>
                        )}
                        {(order.invoices.length === 0 ? can('order.delete') : can('invoice.delete')) && (
                          <button type="button" aria-label={`Delete order ${order.displayNumber}`} title="Delete" onClick={() => setDeleting(order)} className="rounded-lg p-2 text-ink-500 hover:bg-red-50 hover:text-danger"><Trash2 className="size-4" /></button>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="flex items-center justify-between px-4 py-3 text-sm text-ink-500">
              <span>{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}</span>
              <div className="flex items-center gap-1">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /></Button>
                <span className="px-2 tabular-nums">{page} / {pageCount}</span>
                <Button variant="secondary" size="sm" disabled={page >= pageCount} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight className="size-4" /></Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {viewing && <OrderDialog id={viewing} onClose={() => setViewing(null)} />}
      {deleting && <DeleteDialog order={deleting} onClose={() => setDeleting(null)} onDone={() => { setDeleting(null); void refresh(); }} />}
      {editing && (
        <EditOrderDialog
          orderId={editing.id} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void refresh(); }}
          onSendToPos={() => { setReopening(editing); setEditing(null); }}
        />
      )}
      {reopening && <ReopenDialog order={reopening} onClose={() => setReopening(null)} onDone={() => { setReopening(null); void refresh(); }} />}
      <ConfirmDialog
        open={confirm === 'renumber'} onClose={() => setConfirm(null)} onConfirm={() => renumber.mutate()} loading={renumber.isPending}
        title={can('invoice.delete') ? 'Reset order and bill numbers' : 'Reset order numbers'} confirmLabel="Close the gaps"
        message={can('invoice.delete')
          ? 'Orders in the current numbering period are renumbered 1, 2, 3… in their existing order, so no numbers are missing. Bill and credit-note numbers are made consecutive in the same way; copies already printed keep their old numbers. Customer token numbers are not changed.'
          : 'Orders in the current numbering period are renumbered 1, 2, 3… in their existing order, so no numbers are missing. Bill numbers and customer token numbers are not changed.'}
      />
      <ConfirmDialog
        open={confirm === 'restart'} onClose={() => setConfirm(null)} onConfirm={() => restart.mutate()} loading={restart.isPending}
        title="Restart order numbers from 1" confirmLabel="Restart from 1"
        message="The next order taken will be number 1. Orders already taken keep their numbers and stay in the history. Bill numbers carry on as before."
      />
    </>
  );
}
