'use client';

import { formatINR } from '@pos/billing-core';
import { Badge, Button, cn, customerLabel, Dialog, EmptyState, ErrorState, errorMessage, formatDateTime, inputToPaise, LoadingState, paiseToInput, TextField, toast, type Tone, useApi, useAuth } from '@pos/ui';
import type { ApprovalInput, InvoiceDto, InvoiceSummaryDto, OrderSummaryDto } from '@pos/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Printer, ReceiptText, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { METHOD_LABEL } from '@/lib/api';
import { reportError, useApproval } from '@/lib/approval';
import { offlineSales } from '@/lib/offline-billing';
import { useOutbox } from '@/lib/outbox';
import { usePrintBill } from '@/lib/printing';

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Like every other dialog: focus moves in, Escape closes it, and focus goes back where it was. The billing screen's
  // keyboard shortcuts stand down while a dialog is open, so without Escape a keyboard user would be stuck here.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      // A dialog opened from the drawer (a bill, a reason, a manager's approval) closes first, on its own Escape: it
      // handles the key before this listener and marks it handled, so one press closes one thing.
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      close.current();
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      before?.focus();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-30" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" tabIndex={-1} className="absolute inset-0 bg-ink-900/40" onClick={onClose} />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-surface shadow-2xl">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
          <h2 className="text-base font-semibold text-ink-900">{title}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-2 text-ink-500 hover:bg-canvas"><X className="size-5" /></button>
        </header>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>
  );
}

/** Asks for the reason every cancel, delete and refund must carry. */
function ReasonDialog({ title, description, confirmLabel, extra, onConfirm, onClose }: { title: string; description: string; confirmLabel: string; extra?: ReactNode; onConfirm: (reason: string) => Promise<void>; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open onClose={onClose} size="sm" title={title} description={description}
      footer={
        <>
          <Button variant="secondary" size="touch" onClick={onClose} disabled={busy}>Back</Button>
          <Button
            variant="danger" size="touch" disabled={reason.trim().length === 0} loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(reason.trim());
                onClose();
              } catch (error) {
                reportError(error);
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {extra}
        <TextField label="Reason" value={reason} onChange={setReason} autoFocus placeholder="Required, and kept in the audit log" />
      </div>
    </Dialog>
  );
}

const ORDER_STATUS: Record<string, { label: string; tone: Tone }> = {
  OPEN: { label: 'Open', tone: 'warn' }, HELD: { label: 'On hold', tone: 'neutral' }, BILLED: { label: 'Awaiting payment', tone: 'danger' },
};
const TYPE_LABEL = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' };

interface OrdersDrawerProps {
  currentOrderId: string;
  canMergeInto: boolean;
  onOpen: (order: OrderSummaryDto) => void;
  onPay: (order: OrderSummaryDto) => void;
  onMerge: (order: OrderSummaryDto) => void;
  onRemoved: (orderId: string) => void;
  onClose: () => void;
}

/** Orders in progress at this restaurant: open, on hold, or billed and waiting for payment. */
export function OrdersDrawer({ currentOrderId, canMergeInto, onOpen, onPay, onMerge, onRemoved, onClose }: OrdersDrawerProps) {
  const api = useApi();
  const approve = useApproval();
  const queryClient = useQueryClient();
  const orders = useQuery({ queryKey: ['running-orders'], queryFn: api.orders.running });
  const [acting, setActing] = useState<{ order: OrderSummaryDto; action: 'cancel' | 'delete' | 'cancel-bill' | 'reopen' } | null>(null);

  /**
   * Cancels every bill still standing against a billed order. With `reopen` the order goes back to being edited;
   * without it the order is cancelled too. A manager's PIN, if one is needed, is asked for once and used for each bill.
   */
  async function cancelBills(order: OrderSummaryDto, reason: string, reopen: boolean): Promise<void> {
    let signedOff: ApprovalInput | undefined;
    for (const invoice of order.invoices.filter((entry) => entry.status === 'ISSUED')) {
      await approve((approval) => {
        signedOff = approval ?? signedOff;
        return api.invoices.cancel(invoice.id, { reason, reopenOrder: reopen, approval: signedOff });
      });
    }
    void queryClient.invalidateQueries({ queryKey: ['bills'] });
    refresh();
  }
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['running-orders'] });
    void queryClient.invalidateQueries({ queryKey: ['pos-bootstrap'] });
  };

  return (
    <Drawer title="Running orders" onClose={onClose}>
      {orders.isPending ? (
        <LoadingState />
      ) : orders.isError ? (
        <ErrorState message={errorMessage(orders.error)} onRetry={() => void orders.refetch()} />
      ) : orders.data.length === 0 ? (
        <EmptyState icon={ReceiptText} title="No running orders" description="Held bills and unpaid bills appear here." />
      ) : (
        <ul className="divide-y divide-line">
          {orders.data.map((order) => {
            const status = ORDER_STATUS[order.status] ?? { label: order.status, tone: 'neutral' as Tone };
            const editable = order.status === 'OPEN' || order.status === 'HELD';
            // A billed order can be dropped or changed as long as no money has been taken against its bills.
            const standing = order.invoices.filter((invoice) => invoice.status === 'ISSUED');
            const moneyTaken = standing.some((invoice) => invoice.paidPaise - invoice.refundedPaise > 0);
            const unpaidBill = order.status === 'BILLED' && standing.length > 0 && !moneyTaken;
            return (
              <li key={order.id} className={cn('p-4', order.id === currentOrderId && 'bg-brand-50/60')}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-ink-900">
                      {order.displayNumber} <span className="font-normal text-ink-500">· {order.tableName ? `Table ${order.tableName}` : TYPE_LABEL[order.type]}</span>
                    </p>
                    <p className="mt-0.5 text-sm text-ink-500">
                      {order.itemCount} {order.itemCount === 1 ? 'item' : 'items'} · {order.createdByName}
                      {(order.customerPhone || order.customerName) && ` · ${customerLabel(order.customerPhone, order.customerName)}`}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold tabular-nums text-ink-900">{formatINR(order.totals.totalPaise)}</p>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {editable && order.id !== currentOrderId && <Button size="sm" onClick={() => onOpen(order)}>Open</Button>}
                  {editable && order.id === currentOrderId && <Badge tone="ok">On screen</Badge>}
                  {order.status === 'BILLED' && <Button size="sm" onClick={() => onPay(order)}>Take payment</Button>}
                  {editable && canMergeInto && order.id !== currentOrderId && (
                    <Button size="sm" variant="secondary" onClick={() => onMerge(order)}>Merge into current</Button>
                  )}
                  {editable && <Button size="sm" variant="secondary" onClick={() => setActing({ order, action: 'cancel' })}>Cancel</Button>}
                  {editable && <Button size="sm" variant="secondary" onClick={() => setActing({ order, action: 'delete' })}>Delete</Button>}
                  {unpaidBill && <Button size="sm" variant="secondary" onClick={() => setActing({ order, action: 'reopen' })}>Change order</Button>}
                  {unpaidBill && <Button size="sm" variant="secondary" onClick={() => setActing({ order, action: 'cancel-bill' })}>Cancel bill</Button>}
                </div>
                {order.status === 'BILLED' && moneyTaken && (
                  <p className="mt-2 text-xs text-ink-500">Part of this is already paid. To drop it, refund the payment under Bills first.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {acting?.action === 'cancel' && (
        <ReasonDialog
          title={`Cancel order ${acting.order.displayNumber}`} confirmLabel="Cancel order"
          description="The order stays in the history, marked cancelled with your reason."
          onClose={() => setActing(null)}
          onConfirm={async (reason) => {
            await approve((approval) => api.orders.cancel(acting.order.id, { reason, approval }));
            toast.success(`Order ${acting.order.displayNumber} cancelled`);
            onRemoved(acting.order.id);
            refresh();
          }}
        />
      )}
      {acting?.action === 'cancel-bill' && (
        <ReasonDialog
          title={`Cancel bill for order ${acting.order.displayNumber}`} confirmLabel="Cancel bill"
          description="For a guest who left without paying, or a bill made by mistake. The order is cancelled. The bill stays on record, marked cancelled, and its number is not used again."
          onClose={() => setActing(null)}
          onConfirm={async (reason) => {
            await cancelBills(acting.order, reason, false);
            toast.success(`Order ${acting.order.displayNumber} and its bill are cancelled`);
            onRemoved(acting.order.id);
          }}
        />
      )}
      {acting?.action === 'reopen' && (
        <ReasonDialog
          title={`Change order ${acting.order.displayNumber}`} confirmLabel="Cancel bill and reopen"
          description="The bill is cancelled and the order comes back on screen, so items can be added or removed. Billing it again gives it a new bill number."
          onClose={() => setActing(null)}
          onConfirm={async (reason) => {
            await cancelBills(acting.order, reason, true);
            toast.success(`Order ${acting.order.displayNumber} is open again`);
            onOpen(acting.order);
          }}
        />
      )}
      {acting?.action === 'delete' && (
        <ReasonDialog
          title={`Delete order ${acting.order.displayNumber}`} confirmLabel="Delete order"
          description="The order is removed and later order numbers move up to close the gap. Bill numbers are never changed. Use this only for orders entered by mistake."
          onClose={() => setActing(null)}
          onConfirm={async (reason) => {
            const result = await approve((approval) => api.orders.remove(acting.order.id, { reason, approval }));
            toast.success(result.changes.length > 0 ? `Order deleted. ${result.changes.length} later order(s) renumbered.` : 'Order deleted');
            onRemoved(acting.order.id);
            refresh();
          }}
        />
      )}
    </Drawer>
  );
}

const PAYMENT_STATUS: Record<InvoiceSummaryDto['paymentStatus'], { label: string; tone: Tone }> = {
  UNPAID: { label: 'Unpaid', tone: 'danger' }, PARTIALLY_PAID: { label: 'Part paid', tone: 'warn' }, PAID: { label: 'Paid', tone: 'ok' },
  PARTIALLY_REFUNDED: { label: 'Part refunded', tone: 'warn' }, REFUNDED: { label: 'Refunded', tone: 'neutral' },
};

/** Refund all or part of one payment on a bill. */
function RefundDialog({ invoice, onDone, onClose }: { invoice: InvoiceDto; onDone: (invoice: InvoiceDto) => void; onClose: () => void }) {
  const api = useApi();
  const approve = useApproval();
  const refundable = invoice.payments.filter((payment) => payment.status === 'SUCCESS' && payment.amountPaise > payment.refundedPaise);
  const [paymentId, setPaymentId] = useState(refundable[0]?.id ?? '');
  const payment = refundable.find((candidate) => candidate.id === paymentId);
  const max = payment ? payment.amountPaise - payment.refundedPaise : 0;
  const [amount, setAmount] = useState(paiseToInput(max));
  const value = inputToPaise(amount);
  const [requestId] = useState(() => crypto.randomUUID());

  return (
    <ReasonDialog
      title={`Refund on ${invoice.invoiceNumber}`} confirmLabel="Refund"
      description="The money is returned against the payment you choose, and a credit note is issued. The bill itself is not changed."
      onClose={onClose}
      onConfirm={async (reason) => {
        if (!payment || !Number.isInteger(value) || value <= 0 || value > max) throw new Error(`Enter an amount up to ${formatINR(max)}.`);
        const updated = await approve((approval) => api.invoices.refund(invoice.id, { id: requestId, paymentId: payment.id, amountPaise: value, reason, approval }));
        toast.success(`Refunded ${formatINR(value)}`);
        onDone(updated);
      }}
      extra={
        <>
          <div className="grid gap-2" role="radiogroup" aria-label="Payment to refund">
            {refundable.map((candidate) => (
              <button
                key={candidate.id} type="button" role="radio" aria-checked={candidate.id === paymentId}
                onClick={() => { setPaymentId(candidate.id); setAmount(paiseToInput(candidate.amountPaise - candidate.refundedPaise)); }}
                className={cn('flex h-12 items-center justify-between rounded-xl border px-4 text-sm', candidate.id === paymentId ? 'border-brand-600 bg-brand-50' : 'border-line')}
              >
                <span className="font-medium text-ink-900">{METHOD_LABEL[candidate.method]}</span>
                <span className="tabular-nums text-ink-700">{formatINR(candidate.amountPaise - candidate.refundedPaise)} refundable</span>
              </button>
            ))}
          </div>
          <TextField label="Amount to refund" prefix="₹" inputMode="decimal" value={amount} onChange={setAmount} hint={`Up to ${formatINR(max)}`} />
        </>
      }
    />
  );
}

function BillDetail({ id, onPay, onClose }: { id: string; onPay: (invoice: InvoiceDto) => void; onClose: () => void }) {
  const api = useApi();
  const approve = useApproval();
  const queryClient = useQueryClient();
  const print = usePrintBill();
  const invoice = useQuery({ queryKey: ['invoice', id], queryFn: () => api.invoices.get(id) });
  const [dialog, setDialog] = useState<'refund' | 'cancel' | null>(null);
  const [reopen, setReopen] = useState(false);
  const refresh = (updated: InvoiceDto) => {
    queryClient.setQueryData(['invoice', id], updated);
    void queryClient.invalidateQueries({ queryKey: ['bills'] });
    void queryClient.invalidateQueries({ queryKey: ['running-orders'] });
    void queryClient.invalidateQueries({ queryKey: ['pos-bootstrap'] });
  };
  const pdf = useMutation({
    mutationFn: () => api.invoices.pdf(id),
    onSuccess: (blob) => window.open(URL.createObjectURL(blob), '_blank', 'noopener'),
    onError: reportError,
  });

  const bill = invoice.data;
  const net = bill ? bill.paidPaise - bill.refundedPaise : 0;
  return (
    <Dialog open onClose={onClose} title={bill ? `Bill ${bill.invoiceNumber}` : 'Bill'} description={bill ? `${formatDateTime(bill.issuedAt)} · ${bill.cashierName} · order ${bill.orderDisplayNumber}` : undefined}>
      {invoice.isPending ? (
        <LoadingState />
      ) : invoice.isError || !bill ? (
        <ErrorState message={errorMessage(invoice.error)} onRetry={() => void invoice.refetch()} />
      ) : (
        <div className="space-y-4 text-sm">
          {bill.status === 'CANCELLED' && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2.5 font-medium text-red-700">Cancelled: {bill.cancelReason}</p>}
          <ul className="divide-y divide-line rounded-xl border border-line">
            {bill.items.map((item) => (
              <li key={item.id} className="flex justify-between gap-3 px-3 py-2">
                <span className="text-ink-700">{item.quantity} × {item.name}</span>
                <span className="tabular-nums text-ink-900">{formatINR(item.totalPaise)}</span>
              </li>
            ))}
          </ul>
          <dl className="space-y-1">
            {bill.discountPaise > 0 && <div className="flex justify-between"><dt className="text-ink-500">Discount</dt><dd className="tabular-nums">− {formatINR(bill.discountPaise)}</dd></div>}
            {bill.taxes.map((tax) => (
              <div key={`${tax.type}${tax.rateBps}`} className="flex justify-between"><dt className="text-ink-500">{tax.type} {tax.rateBps / 100}%</dt><dd className="tabular-nums">{formatINR(tax.amountPaise)}</dd></div>
            ))}
            <div className="flex justify-between border-t border-line pt-2 text-base font-semibold text-ink-900"><dt>Total</dt><dd className="tabular-nums">{formatINR(bill.totalPaise)}</dd></div>
            {bill.payments.map((payment) => (
              <div key={payment.id} className="flex justify-between"><dt className="text-ink-500">Paid by {METHOD_LABEL[payment.method]}</dt><dd className="tabular-nums">{formatINR(payment.amountPaise)}</dd></div>
            ))}
            {bill.refunds.map((refund) => (
              <div key={refund.id} className="flex justify-between text-amber-700"><dt>Refund {refund.creditNoteNumber} · {refund.reason}</dt><dd className="tabular-nums">− {formatINR(refund.amountPaise)}</dd></div>
            ))}
          </dl>
          <div className="grid grid-cols-2 gap-2 pt-2">
            <Button variant="secondary" size="touch" onClick={() => print(bill)}><Printer className="size-5" /> {bill.printCount > 0 ? 'Reprint' : 'Print'}</Button>
            <Button variant="secondary" size="touch" loading={pdf.isPending} onClick={() => pdf.mutate()}><FileText className="size-5" /> PDF</Button>
            {bill.status === 'ISSUED' && bill.totalPaise > bill.paidPaise && <Button size="touch" className="col-span-2" onClick={() => onPay(bill)}>Take payment · {formatINR(bill.totalPaise - bill.paidPaise)} due</Button>}
            {bill.status === 'ISSUED' && net > 0 && <Button variant="secondary" size="touch" onClick={() => setDialog('refund')}>Refund</Button>}
            {bill.status === 'ISSUED' && net === 0 && <Button variant="secondary" size="touch" onClick={() => setDialog('cancel')}>Cancel bill</Button>}
          </div>
        </div>
      )}
      {bill && dialog === 'refund' && <RefundDialog invoice={bill} onDone={refresh} onClose={() => setDialog(null)} />}
      {bill && dialog === 'cancel' && (
        <ReasonDialog
          title={`Cancel bill ${bill.invoiceNumber}`} confirmLabel="Cancel bill"
          description="The bill and its number stay on record, marked cancelled. The number is not reused."
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            refresh(await approve((approval) => api.invoices.cancel(bill.id, { reason, reopenOrder: reopen, approval })));
            toast.success(reopen ? 'Bill cancelled. The order is open again under Running orders.' : 'Bill cancelled');
          }}
          extra={
            <label className="flex items-start gap-2.5 text-sm text-ink-700">
              <input type="checkbox" checked={reopen} onChange={(event) => setReopen(event.target.checked)} className="mt-0.5 size-4 accent-brand-600" />
              Reopen the order so it can be corrected and billed again
            </label>
          }
        />
      )}
    </Dialog>
  );
}

/** Bills issued on the current business day, newest first. */
/**
 * Bills this device made offline that the server does not list yet: kept on the device, so they can be printed again
 * and paid. Once uploaded they appear in the list below like any other bill.
 */
function OfflineBills({ businessDate, listed, onPay }: { businessDate: string; listed: Set<string>; onPay: (invoice: InvoiceDto) => void }) {
  const { user } = useAuth();
  const print = usePrintBill();
  const waiting = useOutbox((state) => state.pending);
  const sales = useQuery({ queryKey: ['offline-sales', businessDate, waiting], queryFn: () => offlineSales(user!.restaurantId, businessDate), enabled: Boolean(user) });
  const shown = (sales.data ?? []).filter((invoice) => !listed.has(invoice.id));
  if (shown.length === 0) return null;
  return (
    <section aria-label="Made offline on this device" className="border-b border-line bg-amber-50/40">
      <p className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-amber-800">Made offline on this device</p>
      <ul className="divide-y divide-line">
        {shown.map((invoice) => {
          const due = invoice.totalPaise - invoice.paidPaise;
          return (
            <li key={invoice.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <span>
                <span className="block font-medium text-ink-900">{invoice.invoiceNumber}</span>
                <span className="block text-sm text-ink-500">{formatDateTime(invoice.issuedAt)}{invoice.customer?.phone && ` · ${customerLabel(invoice.customer.phone, invoice.customer.name)}`}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-right">
                  <span className="block font-semibold tabular-nums text-ink-900">{formatINR(invoice.totalPaise)}</span>
                  <Badge tone={due > 0 ? 'danger' : 'ok'}>{due > 0 ? 'Unpaid' : 'Paid'}</Badge>
                </span>
                {due > 0 && <Button variant="secondary" size="sm" onClick={() => onPay(invoice)}>Pay</Button>}
                <Button variant="secondary" size="sm" onClick={() => print(invoice)} aria-label={`Print ${invoice.invoiceNumber}`}><Printer className="size-4" /></Button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function BillsDrawer({ businessDate, onPay, onClose }: { businessDate: string; onPay: (invoice: InvoiceDto) => void; onClose: () => void }) {
  const api = useApi();
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const bills = useQuery({
    queryKey: ['bills', businessDate, search],
    queryFn: () => api.invoices.list({ from: businessDate, to: businessDate, search: search || undefined, pageSize: 100 }),
  });

  return (
    <Drawer title="Today's bills" onClose={onClose}>
      {!search && <OfflineBills businessDate={businessDate} listed={new Set(bills.data?.items.map((bill) => bill.id) ?? [])} onPay={onPay} />}
      <div className="border-b border-line p-3">
        <input
          type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search bill number or customer" aria-label="Search bills"
          className="h-11 w-full rounded-lg border border-line bg-canvas px-3 text-sm placeholder:text-ink-500"
        />
      </div>
      {bills.isPending ? (
        <LoadingState />
      ) : bills.isError ? (
        <ErrorState message={errorMessage(bills.error)} onRetry={() => void bills.refetch()} />
      ) : bills.data.items.length === 0 ? (
        <EmptyState icon={ReceiptText} title={search ? 'No bills match' : 'No bills yet today'} />
      ) : (
        <ul className="divide-y divide-line">
          {bills.data.items.map((bill) => {
            const status = bill.status === 'CANCELLED' ? { label: 'Cancelled', tone: 'neutral' as Tone } : PAYMENT_STATUS[bill.paymentStatus];
            return (
              <li key={bill.id}>
                <button type="button" onClick={() => setOpenId(bill.id)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-canvas">
                  <span>
                    <span className="block font-medium text-ink-900">{bill.invoiceNumber}</span>
                    <span className="block text-sm text-ink-500">{formatDateTime(bill.issuedAt)}{(bill.customerPhone || bill.customerName) && ` · ${customerLabel(bill.customerPhone, bill.customerName)}`}</span>
                  </span>
                  <span className="text-right">
                    <span className="block font-semibold tabular-nums text-ink-900">{formatINR(bill.totalPaise)}</span>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {openId && <BillDetail id={openId} onPay={(invoice) => { setOpenId(null); onPay(invoice); }} onClose={() => setOpenId(null)} />}
    </Drawer>
  );
}
