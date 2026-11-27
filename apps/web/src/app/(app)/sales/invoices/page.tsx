'use client';

import { formatINR } from '@pos/billing-core';
import {
  Badge, Button, Card, Checkbox, cn, Dialog, EmptyState, ErrorState, errorMessage, formatDateTime, inputToPaise, LoadingState, PageHeader,
  paiseToInput, Table, Td, TextField, Th, toast, type Tone, useApi, useAuth, useSorted, useSorter,
  customerLabel,
} from '@pos/ui';
import type { InvoiceDto, InvoiceQuery, InvoiceSummaryDto, PaymentMethod } from '@pos/validation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FileText, ReceiptText } from 'lucide-react';
import { useState } from 'react';

const PAGE_SIZE = 25;
const PAYMENT: Record<InvoiceSummaryDto['paymentStatus'], { label: string; tone: Tone }> = {
  UNPAID: { label: 'Unpaid', tone: 'danger' }, PARTIALLY_PAID: { label: 'Part paid', tone: 'warn' }, PAID: { label: 'Paid', tone: 'ok' },
  PARTIALLY_REFUNDED: { label: 'Part refunded', tone: 'warn' }, REFUNDED: { label: 'Refunded', tone: 'neutral' },
};
const statusOf = (invoice: InvoiceSummaryDto) => (invoice.status === 'CANCELLED' ? { label: 'Cancelled', tone: 'neutral' as Tone } : PAYMENT[invoice.paymentStatus]);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const METHODS: { id: PaymentMethod; label: string }[] = [{ id: 'CASH', label: 'Cash' }, { id: 'UPI', label: 'UPI' }, { id: 'CARD', label: 'Card' }, { id: 'OTHER', label: 'Other' }];
const methodLabel = (method: PaymentMethod) => METHODS.find((entry) => entry.id === method)!.label;

function RefundForm({ invoice, onDone, onCancel }: { invoice: InvoiceDto; onDone: (invoice: InvoiceDto) => void; onCancel: () => void }) {
  const api = useApi();
  const refundable = invoice.payments.filter((p) => p.status === 'SUCCESS' && p.amountPaise > p.refundedPaise);
  const [paymentId, setPaymentId] = useState(refundable[0]?.id ?? '');
  const payment = refundable.find((p) => p.id === paymentId);
  const max = payment ? payment.amountPaise - payment.refundedPaise : 0;
  const [amount, setAmount] = useState(paiseToInput(max));
  const [reason, setReason] = useState('');
  const [requestId] = useState(() => crypto.randomUUID());
  const value = inputToPaise(amount);
  const amountError = !Number.isInteger(value) || value <= 0 ? 'Enter an amount' : value > max ? `At most ${formatINR(max)}` : undefined;
  const refund = useMutation({
    mutationFn: () => api.invoices.refund(invoice.id, { id: requestId, paymentId, amountPaise: value, reason: reason.trim() }),
    onSuccess: (updated) => {
      toast.success(`Refunded ${formatINR(value)}. Credit note ${updated.refunds.at(-1)?.creditNoteNumber} issued.`);
      onDone(updated);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <div className="space-y-4 rounded-xl border border-line bg-canvas p-4">
      <p className="text-sm font-semibold text-ink-900">Refund</p>
      <div className="grid gap-2" role="radiogroup" aria-label="Payment to refund">
        {refundable.map((p) => (
          <button
            key={p.id} type="button" role="radio" aria-checked={p.id === paymentId} onClick={() => { setPaymentId(p.id); setAmount(paiseToInput(p.amountPaise - p.refundedPaise)); }}
            className={cn('flex h-10 items-center justify-between rounded-lg border bg-surface px-3 text-sm', p.id === paymentId ? 'border-brand-600 ring-1 ring-brand-600' : 'border-line')}
          >
            <span className="font-medium text-ink-900">{methodLabel(p.method)}</span>
            <span className="tabular-nums text-ink-700">{formatINR(p.amountPaise - p.refundedPaise)} refundable</span>
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Amount to refund" prefix="₹" inputMode="decimal" value={amount} onChange={setAmount} error={amount.trim() ? amountError : undefined} />
        <TextField label="Reason" value={reason} onChange={setReason} placeholder="Required" />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={refund.isPending}>Back</Button>
        <Button variant="danger" onClick={() => refund.mutate()} disabled={Boolean(amountError) || !reason.trim()} loading={refund.isPending}>Refund {amountError ? '' : formatINR(value)}</Button>
      </div>
    </div>
  );
}

function CancelForm({ invoice, onDone, onCancel }: { invoice: InvoiceDto; onDone: (invoice: InvoiceDto) => void; onCancel: () => void }) {
  const api = useApi();
  const [reason, setReason] = useState('');
  const [reopen, setReopen] = useState(false);
  const cancel = useMutation({
    mutationFn: () => api.invoices.cancel(invoice.id, { reason: reason.trim(), reopenOrder: reopen }),
    onSuccess: (updated) => {
      toast.success(reopen ? 'Bill cancelled. The order is open again on the POS.' : 'Bill cancelled');
      onDone(updated);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <div className="space-y-4 rounded-xl border border-line bg-canvas p-4">
      <p className="text-sm font-semibold text-ink-900">Cancel this bill</p>
      <p className="text-sm text-ink-500">The bill and its number stay on record, marked cancelled. The number is not reused.</p>
      <TextField label="Reason" value={reason} onChange={setReason} placeholder="Required" />
      <Checkbox label="Reopen the order so it can be corrected and billed again" checked={reopen} onChange={setReopen} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={cancel.isPending}>Back</Button>
        <Button variant="danger" onClick={() => cancel.mutate()} disabled={!reason.trim()} loading={cancel.isPending}>Cancel bill</Button>
      </div>
    </div>
  );
}

/** Corrects how a payment was made, when the wrong method was picked at the counter. The amount is not touched. */
function MethodForm({ invoice, onDone, onCancel }: { invoice: InvoiceDto; onDone: (invoice: InvoiceDto) => void; onCancel: () => void }) {
  const api = useApi();
  const payments = invoice.payments.filter((p) => p.status === 'SUCCESS');
  const [paymentId, setPaymentId] = useState(payments[0]?.id ?? '');
  const payment = payments.find((p) => p.id === paymentId);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const change = useMutation({
    mutationFn: () => api.invoices.changePaymentMethod(invoice.id, paymentId, { method: method!, reference: method === 'CASH' ? null : reference.trim() || null, reason: reason.trim() }),
    onSuccess: (updated) => {
      toast.success(`Payment changed from ${methodLabel(payment!.method)} to ${methodLabel(method!)}.`);
      onDone(updated);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <div className="space-y-4 rounded-xl border border-line bg-canvas p-4">
      <p className="text-sm font-semibold text-ink-900">Change payment method</p>
      <p className="text-sm text-ink-500">For a payment recorded with the wrong method. The amount and the bill stay as they are; reports count the payment under the new method.</p>
      {payments.length > 1 && (
        <div className="grid gap-2" role="radiogroup" aria-label="Payment to change">
          {payments.map((p) => (
            <button
              key={p.id} type="button" role="radio" aria-checked={p.id === paymentId} onClick={() => { setPaymentId(p.id); setMethod(null); }}
              className={cn('flex h-10 items-center justify-between rounded-lg border bg-surface px-3 text-sm', p.id === paymentId ? 'border-brand-600 ring-1 ring-brand-600' : 'border-line')}
            >
              <span className="font-medium text-ink-900">{methodLabel(p.method)}{p.reference && <span className="font-normal text-ink-500"> · {p.reference}</span>}</span>
              <span className="tabular-nums text-ink-700">{formatINR(p.amountPaise)}</span>
            </button>
          ))}
        </div>
      )}
      {payment && (
        <div>
          <p className="mb-1.5 text-sm font-medium text-ink-700">{formatINR(payment.amountPaise)} was recorded as {methodLabel(payment.method)}. It was really paid by:</p>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="New payment method">
            {METHODS.filter((entry) => entry.id !== payment.method).map((entry) => (
              <button
                key={entry.id} type="button" role="radio" aria-checked={method === entry.id} onClick={() => setMethod(entry.id)}
                className={cn('h-10 rounded-lg border text-sm font-semibold', method === entry.id ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-surface text-ink-700 hover:bg-canvas')}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {method && method !== 'CASH' && <TextField label="Reference (optional)" value={reference} onChange={setReference} placeholder={method === 'UPI' ? 'UPI transaction ID' : 'Last 4 digits or slip no.'} />}
        <TextField label="Reason" value={reason} onChange={setReason} placeholder="Required, and kept in the audit log" />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={change.isPending}>Back</Button>
        <Button onClick={() => change.mutate()} disabled={!method || !reason.trim()} loading={change.isPending}>Change to {method ? methodLabel(method) : '…'}</Button>
      </div>
    </div>
  );
}

function InvoiceDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const api = useApi();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const invoice = useQuery({ queryKey: ['invoice', id], queryFn: () => api.invoices.get(id) });
  const [action, setAction] = useState<'refund' | 'cancel' | 'method' | null>(null);
  const pdf = useMutation({
    mutationFn: () => api.invoices.pdf(id),
    onSuccess: (blob) => window.open(URL.createObjectURL(blob), '_blank', 'noopener'),
    onError: (error) => toast.error(errorMessage(error)),
  });
  const updated = (next: InvoiceDto) => {
    // A refund, a cancellation or a changed payment method also changes Orders, the dashboard and reports.
    void queryClient.invalidateQueries();
    queryClient.setQueryData(['invoice', id], next);
    setAction(null);
  };
  const bill = invoice.data;
  const lines = useSorted(bill?.items, {
    name: (item) => item.name, hsn: (item) => item.hsnSac, quantity: (item) => item.quantity, rate: (item) => item.unitPricePaise,
    taxable: (item) => item.taxablePaise, gst: (item) => item.taxRateBps, amount: (item) => item.totalPaise,
  });
  const net = bill ? bill.paidPaise - bill.refundedPaise : 0;
  const row = (label: string, value: string, strong = false) => (
    <div className={cn('flex justify-between', strong && 'border-t border-line pt-2 text-base font-semibold text-ink-900')}><dt className={strong ? undefined : 'text-ink-500'}>{label}</dt><dd className="tabular-nums">{value}</dd></div>
  );
  return (
    <Dialog
      open onClose={onClose} size="lg" title={bill ? `${bill.docType === 'TAX_INVOICE' ? 'Tax invoice' : 'Bill of supply'} ${bill.invoiceNumber}` : 'Bill'}
      description={bill ? `${formatDateTime(bill.issuedAt)} · ${bill.cashierName} · order ${bill.orderDisplayNumber} · printed ${bill.printCount} time(s)` : undefined}
    >
      {invoice.isPending ? <LoadingState /> : invoice.isError || !bill ? <ErrorState message={errorMessage(invoice.error)} onRetry={() => void invoice.refetch()} /> : (
        <div className="space-y-5 text-sm">
          {bill.status === 'CANCELLED' && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2.5 font-medium text-red-700">Cancelled: {bill.cancelReason}</p>}
          {bill.customer && <p className="text-ink-700">Billed to <span className="font-medium text-ink-900">{customerLabel(bill.customer.phone, bill.customer.name)}</span>{bill.customer.gstin && ` · GSTIN ${bill.customer.gstin}`}</p>}
          <Table>
            <thead>
              <tr>
                <Th sorter={lines.sorter} sortKey="name">Item</Th><Th sorter={lines.sorter} sortKey="hsn">HSN/SAC</Th><Th sorter={lines.sorter} sortKey="quantity" className="text-right">Qty</Th>
                <Th sorter={lines.sorter} sortKey="rate" className="text-right">Rate</Th><Th sorter={lines.sorter} sortKey="taxable" className="text-right">Taxable</Th>
                <Th sorter={lines.sorter} sortKey="gst" className="text-right">GST</Th><Th sorter={lines.sorter} sortKey="amount" className="text-right">Amount</Th>
              </tr>
            </thead>
            <tbody>
              {lines.rows.map((item) => (
                <tr key={item.id}>
                  <Td className="text-ink-900">{item.name}{item.refundedQuantity > 0 && <span className="block text-xs text-amber-700">{item.refundedQuantity} refunded</span>}</Td>
                  <Td>{item.hsnSac ?? '—'}</Td>
                  <Td className="text-right tabular-nums">{item.quantity}</Td>
                  <Td className="text-right tabular-nums">{formatINR(item.unitPricePaise)}</Td>
                  <Td className="text-right tabular-nums">{formatINR(item.taxablePaise)}</Td>
                  <Td className="text-right tabular-nums">{item.taxRateBps / 100}%</Td>
                  <Td className="text-right tabular-nums text-ink-900">{formatINR(item.totalPaise)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <dl className="ml-auto max-w-xs space-y-1">
            {row('Subtotal', formatINR(bill.grossPaise))}
            {bill.discountPaise > 0 && row('Discount', `− ${formatINR(bill.discountPaise)}`)}
            {bill.serviceChargePaise > 0 && row('Service charge', formatINR(bill.serviceChargePaise))}
            {bill.taxes.map((tax) => <div key={`${tax.type}${tax.rateBps}`}>{row(`${tax.type} ${tax.rateBps / 100}% on ${formatINR(tax.taxablePaise)}`, formatINR(tax.amountPaise))}</div>)}
            {bill.roundOffPaise !== 0 && row('Round off', formatINR(bill.roundOffPaise))}
            {row('Total', formatINR(bill.totalPaise), true)}
            {bill.payments.map((payment) => <div key={payment.id}>{row(`Paid by ${methodLabel(payment.method)}${payment.reference ? ` (${payment.reference})` : ''}`, formatINR(payment.amountPaise))}</div>)}
            {bill.refunds.map((refund) => <div key={refund.id} className="text-amber-700">{row(`Refund ${refund.creditNoteNumber} · ${refund.reason}`, `− ${formatINR(refund.amountPaise)}`)}</div>)}
          </dl>
          {action === 'refund' ? <RefundForm invoice={bill} onDone={updated} onCancel={() => setAction(null)} />
            : action === 'cancel' ? <CancelForm invoice={bill} onDone={updated} onCancel={() => setAction(null)} />
            : action === 'method' ? <MethodForm invoice={bill} onDone={updated} onCancel={() => setAction(null)} />
            : (
              <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
                <Button variant="secondary" loading={pdf.isPending} onClick={() => pdf.mutate()}><FileText className="size-4" /> Open PDF</Button>
                {bill.status === 'ISSUED' && bill.payments.some((payment) => payment.status === 'SUCCESS') && can('payment.change_method') && <Button variant="secondary" onClick={() => setAction('method')}>Change payment method</Button>}
                {bill.status === 'ISSUED' && net > 0 && can('refund.create') && <Button variant="secondary" onClick={() => setAction('refund')}>Refund</Button>}
                {bill.status === 'ISSUED' && net === 0 && (can('order.cancel') || can('invoice.cancel_after_settlement')) && <Button variant="secondary" onClick={() => setAction('cancel')}>Cancel bill</Button>}
              </div>
            )}
        </div>
      )}
    </Dialog>
  );
}

export default function InvoicesPage() {
  const api = useApi();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [paymentStatus, setPaymentStatus] = useState<InvoiceSummaryDto['paymentStatus'] | ''>('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<string | null>(null);

  // Sorting is done by the server, across every page of the list, so a new sort starts again from page one.
  const sorter = useSorter(null, () => setPage(1));
  const filters = { from: from || undefined, to: to || undefined, paymentStatus: paymentStatus || undefined, search: search.trim() || undefined, page, pageSize: PAGE_SIZE, sort: sorter.state?.key as InvoiceQuery['sort'], direction: sorter.state?.direction };
  const invoices = useQuery({ queryKey: ['invoices', filters], queryFn: () => api.invoices.list(filters), placeholderData: keepPreviousData });
  const total = invoices.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const control = 'h-10 rounded-lg border border-line bg-surface px-3 text-sm text-ink-700';

  return (
    <>
      <PageHeader title="Bills" description="Invoices issued to customers. A bill is corrected by cancelling it or refunding it with a credit note, which keeps the record. To remove a billed order altogether, delete it under Orders." />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <label className="flex items-center gap-2 text-sm text-ink-500">From <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className={control} /></label>
          <label className="flex items-center gap-2 text-sm text-ink-500">To <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className={control} /></label>
          <select aria-label="Filter by payment" value={paymentStatus} onChange={(e) => { setPaymentStatus(e.target.value as typeof paymentStatus); setPage(1); }} className={control}>
            <option value="">Any payment status</option>
            {Object.entries(PAYMENT).map(([value, { label }]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <input type="search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Bill number or customer" aria-label="Search bills" className={`${control} min-w-56 flex-1`} />
        </div>
        {invoices.isPending ? <LoadingState label="Loading bills" /> : invoices.isError ? <ErrorState message={errorMessage(invoices.error)} onRetry={() => void invoices.refetch()} /> : invoices.data.items.length === 0 ? (
          <EmptyState icon={ReceiptText} title="No bills match" description="Change the dates or filters. Bills are issued on the POS." />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th sorter={sorter} sortKey="bill">Bill</Th><Th sorter={sorter} sortKey="issued">Issued</Th><Th sorter={sorter} sortKey="order">Order</Th>
                  <Th sorter={sorter} sortKey="customer">Customer</Th><Th sorter={sorter} sortKey="cashier">Cashier</Th><Th sorter={sorter} sortKey="total" className="text-right">Total</Th>
                  <Th sorter={sorter} sortKey="paid" className="text-right">Paid</Th><Th sorter={sorter} sortKey="status">Status</Th>
                </tr>
              </thead>
              <tbody>
                {invoices.data.items.map((invoice) => (
                  <tr key={invoice.id} className="hover:bg-canvas/50">
                    <Td><button type="button" onClick={() => setViewing(invoice.id)} className="font-medium text-brand-700 hover:underline">{invoice.invoiceNumber}</button></Td>
                    <Td className="whitespace-nowrap">{formatDateTime(invoice.issuedAt)}</Td>
                    <Td>{invoice.orderDisplayNumber}</Td>
                    <Td className="whitespace-nowrap">{customerLabel(invoice.customerPhone, invoice.customerName) ?? <span className="text-ink-300">—</span>}</Td>
                    <Td>{invoice.cashierName}</Td>
                    <Td className="text-right font-medium tabular-nums text-ink-900">{formatINR(invoice.totalPaise)}</Td>
                    <Td className="text-right tabular-nums">{formatINR(invoice.paidPaise - invoice.refundedPaise)}</Td>
                    <Td><Badge tone={statusOf(invoice).tone}>{statusOf(invoice).label}</Badge></Td>
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
      {viewing && <InvoiceDialog id={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
