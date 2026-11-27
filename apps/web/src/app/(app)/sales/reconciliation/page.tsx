'use client';

import { formatINR } from '@pos/billing-core';
import {
  Badge, Button, Card, ConfirmDialog, Dialog, EmptyState, ErrorState, errorMessage, formatDateTime, inputToPaise, LoadingState, PageHeader,
  paiseToInput, Table, Td, TextAreaField, TextField, Th, toast, useApi, useFormState, useSorted,
} from '@pos/ui';
import { type PaymentMethod, type ReconciliationRowDto, reconciliationQuerySchema, saveReconciliationSchema } from '@pos/validation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Scale } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Difference, differenceText } from '@/components/difference';
import { Pager } from '@/components/pager';
import { addDays, formatDay, todayIso } from '@/lib/dates';

const PAYMENTS_PAGE_SIZE = 20;
const METHODS: Record<PaymentMethod, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', OTHER: 'Other' };
/** Where to look for the amount that actually arrived, by payment method. */
const SOURCES: Record<PaymentMethod, string> = {
  CASH: 'The cash banked or kept for this day.',
  UPI: 'What the UPI app or the bank statement shows as received for this day.',
  CARD: 'What the card machine settlement shows for this day.',
  OTHER: 'What actually arrived for this day.',
};
const rowKey = (row: ReconciliationRowDto) => `${row.businessDate}-${row.method}`;
const rowName = (row: ReconciliationRowDto) => `${METHODS[row.method]} on ${formatDay(row.businessDate)}`;

function SettleDialog({ row, onClose, onSaved }: { row: ReconciliationRowDto; onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const form = useFormState({ amount: paiseToInput(row.settledPaise ?? Math.max(row.netPaise, 0)), note: row.note ?? '' });
  const { values, set, errors } = form;
  const settled = inputToPaise(values.amount);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const saved = await form.submit(saveReconciliationSchema, { businessDate: row.businessDate, method: row.method, settledPaise: settled, note: values.note }, (data) =>
      api.reconciliation.save(data),
    );
    if (saved) {
      toast.success(settled === row.netPaise ? `${rowName(row)} matches` : `Saved. ${rowName(row)}: ${differenceText(settled - row.netPaise)}.`);
      onSaved();
    }
  }

  return (
    <Dialog
      open onClose={onClose} size="sm" title={`Settled amount: ${rowName(row)}`} description={SOURCES[row.method]}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>Cancel</Button>
          <Button type="submit" form="settle-form" loading={form.submitting}>Save</Button>
        </>
      }
    >
      <form id="settle-form" onSubmit={onSubmit} noValidate className="space-y-4 text-sm">
        <dl className="space-y-1">
          <div className="flex justify-between"><dt className="text-ink-500">Received in {row.count} {row.count === 1 ? 'payment' : 'payments'}</dt><dd className="tabular-nums">{formatINR(row.receivedPaise)}</dd></div>
          {row.refundedPaise > 0 && <div className="flex justify-between"><dt className="text-ink-500">Refunded</dt><dd className="tabular-nums">− {formatINR(row.refundedPaise)}</dd></div>}
          <div className="flex justify-between border-t border-line pt-2 text-base font-semibold text-ink-900"><dt>Net, as billed</dt><dd className="tabular-nums">{formatINR(row.netPaise)}</dd></div>
        </dl>
        {row.changedSince && (
          <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2.5 text-amber-700">Payments for this day changed after the settled amount was entered. Check the amount again.</p>
        )}
        <TextField label="Settled amount" prefix="₹" inputMode="decimal" value={values.amount} onChange={(v) => set('amount', v)} error={errors.settledPaise} autoFocus />
        {Number.isInteger(settled) && settled >= 0 && (
          <p className="flex justify-between text-ink-700" aria-live="polite"><span>Difference</span><Difference paise={settled - row.netPaise} /></p>
        )}
        <TextAreaField label="Note" value={values.note} onChange={(v) => set('note', v)} error={errors.note} rows={2} maxLength={300} placeholder="Optional, for example bank charges deducted" />
        {row.reconciledByName && <p className="text-xs text-ink-500">Last entered by {row.reconciledByName}{row.reconciledAt && ` on ${formatDateTime(row.reconciledAt)}`}.</p>}
      </form>
    </Dialog>
  );
}

function PaymentsDialog({ row, onClose }: { row: ReconciliationRowDto; onClose: () => void }) {
  const api = useApi();
  const [page, setPage] = useState(1);
  const query = { from: row.businessDate, to: row.businessDate, method: row.method, page, pageSize: PAYMENTS_PAGE_SIZE };
  const payments = useQuery({ queryKey: ['payments', query], queryFn: () => api.reconciliation.payments(query), placeholderData: keepPreviousData });
  return (
    <Dialog open onClose={onClose} size="lg" title={`Payments: ${rowName(row)}`} description={`${row.count} ${row.count === 1 ? 'payment' : 'payments'}, ${formatINR(row.receivedPaise)} received`}>
      {payments.isPending ? <LoadingState label="Loading payments" /> : payments.isError ? <ErrorState message={errorMessage(payments.error)} onRetry={() => void payments.refetch()} /> : payments.data.items.length === 0 ? (
        <EmptyState title="No payments" description="No payments were taken by this method on this day." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line text-sm">
          <Table>
            <thead>
              <tr>
                <Th>Bill</Th><Th>Time</Th><Th className="text-right">Amount</Th><Th className="text-right">Refunded</Th><Th>Reference</Th><Th>Received by</Th><Th>Cash register</Th>
              </tr>
            </thead>
            <tbody>
              {payments.data.items.map((payment) => (
                <tr key={payment.id}>
                  <Td className="whitespace-nowrap font-medium text-ink-900">{payment.invoiceNumber}</Td>
                  <Td className="whitespace-nowrap">{payment.paidAt ? formatDateTime(payment.paidAt) : <span className="text-ink-300">—</span>}</Td>
                  <Td className="text-right tabular-nums text-ink-900">{formatINR(payment.amountPaise)}</Td>
                  <Td className="text-right tabular-nums">{payment.refundedPaise > 0 ? formatINR(payment.refundedPaise) : <span className="text-ink-300">—</span>}</Td>
                  <Td>{payment.reference ?? <span className="text-ink-300">—</span>}</Td>
                  <Td>{payment.receivedByName}</Td>
                  <Td>{payment.inRegister ? 'In a register' : <span className="text-ink-500">Outside a register</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pager page={page} pageSize={PAYMENTS_PAGE_SIZE} total={payments.data.total} onChange={setPage} />
        </div>
      )}
    </Dialog>
  );
}

function Status({ row }: { row: ReconciliationRowDto }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {row.settledPaise === null || row.differencePaise === null ? <Badge tone="neutral">Not checked</Badge>
        : row.differencePaise === 0 ? <Badge tone="ok">Matches</Badge>
        : <Badge tone={row.differencePaise < 0 ? 'danger' : 'warn'}>{differenceText(row.differencePaise)}</Badge>}
      {row.changedSince && <Badge tone="warn">Changed since checked</Badge>}
    </div>
  );
}

export default function ReconciliationPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(() => addDays(todayIso(), -6));
  const [to, setTo] = useState(todayIso);
  const [settling, setSettling] = useState<ReconciliationRowDto | null>(null);
  const [clearing, setClearing] = useState<ReconciliationRowDto | null>(null);
  const [listing, setListing] = useState<ReconciliationRowDto | null>(null);

  // The same rules the server applies, so a wrong period is explained here instead of being sent.
  const period = reconciliationQuerySchema.safeParse({ from, to });
  const periodError = period.success ? null : !from || !to ? 'Choose a start date and an end date.' : period.error.issues[0]?.message ?? 'Choose a valid period.';
  const summary = useQuery({
    queryKey: ['reconciliation', from, to], queryFn: () => api.reconciliation.summary({ from, to }), enabled: period.success, placeholderData: keepPreviousData,
  });
  const sorted = useSorted(summary.data?.rows, {
    date: (row) => row.businessDate, method: (row) => METHODS[row.method], count: (row) => row.count, received: (row) => row.receivedPaise,
    refunded: (row) => row.refundedPaise, net: (row) => row.netPaise, settled: (row) => row.settledPaise, difference: (row) => row.differencePaise,
    // Not checked first, then short, over and matching.
    status: (row) => (row.differencePaise === null ? 0 : row.differencePaise < 0 ? 1 : row.differencePaise > 0 ? 2 : 3),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['reconciliation'] });

  const clear = useMutation({
    mutationFn: (row: ReconciliationRowDto) => api.reconciliation.clear(row.businessDate, row.method),
    onSuccess: (_result, row) => {
      toast.success(`Settled amount removed for ${rowName(row)}`);
      setClearing(null);
      void refresh();
    },
    onError: (error) => {
      setClearing(null);
      toast.error(errorMessage(error));
    },
  });

  const control = 'h-10 rounded-lg border border-line bg-surface px-3 text-sm text-ink-700';
  const cash = summary.data?.cash;
  const none = <span className="text-ink-300">—</span>;

  return (
    <>
      <PageHeader
        title="Reconciliation"
        description="Check each day's payments against the money that actually arrived. The settled amount is what your bank statement, card machine or UPI app shows as received for that day."
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <label className="flex items-center gap-2 text-sm text-ink-500">From <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={control} /></label>
          <label className="flex items-center gap-2 text-sm text-ink-500">To <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={control} /></label>
        </div>
        {periodError ? (
          <p role="alert" className="px-6 py-14 text-center text-sm text-danger">{periodError}</p>
        ) : summary.isPending ? <LoadingState label="Loading payments" /> : summary.isError ? <ErrorState message={errorMessage(summary.error)} onRetry={() => void summary.refetch()} /> : (
          <>
            {cash && (
              <section aria-label="Cash for these dates" className="border-b border-line">
                <dl className="grid grid-cols-2 gap-px bg-line lg:grid-cols-4">
                  <div className="bg-surface px-5 py-4">
                    <dt className="text-sm text-ink-500">Cash taken in registers</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums text-ink-900">{formatINR(cash.inRegistersPaise)}</dd>
                  </div>
                  <div className="bg-surface px-5 py-4">
                    <dt className="text-sm text-ink-500">Cash taken outside a register</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums text-ink-900">{formatINR(cash.outsideRegistersPaise)}</dd>
                  </div>
                  <div className="bg-surface px-5 py-4">
                    <dt className="text-sm text-ink-500">Register difference</dt>
                    <dd className="mt-1 text-lg"><Difference paise={cash.registerVariancePaise} className="font-semibold" /></dd>
                  </div>
                  <div className="bg-surface px-5 py-4">
                    <dt className="text-sm text-ink-500">Registers</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums text-ink-900">
                      {cash.registersClosed} closed{cash.registersOpen > 0 && <span className="text-amber-700">, {cash.registersOpen} still open</span>}
                    </dd>
                  </div>
                </dl>
              </section>
            )}
            {summary.data.rows.length === 0 ? (
              <EmptyState icon={Scale} title="No payments in these dates" description="Change the dates. Payments appear here once bills are paid on the POS." />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th sorter={sorted.sorter} sortKey="date">Date</Th><Th sorter={sorted.sorter} sortKey="method">Method</Th>
                    <Th sorter={sorted.sorter} sortKey="count" className="text-right">Payments</Th><Th sorter={sorted.sorter} sortKey="received" className="text-right">Received</Th>
                    <Th sorter={sorted.sorter} sortKey="refunded" className="text-right">Refunded</Th><Th sorter={sorted.sorter} sortKey="net" className="text-right">Net</Th>
                    <Th sorter={sorted.sorter} sortKey="settled" className="text-right">Settled</Th><Th sorter={sorted.sorter} sortKey="difference" className="text-right">Difference</Th>
                    <Th sorter={sorted.sorter} sortKey="status">Status</Th><Th className="w-0"><span className="sr-only">Actions</span></Th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.rows.map((row) => (
                    <tr key={rowKey(row)} className="hover:bg-canvas/50">
                      <Td className="whitespace-nowrap text-ink-900">{formatDay(row.businessDate)}</Td>
                      <Td>{METHODS[row.method]}</Td>
                      <Td className="text-right tabular-nums">
                        {row.count === 0 ? 0 : (
                          <button type="button" aria-label={`Show the ${row.count} ${row.count === 1 ? 'payment' : 'payments'} for ${rowName(row)}`} onClick={() => setListing(row)} className="font-medium text-brand-700 hover:underline">{row.count}</button>
                        )}
                      </Td>
                      <Td className="text-right tabular-nums">{formatINR(row.receivedPaise)}</Td>
                      <Td className="text-right tabular-nums">{row.refundedPaise > 0 ? formatINR(row.refundedPaise) : none}</Td>
                      <Td className="text-right font-medium tabular-nums text-ink-900">{formatINR(row.netPaise)}</Td>
                      <Td className="text-right tabular-nums" title={row.note ?? undefined}>
                        {row.settledPaise === null ? none : formatINR(row.settledPaise)}
                        {row.note && <span className="block max-w-40 truncate text-xs text-ink-500">{row.note}</span>}
                      </Td>
                      <Td className="text-right">{row.differencePaise === null ? none : <Difference paise={row.differencePaise} />}</Td>
                      <Td><Status row={row} /></Td>
                      <Td>
                        <div className="flex justify-end gap-2">
                          <Button variant="secondary" size="sm" className="whitespace-nowrap" aria-label={`${row.settledPaise === null ? 'Enter settled amount' : 'Edit settled amount'} for ${rowName(row)}`} onClick={() => setSettling(row)}>
                            {row.settledPaise === null ? 'Enter settled amount' : 'Edit'}
                          </Button>
                          {row.settledPaise !== null && (
                            <Button variant="ghost" size="sm" aria-label={`Clear settled amount for ${rowName(row)}`} onClick={() => setClearing(row)}>Clear</Button>
                          )}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        )}
      </Card>

      {settling && <SettleDialog row={settling} onClose={() => setSettling(null)} onSaved={() => { setSettling(null); void refresh(); }} />}
      {listing && <PaymentsDialog row={listing} onClose={() => setListing(null)} />}
      <ConfirmDialog
        open={clearing !== null} onClose={() => setClearing(null)} onConfirm={() => clearing && clear.mutate(clearing)}
        title="Clear settled amount" confirmLabel="Clear" danger loading={clear.isPending}
        message={clearing && <>Remove the settled amount of <strong>{clearing.settledPaise === null ? '' : formatINR(clearing.settledPaise)}</strong> entered for {rowName(clearing)}? The day goes back to “Not checked”.</>}
      />
    </>
  );
}
